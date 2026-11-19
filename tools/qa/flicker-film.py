"""Show the measured adjacent frames from two still-camera WebGPU captures."""
import argparse
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def series(directory):
    frames = sorted(directory.glob('*-frame-*.png'))
    if len(frames) < 4:
        raise ValueError(f'Expected a sample cycle in {directory}')
    # Use the same two-frame warmup as flicker.py.
    return frames[2:]


def render(before, after, target):
    old, new = series(before), series(after)
    if len(old) != len(new):
        raise ValueError('Sample counts differ')
    width, height = 720, 368
    font = ImageFont.truetype('DejaVuSans.ttf', 15)
    heading = ImageFont.truetype('DejaVuSans-Bold.ttf', 17)
    encoder = subprocess.Popen([
        'ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}', '-pix_fmt', 'rgb24', '-framerate', '12', '-i', '-',
        '-an', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', '-movflags',
        '+faststart', str(target)], stdin=subprocess.PIPE)
    try:
        for _ in range(5):
            for a, b in zip(old, new):
                frame = Image.new('RGB', (width, height), (20, 24, 22))
                draw = ImageDraw.Draw(frame)
                draw.text((13, 7), 'Previous build', font=heading, fill='#edf0e9')
                draw.text((373, 7), 'Updated build', font=heading, fill='#edf0e9')
                for x, path in [(0, a), (360, b)]:
                    with Image.open(path) as shot:
                        frame.paste(shot.convert('RGB').resize((360, 300), Image.Resampling.BILINEAR), (x, 34))
                draw.text((13, 341), f'Stationary camera  /  Wind off  /  {len(old)} captured samples on repeat',
                          font=font, fill='#d8ddd8')
                encoder.stdin.write(frame.tobytes())
    finally:
        encoder.stdin.close()
    if encoder.wait():
        raise RuntimeError('Video encoding failed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('before', 'after', 'output'):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    render(args.before, args.after, args.output)
