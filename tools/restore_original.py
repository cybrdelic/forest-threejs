#!/usr/bin/env python3
"""Lossless geometry/instance recovery from the first forest GLB.

This intentionally does not invoke prepare_scene.prepare(): that function replaces
ferns and deforms trees. A restoration must first preserve the accepted assets.
Only native renderer materials are generated, using the recovered texture code.
"""
from __future__ import annotations
import argparse, hashlib, json, struct, sys, time
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from prepare_scene import GLB, transform, texture_pack

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', type=Path, default=ROOT/'assets/input/CYBR_FOREST.glb')
    ap.add_argument('--out', type=Path, default=ROOT/'assets')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    g=GLB(args.input); meshes=[]; report=[]
    for i, m in enumerate(g.j['meshes']):
        attrs=m['primitives'][0]['attributes']
        # This exporter shares vertex buffers between material primitives.
        if any(p['attributes']!=attrs for p in m['primitives']):
            raise ValueError('Independent material vertex streams not supported by this input converter')
        p=g.accessor(attrs['POSITION']);n=g.accessor(attrs['NORMAL'])
        uv=g.accessor(attrs['TEXCOORD_0']);color=g.accessor(attrs['COLOR_0'])
        v=np.column_stack([p,n,uv,color]).astype('<f4')
        faces=[]
        for primitive in m['primitives']:
            ids=g.accessor(primitive['indices']).reshape(-1,3)
            faces.append(np.column_stack([ids,np.full(len(ids),primitive['material'])]))
        f=np.vstack(faces).astype('<u4')
        if not np.isfinite(v).all() or f[:,:3].max()>=len(v):
            raise ValueError('Invalid geometry')
        # Exact float32 equality is a hard preservation gate.
        assert np.array_equal(v[:,:3],p)
        assert np.array_equal(v[:,3:6],n)
        meshes.append((m['name'],v,f))
        report.append({'name':m['name'],'vertices':len(v),'triangles':len(f),
                       'position_sha256':sha(v[:,:3].tobytes()),'positions_unchanged':True,
                       'normals_unchanged':True})
    instances=[];cameras=[]
    # Traverse the scene hierarchy rather than assuming all nodes are roots.
    visited=set()
    def visit(i,parent):
        if i in visited: raise ValueError('Repeated scene node')
        visited.add(i);node=g.j['nodes'][i];M=parent@transform(node)
        if 'mesh' in node: instances.append((node['mesh'],M))
        if 'camera' in node:
            c=g.j['cameras'][node['camera']]
            cameras.append({'name':c['name'],'eye':M[:3,3].tolist(),
                            'target':(M[:3,3]-12*M[:3,2]).tolist(),
                            'up':M[:3,1].tolist(),'fov':np.degrees(c['perspective']['yfov'])})
        for j in node.get('children',[]):visit(j,M)
    for i in g.j['scenes'][g.j.get('scene',0)]['nodes']:visit(i,np.eye(4))
    dst=args.out/'forest.cys';tmp=dst.with_suffix('.tmp')
    with tmp.open('wb') as f:
        f.write(struct.pack('<4sIIII',b'CYS2',2,len(meshes),len(instances),len(cameras)))
        for name,v,faces in meshes:
            name=name.encode();f.write(struct.pack('<III',len(name),len(v),len(faces)))
            f.write(name);f.write(v.tobytes());f.write(faces.tobytes())
        for mid,M in instances:
            f.write(struct.pack('<I',mid));f.write(np.asarray(M[:3,:],dtype='<f4').tobytes())
            f.write(np.asarray(np.linalg.inv(M)[:3,:],dtype='<f4').tobytes());f.write(struct.pack('<3f',1,1,1))
        for c in cameras:
            name=c['name'].encode();f.write(struct.pack('<I',len(name)));f.write(name)
            f.write(struct.pack('<10f',*c['eye'],*c['target'],*c['up'],c['fov']))
    tmp.replace(dst)
    material_report=texture_pack(args.out)
    result={'schema':'cybr-forest-restoration-v1','source_glb_sha256':sha(g.bytes),
            'scene_sha256':sha(dst.read_bytes()),'meshes':report,'instances':len(instances),
            'unique_triangles':sum(len(m[2]) for m in meshes),
            'instance_expanded_triangles':sum(len(meshes[mid][2]) for mid,M in instances),
            'geometry_modified':False,'image_generation_used':False,
            'original_renderer_source':'CYBR_FOREST_NATIVE_FILM_Source.zip',
            'materials':material_report,'cameras':cameras}
    (args.out/'restoration.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k not in ['meshes','cameras','materials']},indent=2),flush=True)
if __name__=='__main__':main()
