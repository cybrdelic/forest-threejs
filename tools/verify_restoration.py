#!/usr/bin/env python3
"""Compare every native scene buffer and transform with the original GLB."""
from __future__ import annotations
import hashlib,json,struct,sys
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from prepare_scene import GLB,transform

def verify(root:Path=ROOT)->dict:
    g=GLB(root/'assets/input/CYBR_FOREST.glb');source=root/'assets/forest.cys'
    def read(f,fmt):
        size=struct.calcsize(fmt);b=f.read(size)
        if len(b)!=size:raise ValueError('Truncated native scene')
        return struct.unpack(fmt,b)
    checked=[]
    with source.open('rb') as f:
        magic,version,nm,ni,nc=read(f,'<4sIIII')
        if magic!=b'CYS2' or version!=2 or nm!=len(g.j['meshes']):raise ValueError('Header mismatch')
        for m in g.j['meshes']:
            ns,nv,nf=read(f,'<III');name=f.read(ns).decode()
            v=np.frombuffer(f.read(nv*44),dtype='<f4').reshape(nv,11)
            faces=np.frombuffer(f.read(nf*16),dtype='<u4').reshape(nf,4)
            attr=m['primitives'][0]['attributes']
            expected=np.column_stack([g.accessor(attr[k]) for k in ('POSITION','NORMAL','TEXCOORD_0','COLOR_0')]).astype('<f4')
            original_faces=np.vstack([np.column_stack([g.accessor(p['indices']).reshape(-1,3),np.full(g.accessor(p['indices']).size//3,p['material'])]) for p in m['primitives']]).astype('<u4')
            if name!=m['name'] or not np.array_equal(v,expected) or not np.array_equal(faces,original_faces):raise ValueError('Mesh changed: '+name)
            checked.append({'mesh':name,'all_vertex_attributes_identical':True,'indices_and_materials_identical':True})
        inst=[];cameras=[]
        def visit(i,parent):
            n=g.j['nodes'][i];M=parent@transform(n)
            if 'mesh'in n:inst.append((n['mesh'],M))
            if 'camera'in n:cameras.append((n['camera'],M))
            for child in n.get('children',[]):visit(child,M)
        for i in g.j['scenes'][g.j.get('scene',0)]['nodes']:visit(i,np.eye(4))
        if ni!=len(inst) or nc!=len(cameras):raise ValueError('Instance/camera count mismatch')
        for mid,M in inst:
            (actual_mid,)=read(f,'<I');actual=np.frombuffer(f.read(48),dtype='<f4').reshape(3,4)
            inv=np.frombuffer(f.read(48),dtype='<f4').reshape(3,4);tint=read(f,'<3f')
            if actual_mid!=mid or not np.array_equal(actual,M[:3].astype('<f4')) or not np.array_equal(inv,np.linalg.inv(M)[:3].astype('<f4')) or tint!=(1,1,1):raise ValueError('Instance transform mismatch')
        for ci,M in cameras:
            (ns,)=read(f,'<I');name=f.read(ns).decode();values=np.asarray(read(f,'<10f'));c=g.j['cameras'][ci]
            expected=np.asarray([*M[:3,3],*(M[:3,3]-12*M[:3,2]),*M[:3,1],np.degrees(c['perspective']['yfov'])],dtype='<f4')
            if name!=c['name'] or not np.array_equal(values,expected):raise ValueError('Camera mismatch')
        if f.read(1):raise ValueError('Trailing scene bytes')
    result={'passed':True,'source_glb_sha256':hashlib.sha256(g.bytes).hexdigest(),'native_scene_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'mesh_count':nm,'instance_count':ni,'cameras_preserved':nc,'exact_vertex_and_face_streams_preserved':checked,'all_instance_transforms_identical_float32':True,'invented_geometry':False}
    (root/'logs').mkdir(exist_ok=True);(root/'logs/preservation.json').write_text(json.dumps(result,indent=2))
    return result
if __name__=='__main__':
    r=verify();print(f"PASS: {r['mesh_count']} buffers, {r['instance_count']} transforms, {r['cameras_preserved']} cameras preserved.")
