"""Replace the old leaf crop with complete photographic RGBA leaf atlases.

Usage: python tools/pack-leaf-materials.py --leaf-directory /path/to/512-textures
The first three existing material layers are retained byte for byte.
"""
from argparse import ArgumentParser
from pathlib import Path
import numpy as np
from PIL import Image

parser = ArgumentParser()
parser.add_argument('--leaf-directory', type=Path, required=True)
parser.add_argument('--site-directory', type=Path, default=Path(__file__).resolve().parents[1])
args = parser.parse_args()

def linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)

def srgb(value):
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * np.maximum(value, 0) ** (1 / 2.4) - 0.055)

def resize_float(array, size):
    return np.asarray(Image.fromarray(array.astype(np.float32), mode='F').resize((size, size), Image.Resampling.BOX))

assets = args.site_directory / 'dist' / 'assets'
for kind in ['albedo', 'normal']:
    destination = assets / (kind + '.bin')
    old = destination.read_bytes()
    # Accept repeated runs against either the former four or current five layers.
    pixels_per_layer = sum(max(1, 512 >> level) ** 2 * 4 for level in range(10))
    old_layers = len(old) // pixels_per_layer
    assert old_layers in [4, 5, 9]
    leaves = []
    for species in ['oak', 'jacaranda']:
        suffix = 'albedo-alpha' if kind == 'albedo' else 'normal'
        image = np.asarray(Image.open(args.leaf_directory / f'{species}-{suffix}-512.png').convert('RGBA'), dtype=np.float32) / 255
        if kind == 'normal':
            alpha = Image.open(args.leaf_directory / f'{species}-albedo-alpha-512.png').convert('RGBA').getchannel('A')
            image[:, :, 3] = np.asarray(alpha, dtype=np.float32) / 255
        leaves.append(image)
    output = bytearray()
    offset = 0
    for level in range(10):
        side = max(1, 512 >> level)
        layer_bytes = side * side * 4
        output.extend(old[offset:offset + layer_bytes * 3])
        tail=old[offset+layer_bytes*5:offset+layer_bytes*old_layers] if old_layers>5 else b''
        offset += layer_bytes * old_layers
        for leaf in leaves:
            if kind == 'albedo':
                coverage = resize_float(leaf[:, :, 3], side)
                rgb = linear(leaf[:, :, :3])
                weighted = np.stack([resize_float(rgb[:, :, channel] * leaf[:, :, 3], side) for channel in range(3)], axis=2)
                rgb = weighted / np.maximum(coverage[:, :, None], 1e-6)
                # Keep each isolated source shoot's projected opaque area as
                # its thin photographed leaflets cross pixel boundaries.
                calibrated = coverage.copy()
                tile = max(1, side // 4)
                if 0 < level < 7:
                    for row in range(4):
                        for column in range(4):
                            ref = leaf[row*128:(row+1)*128, column*128:(column+1)*128, 3]
                            fraction = (ref >= 0.5).mean()
                            region = calibrated[row*tile:(row+1)*tile, column*tile:(column+1)*tile]
                            if fraction > 0:
                                quantile = np.quantile(region, 1.0-fraction)
                                region *= np.clip(0.501 / max(0.03,quantile),0.8,3.0)
                filtered = np.dstack([srgb(rgb*coverage[:, :, None]), np.clip(calibrated,0,1)])
            else:
                vector = leaf[:, :, :3] * 2 - 1
                vector = np.stack([resize_float(vector[:, :, channel] * leaf[:, :, 3], side) for channel in range(3)], axis=2)
                vector /= np.maximum(np.linalg.norm(vector, axis=2, keepdims=True), 1e-6)
                # The normal texture carries unbiased area fractions. The albedo
                # alpha above remains calibrated for the binary shadow reader.
                filtered = np.dstack([vector * 0.5 + 0.5, resize_float(leaf[:, :, 3], side)])
            output.extend(np.round(np.clip(filtered, 0, 1) * 255).astype(np.uint8).tobytes())
        output.extend(tail)
    assert len(output) == pixels_per_layer * max(5,old_layers)
    destination.write_bytes(output)
    print(kind, len(output), 'bytes, preserved material layers, ten mip levels')
