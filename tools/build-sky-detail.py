"""Reconstruct the source's 8K cloud luminance around the 2K HDR color panorama.

Usage: python tools/build-sky-detail.py /path/to/kloofendal_48d_partly_cloudy_puresky_8k.hdr
"""
import argparse
import hashlib
import re
import struct
import zlib
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

SOURCE_MD5 = "28091ec4839b564f57f780c316d6e9fd"
# One code = 1/48 stop. Distant sky texture uses a trilinear R8 gain map.
CODES_PER_STOP = 48
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def read_upper_luminance(path):
    data = path.read_bytes()
    if hashlib.md5(data).hexdigest() != SOURCE_MD5:
        raise ValueError("Expected the official 8K Kloofendal 48d Partly Cloudy Pure Sky HDR.")
    header = re.search(rb"\n-Y (\d+) \+X (\d+)\n", data)
    height, width = map(int, header.groups())
    offset = header.end()
    scan = np.empty((width, 4), np.uint8)
    luminance = np.empty((height // 2, width), np.float32)
    signature = bytes([2, 2, width >> 8, width & 255])
    for y in range(height // 2):
        if data[offset:offset + 4] != signature:
            raise ValueError("Unsupported Radiance HDR scanline.")
        offset += 4
        for channel in range(4):
            x = 0
            while x < width:
                length = data[offset]
                offset += 1
                if length > 128:
                    length -= 128
                    scan[x:x + length, channel] = data[offset]
                    offset += 1
                else:
                    scan[x:x + length, channel] = np.frombuffer(data, "u1", count=length, offset=offset)
                    offset += length
                x += length
        luminance[y] = (scan[:, :3] @ LUMA) * np.exp2(scan[:, 3].astype("f4") - 136)
        luminance[y, scan[:, 3] == 0] = 0
    return luminance


def base_luminance(path):
    packed = np.fromfile(path, "<u4").reshape(1024, 2048)
    luminance = np.zeros(packed.shape, "f4")
    for channel, (offset, nbits) in enumerate([(0, 6), (11, 6), (22, 5)]):
        bits = (packed >> offset) & ((1 << (nbits + 5)) - 1)
        exponent = (bits >> nbits).astype("i2")
        mantissa = (bits & ((1 << nbits) - 1)) / float(1 << nbits)
        radiance = np.ldexp(mantissa + (exponent != 0), np.maximum(exponent - 15, -14))
        luminance += radiance * LUMA[channel]
    return luminance


def build(source_luma, base):
    height, width = source_luma.shape
    x = (np.arange(width) + .5) / width * base.shape[1] - .5
    y = (np.arange(height) + .5) / (height * 2) * base.shape[0] - .5
    gain = np.empty(source_luma.shape, "f4")
    for start in range(0, height, 64):
        end = min(start + 64, height)
        coords = np.broadcast_arrays(y[start:end, None].clip(0, base.shape[0] - 1), x[None, :])
        # Match GPU filtered equirectangular samples. Latitude is clamped, longitude periodic.
        denominator = map_coordinates(base, coords, order=1, mode="grid-wrap")
        gain[start:end] = source_luma[start:end] / np.maximum(denominator, 1e-9)
    levels = []
    while True:
        codes = np.rint(128 + CODES_PER_STOP * np.log2(np.maximum(gain, 1e-7))).clip(0, 255).astype("u1")
        payload = zlib.compress(codes.tobytes(), 5)
        levels.append((gain.shape[1], gain.shape[0], payload))
        if gain.shape == (1, 1):
            break
        # Integrate linear gain over a pixel rather than averaging encoded stops.
        if gain.shape[0] > 1:
            gain = (gain[::2] + gain[1::2]) * .5
        if gain.shape[1] > 1:
            gain = (gain[:, ::2] + gain[:, 1::2]) * .5
    return levels


def write_asset(levels, destination):
    offsets = [8 + 16 * len(levels)]
    with destination.open("wb") as f:
        f.write(b"SKYG")
        f.write(struct.pack("<HH", 1, len(levels)))
        for width, height, payload in levels:
            f.write(struct.pack("<4I", width, height, offsets[-1], len(payload)))
            offsets.append(offsets[-1] + len(payload))
        for _, _, payload in levels:
            f.write(payload)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    options = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "dist" / "assets"
    levels = build(read_upper_luminance(options.source), base_luminance(assets / "environment.bin"))
    write_asset(levels, assets / "sky-detail.bin")
    print("Packed", len(levels), "levels,", sum(len(p) for _, _, p in levels), "compressed bytes")
