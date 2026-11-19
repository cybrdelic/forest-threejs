import json,pathlib,numpy as np
from PIL import Image
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--asset-root',type=pathlib.Path,required=True);args=parser.parse_args()
r=args.asset_root/'grass_medium_01';g=json.loads((r/'grass_medium_01.gltf').read_text());blob=(r/'grass_medium_01.bin').read_bytes();im=np.asarray(Image.open(r/'Diffuse.png'))
def read(i):
 a=g['accessors'][i];b=g['bufferViews'][a['bufferView']];dt={5126:np.float32,5125:np.uint32,5123:np.uint16}[a['componentType']];w={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']];return np.frombuffer(blob,dt,count=a['count']*w,offset=b.get('byteOffset',0)+a.get('byteOffset',0)).reshape(-1,w)
rg=np.random.default_rng(20261117)
areas={}
for j,m in enumerate(g['meshes']):
 q=m['primitives'][0];p=read(q['attributes']['POSITION']);uv=read(q['attributes']['TEXCOORD_0']);f=read(q['indices']).reshape(-1,3);tri=p[f];a=np.linalg.norm(np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]),axis=1)*.5;ids=rg.choice(len(f),size=100000,p=a/a.sum());b=rg.dirichlet([1,1,1],len(ids));u=(uv[f[ids]]*b[:,:,None]).sum(1);alpha=im[(np.mod(u[:,1],1)*1023).astype(int),(np.mod(u[:,0],1)*1023).astype(int),3]/255;area=a.sum()*alpha.mean();areas[j]=area;print(j,g['nodes'][j]['name'],'tris',len(f),'opaquearea',area)
(args.asset_root/'source-areas.json').write_text(json.dumps(areas,indent=2))
