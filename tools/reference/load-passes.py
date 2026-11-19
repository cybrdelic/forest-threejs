"""Convert scene-linear Cycles group/interaction passes for the crop metrics.
blender -b -t 1 -P tools/reference/load-passes.py -- output-directory
"""
import bpy,numpy as np,sys
from pathlib import Path
root=Path(sys.argv[-1])
for directory in sorted(root.glob('passes-*')):
    data={}
    for p in sorted(directory.glob('*0001.exr')):
        image=bpy.data.images.load(str(p));pixels=np.empty(image.size[0]*image.size[1]*4,dtype='f');image.pixels.foreach_get(pixels)
        data[p.name[:-8]]=pixels.reshape(image.size[1],image.size[0],4)[::-1,:,:3].copy();bpy.data.images.remove(image)
    np.savez(directory.with_suffix('.npz'),**data)
