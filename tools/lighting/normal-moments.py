"""Pack foliage normal mips as covered first moments with preserved area alpha.
Run after packing opaque layers and foliage with their original source maps.
A flat +Z normal fills the uncovered fraction, so trilinear and anisotropic
filtering conserve both covered area and the signed, coverage-weighted moment.
"""
from pathlib import Path
import argparse,hashlib,json
import numpy as np
from PIL import Image
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets',type=Path,default=Path(__file__).resolve().parents[2]/'dist/assets')
args=parser.parse_args();target=args.assets/'normal.bin';metadata=args.assets/'foliage-normal-moments.json'
before=target.read_bytes();sha=lambda data:hashlib.sha256(data).hexdigest()
if metadata.exists() and json.loads(metadata.read_text())['sha256']==sha(before):
    print('Current normal moments already match this material.');raise SystemExit
raw=np.frombuffer(before,dtype='u1').copy();base=raw[:9*512*512*4].reshape(9,512,512,4).copy()
stats={};positive=np.array([0,0,1],dtype='f')
for layer in range(3,9):
    source=base[layer].astype('f')/255
    names=['oak','jacaranda','bermuda','grass','celandine','dandelion']
    folder=args.assets.parents[1]/'assets-source/leaves' if layer<5 else args.assets/'meadow'
    normal=np.asarray(Image.open(folder/(names[layer-3]+'-normal-512.png')).convert('RGB'),dtype='f')/127.5-1
    normal/=np.maximum(np.linalg.norm(normal,axis=2,keepdims=True),1e-6)
    alpha=source[:,:,3:4]
    moment=alpha*normal+(1-alpha)*positive
    offset=0
    for level in range(10):
        size=512>>level;part=raw[offset:offset+9*size*size*4].reshape(9,size,size,4)
        part[layer,:,:,:3]=np.rint(np.clip(moment*.5+.5,0,1)*255).astype('u1')
        offset+=9*size*size*4
        if size>1:moment=moment.reshape(size//2,2,size//2,2,3).mean(axis=(1,3))
    stats[str(layer)]=round(float(np.linalg.norm((normal*alpha).sum(axis=(0,1))/alpha.sum())),5)
packed=raw.tobytes();target.write_bytes(packed)
metadata.write_text(json.dumps({'sha256':sha(packed),'layout':'coverage-weighted XYZ first moment with flat +Z in uncovered area, unbiased fractional area in alpha','layers':stats,'reproduce':'python tools/lighting/normal-moments.py'},indent=2)+'\n')
