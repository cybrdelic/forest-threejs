from pathlib import Path
import numpy as np,json
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--asset-root',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
root=args.asset_root;src=root/'grass_medium_01';g=json.loads((src/'grass_medium_01.gltf').read_text());blob=(src/'grass_medium_01.bin').read_bytes();areas=json.loads((root/'source-areas.json').read_text())
def read(i):
 a=g['accessors'][i];b=g['bufferViews'][a['bufferView']];dt={5126:np.float32,5125:np.uint32,5123:np.uint16}[a['componentType']];w={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']];return np.frombuffer(blob,dt,count=a['count']*w,offset=b.get('byteOffset',0)+a.get('byteOffset',0)).reshape(-1,w)
choices=np.arange(11);weights=np.array([10,8,8,10,10,10,10,8,6,6,4],float);weights/=weights.sum()
for name,seed in [('bermuda',7198),('grass',17391)]:
 rg=np.random.default_rng(seed);verts=[];faces=[];offset=0;placements=[];opaqueArea=0
 for z in range(8):
  for x in range(8):
   mi=int(rg.choice(choices,p=weights));q=g['meshes'][mi]['primitives'][0];p=read(q['attributes']['POSITION']).copy();n=read(q['attributes']['NORMAL']).copy();uv=read(q['attributes']['TEXCOORD_0']);f=read(q['indices']).ravel().astype(np.uint32);p[:,1]-=p[:,1].min();yaw=rg.uniform(0,np.pi*2);cx=-.215+x*.43/7+rg.uniform(-.018,.018);cz=-.215+z*.43/7+rg.uniform(-.018,.018);cs=np.cos(yaw);sn=np.sin(yaw);px=p[:,0].copy();pz=p[:,2].copy();nx=n[:,0].copy();nz=n[:,2].copy();p[:,0]=px*cs+pz*sn+cx;p[:,2]=-px*sn+pz*cs+cz;n[:,0]=nx*cs+nz*sn;n[:,2]=-nx*sn+nz*cs;v=np.column_stack([p,n,uv,np.full(len(p),2)]).astype(np.float32);verts.append(v);faces.append(f+offset);offset+=len(v);opaqueArea+=areas[str(mi)];placements.append({'sourceMesh':mi,'positionXZ':[cx,cz],'yaw':yaw})
 v=np.concatenate(verts);f=np.concatenate(faces);out=args.output/name;out.mkdir(parents=True,exist_ok=True);v.tofile(out/'vertices.bin');f.tofile(out/'indices.bin');metadata={'name':name,'bounds':[[-.3,0,-.3],[.3,.38,.3]],'source_url':'https://polyhaven.com/a/grass_medium_01','source':'64 complete native-scale authored Grass Medium01 specimens with original photographic UV+RGBA albedo. No synthetic blades or background photographs.','native_source_triangles':len(f)//3,'sourcePlantCount':64,'unclippedOpaqueLeafAreaSquareMetres':opaqueArea,'unclippedLeafAreaIndex':opaqueArea/.36,'placements':placements,'primitives':[{'material':2,'indexFirst':0,'indexCount':len(f),'diffuse_texture':str(src/'Diffuse.png'),'alpha_cutoff':.45}]};(out/'metadata.json').write_text(json.dumps(metadata,indent=2));print(name,'plants64','tris',len(f)//3,'unclippedLAI',opaqueArea/.36)
