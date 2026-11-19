"""Merge native scissored corrections with a region proven unchanged.

Expects a full-frame validation render for the first matched pose. Fails if
the reconstruction differs by even one color byte from that complete frame.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import numpy as np
from PIL import Image

parser=argparse.ArgumentParser(description=__doc__)
for name in ['prior','scissored','validation','bounds','output']:
    parser.add_argument('--'+name,type=Path,required=True)
args=parser.parse_args()

def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
old=read(args.prior/'result-meadow.json')
new=read(args.scissored/'result-meadow.json')
bound=read(args.bounds)
rect=new['savedScissor']
x,y,w,h=rect
assert x==0 and w==new['width'] and y<=bound['rowRange'][0] and y+h>=bound['rowRange'][1]
assert old['errors']==new['errors']==[]
assert old['frames']==new['frames'] and old['settings']==new['settings']
assert old['fetchedAssets']==new['fetchedAssets'] and old['samples']==new['samples']==4
assert len(new['frames'])==len(bound['frames'])
canon=runpy.run_path(str(Path(__file__).with_name('gles-parity.py')))['canonical']
before=canon(read(args.prior/'commands.json')['commands'])
after=canon(read(args.scissored/'commands.json')['commands'])
assert len(before)==len(after)
changed_shaders=[]
for a,b in zip(before,after):
    if a==b:continue
    assert a['name']==b['name']=='shaderSource' and a['args'][0]==b['args'][0]
    assert 'surfaceDirectFiltered(' in b['args'][1]
    changed_shaders.append(hashlib.sha256(b['args'][1].encode()).hexdigest())
assert changed_shaders
args.output.mkdir(parents=True,exist_ok=True)
for frame in new['frames']:
    file='frame-%04d.png'%frame['index']
    base=Image.open(args.prior/file).convert('RGBA')
    part=Image.open(args.scissored/file).convert('RGBA')
    assert part.size==(w,h) and base.size==(old['width'],old['height'])
    base.paste(part,(x,y))
    if frame['index']==0:
        validation=np.asarray(Image.open(args.validation/file).convert('RGBA'))
        assert np.array_equal(np.asarray(base),validation)
        original=np.asarray(Image.open(args.prior/file).convert('RGBA'))
        changed=np.any(validation!=original,axis=2)
        yy,xx=np.where(changed)
        assert changed.any() and not changed[:y].any() and not changed[y+h:].any()
        check={'totalPixels':base.width*base.height,'changedPixels':int(changed.sum()),
               'changedBounds':[int(xx.min()),int(yy.min()),int(xx.max()),int(yy.max())],
               'reconstructedVersusFullFrameDifferentPixels':0,'correctedFullPNG':sha(args.validation/file)}
    base.save(args.output/file,compress_level=1)
metadata={'method':'All backlight poses were rerendered with the complete corrected GLES draw stream. A full-resolution scissor limited color/depth writes to the conservative outer-canopy band; shadows, viewport and projections were preserved. Unchanged rows come from the original matching native frame. The first reconstructed frame was checked byte-for-byte against an independent full corrected 1080p render.',
          'scissor':rect,'geometryBounds':bound,'fullFrameCheck':check,'changedShaderSources':changed_shaders,
          'priorCaptureSourceSHA256':old['sourceHashes'],'correctedCaptureSourceSHA256':new['sourceHashes']}
(args.output/'correction.json').write_text(json.dumps(metadata,indent=2)+'\n')
new['savedScissor']=None
new['reconstruction']=metadata['method']
(args.output/'result-meadow.json').write_text(json.dumps(new,indent=2)+'\n')
print(check)
