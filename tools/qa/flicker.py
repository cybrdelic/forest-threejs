"""Measure rendered temporal instability on a fixed camera or a pure camera pan.

Use webgpu.mjs with TEST_PROGRESS_PNG=1, TEST_WIND=0 and TEST_DELTA_TIME=0.
For the pan add TEST_PAN_STEP_DEGREES=0.08. The benchmark keeps simulation
time stationary while the renderer advances its ordinary frame/sample index.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def camera_basis(forward):
    forward = np.asarray(forward)
    forward = forward / np.linalg.norm(forward)
    right = np.cross(forward, [0., 1., 0.])
    right /= np.linalg.norm(right)
    return np.stack((right, np.cross(right, forward), forward))


def sample(image, rays, basis, focal):
    height, width = image.shape
    camera_rays = rays @ basis.T
    x = width / 2 - 0.5 + focal * camera_rays[..., 0] / camera_rays[..., 2]
    y = height / 2 - 0.5 - focal * camera_rays[..., 1] / camera_rays[..., 2]
    valid = (x >= 0) & (x < width - 1) & (y >= 0) & (y < height - 1)
    x, y = np.clip(x, 0, width - 1.001), np.clip(y, 0, height - 1.001)
    left, top = x.astype(int), y.astype(int)
    x_frac, y_frac = x - left, y - top
    upper = image[top, left] * (1 - x_frac) + image[top, left + 1] * x_frac
    lower = image[top + 1, left] * (1 - x_frac) + image[top + 1, left + 1] * x_frac
    return upper * (1 - y_frac) + lower * y_frac, valid


def summarize(samples):
    values = np.concatenate(samples)
    return {
        'samples': int(values.size), 'meanAbsoluteDifference': float(values.mean()),
        'p95': float(np.percentile(values, 95)), 'p99': float(np.percentile(values, 99)),
        'fractionAbove8': float((values > 8).mean()),
        'fractionAbove16': float((values > 16).mean())
    }


def measure(directory, warmup, frames_requested=None):
    files = sorted(directory.glob('*-frame-*.png'))
    metadata_path, = directory.glob('*-meadow.json')
    metadata = json.loads(metadata_path.read_text())
    assert not metadata['errors'] and len(files) == metadata['frameCount']
    if frames_requested is not None:
        assert frames_requested <= len(files)
        files = files[:frames_requested]
    assert len(files)>warmup+1
    assert metadata['wind'] == 0 and metadata['deltaTime'] == 0
    assert not metadata.get('motion'), 'Translation is unsupported by the rotation-only comparison'
    assert warmup >= 0
    frames = [np.asarray(Image.open(file).convert('RGB')) @ [0.2126, 0.7152, 0.0722] for file in files]
    height, width = frames[0].shape
    y, x = np.mgrid[:height, :width]
    region_masks = {
        'whole': np.ones((height, width), dtype=bool),
        'lowerHalf': y >= height / 2,
        'foreground': y >= height * 0.86
    }
    regions = {k: [] for k in region_masks}
    sharpness = []
    pan = bool(metadata.get('panStepRadians'))
    for i in range(warmup, len(frames) - 1):
        first, second = frames[i:i+2]
        valid = region_masks['whole']
        if pan:
            a, b = metadata['frameCameras'][i:i+2]
            assert np.max(np.abs(np.asarray(a['position']) - b['position'])) < 1e-5
            assert abs(a['verticalFov'] - b['verticalFov']) < 1e-6
            f = .5 * height / np.tan(.5 * a['verticalFov'])
            mid = camera_basis(np.asarray(a['forward']) + b['forward'])
            rays = np.stack(((x+.5-width/2)/f, -(y+.5-height/2)/f, np.ones_like(x)), axis=-1) @ mid
            first, valid_a = sample(first, rays, camera_basis(a['forward']), f)
            second, valid_b = sample(second, rays, camera_basis(b['forward']), f)
            valid = valid_a & valid_b
        delta = np.abs(first - second)
        for key, mask in region_masks.items():
            regions[key].append(delta[mask & valid])
        sharpness.append(float(np.abs(np.diff(frames[i][height//2:],axis=1)).mean()))
    return {
        'resolution': [width, height], 'frames': len(frames), 'recordedFrames': metadata['frameCount'], 'warmupFrames': warmup,
        'pairCount': len(frames) - 1 - warmup, 'wind': metadata['wind'],
        'sceneTimeSeconds': 1.0, 'treeCount': metadata['density'], 'quality': metadata['quality'],
        'panDegreesPerFrame': float(np.degrees(metadata.get('panStepRadians', 0.))),
        'meanHorizontalLumaGradientLowerHalf': float(np.mean(sharpness)),
        'regions': {key: summarize(samples) for key, samples in regions.items()},
        'errors': metadata['errors']
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path, nargs='?')
    parser.add_argument('--warmup', type=int, default=2)
    args = parser.parse_args()
    frames = None
    if args.after:
        # Compare an identical prefix when independent captures have different lengths.
        frames = min(len(list(path.glob('*-frame-*.png'))) for path in [args.before,args.after])
    result = {'before': measure(args.before, args.warmup, frames)}
    if args.after:
        result['after'] = measure(args.after, args.warmup, frames)
        for key in ('resolution','frames','panDegreesPerFrame','treeCount','quality'):
            assert result['before'][key] == result['after'][key], 'Different comparison settings: ' + key
    print(json.dumps(result, indent=2))
