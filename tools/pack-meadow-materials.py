"""Append/rebuild the four photographic meadow layers while retaining tree/ground maps."""
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'dist' / 'assets'
names = ['bermuda', 'grass', 'celandine', 'dandelion']
unit = sum(max(1, 512 >> level) ** 2 * 4 for level in range(10))

def resize(array, side):
    return np.asarray(Image.fromarray(array.astype(np.float32), 'F').resize((side, side), Image.Resampling.BOX))

def preserve_coverage(alpha, original, tiles):
    side = alpha.shape[0]
    if side < tiles:
        tiles = 1
    step, source_step = side // tiles, original.shape[0] // tiles
    result = alpha.copy()
    for y in range(tiles):
        for x in range(tiles):
            sample = result[y*step:(y+1)*step, x*step:(x+1)*step]
            source = original[y*source_step:(y+1)*source_step, x*source_step:(x+1)*source_step]
            target = float((source >= 0.5).mean())
            if target <= 0 or not np.any(sample > 0):
                continue
            # Preserve cutout coverage per depth slice, including thin stems.
            threshold = np.quantile(sample, max(0, 1-target))
            sample *= min(8, 0.501 / max(0.001, threshold))
    return np.clip(result, 0, 1)

albedos = [np.asarray(Image.open(root/'meadow'/f'{name}-albedo-alpha-512.png').convert('RGBA'), dtype=np.float32)/255 for name in names]
normals = [np.asarray(Image.open(root/'meadow'/f'{name}-normal-512.png').convert('RGBA'), dtype=np.float32)/255 for name in names]
for kind in ['albedo', 'normal']:
    destination = root / (kind+'.bin')
    old = destination.read_bytes()
    old_layers = len(old) // unit
    assert old_layers in [5, 9]
    output, offset = bytearray(), 0
    for level in range(10):
        side = max(1, 512 >> level)
        size = side*side*4
        output.extend(old[offset:offset+size*5])
        offset += size*old_layers
        for index, (albedo, normal) in enumerate(zip(albedos, normals)):
            alpha = albedo[:,:,3]
            weight = resize(alpha, side)
            if kind == 'albedo':
                rgb = albedo[:,:,:3]
                rgb = np.where(rgb<=0.04045, rgb/12.92, ((rgb+0.055)/1.055)**2.4)
                rgb = np.stack([resize(rgb[:,:,channel]*alpha, side) for channel in range(3)], axis=2)/np.maximum(weight[:,:,None], 1e-6)
                rgb *= weight[:,:,None]
                rgb = np.where(rgb<=0.0031308, rgb*12.92, 1.055*np.maximum(rgb, 0)**(1/2.4)-0.055)
                coverage = weight if level == 0 else preserve_coverage(weight, alpha, 4 if index < 2 else 1)
                filtered = np.dstack([rgb, coverage])
            else:
                vector = normal[:,:,:3]*2-1
                vector = np.stack([resize(vector[:,:,channel]*alpha, side) for channel in range(3)], axis=2)/np.maximum(weight[:,:,None], 1e-6)
                vector /= np.maximum(np.linalg.norm(vector, axis=2, keepdims=True), 1e-6)
                filtered = np.dstack([vector*0.5+0.5, weight])
            output.extend(np.round(np.clip(filtered, 0, 1)*255).astype(np.uint8).tobytes())
    assert len(output) == unit*9
    destination.write_bytes(output)
    print(kind, len(output), 'bytes, 9 layers')
