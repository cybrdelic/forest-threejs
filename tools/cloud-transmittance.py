"""Estimate direct-beam cloud transmittance from the Kloofendal HDR upper hemisphere."""
import argparse
from pathlib import Path
import re

import numpy as np
from scipy.ndimage import gaussian_filter

def read_rgbe(path):
    data = path.read_bytes()
    header = re.search(rb"\n-Y (\d+) \+X (\d+)\n", data)
    if not header:
        raise ValueError("Expected a latitude-longitude Radiance RGBE file")
    height, width = map(int, header.groups())
    cursor = header.end()
    # Only upward directions can cast a cloud shadow.
    rgbe = np.empty((height // 2, width, 4), dtype=np.uint8)
    for scan in rgbe:
        if data[cursor:cursor + 4] != bytes((2, 2, width >> 8, width & 255)):
            raise ValueError("Expected an RLE scanline")
        cursor += 4
        for channel in range(4):
            pos = 0
            while pos < width:
                length = data[cursor]
                cursor += 1
                if length > 128:
                    length -= 128
                    scan[pos:pos + length, channel] = data[cursor]
                    cursor += 1
                elif length:
                    scan[pos:pos + length, channel] = np.frombuffer(data, np.uint8, length, cursor)
                    cursor += length
                else:
                    raise ValueError("Invalid RGBE packet")
                pos += length
    rgb = rgbe[..., :3] * np.exp2(rgbe[..., 3, None].astype(np.float32) - 136)
    return rgb

def build(source, output):
    image = read_rgbe(source)
    h,w = image.shape[:2]
    # Area filter sky radiance before extracting the lower-resolution shadow field.
    rgb = image.reshape(128, h//128, 512, w//512, 3).mean(axis=(1,3))
    red, green, blue = rgb.transpose(2,0,1)
    chroma = red / np.maximum(blue, 1e-5)
    # Reconstruct the blue-sky envelope separately at each elevation. At the
    # horizon even clear air is pale. Using a global white threshold darkens it.
    baseline = gaussian_filter(np.percentile(chroma, 12, axis=1), 2.2)[:,None]
    cloud = np.clip((chroma - baseline - 0.06) / np.maximum(0.24, 0.83-baseline), 0, 1)
    opacity = cloud*cloud*(3-2*cloud)
    # A clear solar disk/haze is also white; don't mistake the source for a cloud.
    y,x = np.indices(opacity.shape)
    theta=(y+.5)*np.pi/(2*128)
    azimuth=((x+.5)/512-.5)*2*np.pi
    dot=.554562*np.sin(theta)*np.cos(azimuth)+.741980*np.cos(theta)+.376731*np.sin(theta)*np.sin(azimuth)
    solar_angle=np.degrees(np.arccos(np.clip(dot,-1,1)))
    opacity *= np.clip((solar_angle-4)/8,0,1)
    # A small angular penumbra; stable under oblique sampling at ground level.
    transmission = gaussian_filter(1-.86*opacity, sigma=(1.18,1.35), mode=('nearest','wrap'))
    output.write_bytes(np.uint8(np.clip(transmission*255+.5,0,255)).tobytes())

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'dist/assets/cloud-transmittance.bin')
    args=parser.parse_args()
    build(args.source,args.output)
