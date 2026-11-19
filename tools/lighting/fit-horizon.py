"""Fit low-frequency directional airlight to the deployed sky panorama."""
from pathlib import Path

import numpy as np


def measure(source):
    packed = np.fromfile(source, '<u4').reshape(1024, 2048)
    # Take a band 3–8 degrees above the horizon to avoid the filled lower hemisphere.
    band = packed[int(1024 * (0.5 - 8 / 180)):int(1024 * (0.5 - 3 / 180))]
    rgb = []
    for shift, mantissa_bits in [(0, 6), (11, 6), (22, 5)]:
        bits = (band >> shift) & ((1 << (mantissa_bits + 5)) - 1)
        exponent = (bits >> mantissa_bits).astype(np.int16)
        fraction = (bits & ((1 << mantissa_bits) - 1)) / (1 << mantissa_bits)
        rgb.append(np.ldexp(fraction + (exponent > 0), np.maximum(-14, exponent - 15)))
    rgb = np.stack(rgb, axis=-1)
    angles = np.arange(36) * 2 * np.pi / 36
    directions = []
    for angle in angles:
        middle = round((angle / (2 * np.pi) + 0.5) * 2048)
        samples = rgb[:, np.arange(middle - 28, middle + 29) % 2048].reshape(-1, 3)
        # Exclude the whitest clouds and the darkest outliers in each sector.
        chroma = samples[:, 0] / np.maximum(0.0001, samples[:, 2])
        lower, upper = np.quantile(chroma, [0.08, 0.42])
        directions.append(np.median(samples[(chroma >= lower) & (chroma <= upper)], axis=0))
    basis = np.array([np.ones_like(angles), np.cos(angles), np.sin(angles),
                      np.cos(2 * angles), np.sin(2 * angles)]).T
    return np.linalg.lstsq(basis, directions, rcond=None)[0]


if __name__ == '__main__':
    path = Path(__file__).resolve().parents[2] / 'dist/assets/environment.bin'
    for row in measure(path):
        print(', '.join(f'{component:.6f}' for component in row))
