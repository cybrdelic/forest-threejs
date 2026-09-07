#!/usr/bin/env python3
"""Build a reproducible path-tracing scene from the actual CYBR VEG forest GLB.

No generated-image input, stock imagery, neural reconstruction or remote asset is
used. Coordinates stay in the source GLB's metre / Y-up coordinate system.
Binary layout is documented in FORMAT.md and consumed by the C++ executable.
"""
from __future__ import annotations
import argparse, hashlib, json, math, struct, time
from pathlib import Path
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates
from PIL import Image

DTYPES = {5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1',5122:'<i2',5120:'i1'}
SIZES = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def normalize(x):
    x=np.asarray(x,dtype=np.float64)
    return x/np.maximum(np.linalg.norm(x,axis=-1,keepdims=True),1e-20)

def value_noise(shape, cells, rng):
    """Periodic, smooth value noise, deterministic for a given Generator."""
    h,w=shape; gy,gx=cells
    grid=rng.random((gy,gx))
    yy,xx=np.meshgrid(np.arange(h)*gy/h,np.arange(w)*gx/w,indexing='ij')
    return map_coordinates(grid,[yy,xx],order=3,mode='grid-wrap',prefilter=True)

def texture_pack(root:Path):
    rng=np.random.default_rng(23071997);n=1024;shape=(n,n)
    yy,xx=np.mgrid[0:n,0:n].astype(np.float64)/n
    noise=lambda a,b:value_noise(shape,(a,b),rng)
    fine=noise(120,120);micro=noise(390,390)
    warp=noise(11,17)*.72+noise(37,41)*.15
    # Irregular elongated cells form broken plates, not painted vertical bands.
    X=xx*29+warp;Y=yy*8+noise(8,26)*.62
    ix=np.floor(X).astype(int);iy=np.floor(Y).astype(int)
    f1=np.full(shape,1e9);f2=np.full(shape,1e9)
    for oy in range(-1,2):
        for ox in range(-1,2):
            a=ix+ox;b=iy+oy
            hx=np.mod(np.sin(a*127.1+b*311.7)*43758.5453,1)
            hy=np.mod(np.sin(a*269.5+b*183.3)*43758.5453,1)
            d=((a+.18+.64*hx-X)*1.15)**2+((b+.1+.8*hy-Y)*.65)**2
            swap=d<f1; f2=np.where(swap,f1,np.minimum(f2,d));f1=np.minimum(f1,d)
    gap=np.sqrt(f2)-np.sqrt(f1)
    ridges=np.clip(gap/.18,0,1)**.32
    horizontal=np.clip((noise(75,8)-.63)*5,0,1)
    height=np.clip(ridges*.63+fine*.20+micro*.10-horizontal*.16,0,1)
    fissure=np.clip(gap/.075,0,1)
    coarse=noise(8,10)
    base=np.array([.205,.167,.123])[None,None,:]*(.35+.85*fissure[...,None])
    base*=((.73+.55*coarse)*(.84+.3*fine))[...,None]
    lichen=np.clip((noise(32,35)+.20*noise(140,120)-.83)*8,0,.72)
    base=base*(1-lichen[...,None])+np.array([.31,.335,.23])*lichen[...,None]
    moss=np.clip((noise(9,15)+.25*fine-.87)*8,0,.8)
    base=base*(1-moss[...,None])+np.array([.075,.092,.022])*moss[...,None]
    rough=.78+.19*(1-fissure)
    def save(name,rgb,he,rough,physical,amp):
        du=(np.roll(he,-1,1)-np.roll(he,1,1))*n/(2*physical[0])*amp
        dv=(np.roll(he,-1,0)-np.roll(he,1,0))*n/(2*physical[1])*amp
        arr=np.concatenate([rgb,du[...,None],dv[...,None],np.broadcast_to(rough,shape)[...,None],he[...,None]],axis=-1).astype('<f4')
        with open(root/f'{name}.tex','wb') as f:
            f.write(struct.pack('<4sIII','CTX1'.encode(),n,n,7));f.write(arr.tobytes())
        srgb=np.where(rgb<=.0031308,rgb*12.92,1.055*np.maximum(rgb,0)**(1/2.4)-.055)
        Image.fromarray(np.uint8(np.clip(srgb,0,1)*255)).save(root/f'{name}_albedo.png')
    save('bark',base,height,rough,(1.65,3.5),.013)
    # Soil colour is an albedo; shadows and illumination are never baked here.
    broad=noise(10,10);med=noise(52,52);fine=noise(175,175);micro=noise(460,460)
    soil=np.array([.105,.073,.04])*(.6+.8*med[...,None])
    grains=np.clip((fine-.63)*4,0,1)
    soil=soil*(1-.35*grains[...,None])+np.array([.17,.15,.105])*.35*grains[...,None]
    mo=np.clip((broad+.32*med-.88)*5,0,.85)
    soil=soil*(1-mo[...,None])+np.array([.055,.075,.016])*mo[...,None]
    he=.42*med+.29*fine+.15*micro+.14*broad
    save('soil',soil,he,.91-.1*med,(3.0,3.0),.028)
    return {'resolution':[n,n],'channels':['linear R','linear G','linear B','dH/du','dH/dv','roughness','height'],'images':'procedurally computed from seeded noise and cellular distance fields'}

class GLB:
    def __init__(self,path):
        self.bytes=path.read_bytes()
        magic,version,total=struct.unpack_from('<4sII',self.bytes)
        if magic!=b'glTF' or version!=2 or total!=len(self.bytes): raise ValueError('Invalid GLB v2 header')
        size,kind=struct.unpack_from('<II',self.bytes,12)
        if kind!=0x4e4f534a: raise ValueError('Missing JSON chunk')
        self.j=json.loads(self.bytes[20:20+size]); offset=20+size
        length,kind=struct.unpack_from('<II',self.bytes,offset)
        if kind!=0x004e4942:raise ValueError('Missing BIN chunk')
        self.binary=memoryview(self.bytes)[offset+8:offset+8+length]
    def accessor(self,i):
        a=self.j['accessors'][i];b=self.j['bufferViews'][a['bufferView']]
        dt=np.dtype(DTYPES[a['componentType']]);d=SIZES[a['type']]
        ar=np.ndarray((a['count'],d),dtype=dt,buffer=self.binary,offset=b.get('byteOffset',0)+a.get('byteOffset',0),strides=(b.get('byteStride',dt.itemsize*d),dt.itemsize)).copy()
        if a.get('normalized') and dt.kind in 'iu':ar=ar.astype(np.float32)/np.iinfo(dt).max
        return ar

class Mesh:
    def __init__(self,name,vertices,faces):
        self.name=name; self.v=np.asarray(vertices,dtype='<f4').reshape(-1,11);self.f=np.asarray(faces,dtype='<u4').reshape(-1,4)

class Builder:
    def __init__(self,name):self.name=name;self.v=[];self.f=[]
    def vertex(self,p,n,uv,c):self.v.append([*p,*n,*uv,*c]);return len(self.v)-1
    def triangle(self,a,b,c,mat):self.f.append([a,b,c,mat])
    def tube(self,points,radii,material=1,color=(.2,.16,.1),sides=7):
        points=np.asarray(points);begin=len(self.v);t=0.
        for i,p in enumerate(points):
            if i:t+=np.linalg.norm(p-points[i-1])
            tangent=normalize(points[min(i+1,len(points)-1)]-points[max(0,i-1)])
            reference=np.array([0.,1.,0.]) if abs(tangent[1])<.9 else np.array([1.,0.,0.])
            u=normalize(np.cross(tangent,reference));v=np.cross(tangent,u)
            for k in range(sides+1):
                angle=k*2*math.pi/sides;n=u*math.cos(angle)+v*math.sin(angle)
                self.vertex(p+radii[i]*n,n,(k/sides*2*math.pi*radii[i],t),color)
        for i in range(len(points)-1):
            for k in range(sides):
                a=begin+i*(sides+1)+k;b=a+sides+1
                self.triangle(a,b,a+1,material);self.triangle(a+1,b,b+1,material)
    def leaf(self,base,axis,side,length,width,color,material=3,segments=5,curl=.035,serrate=.08):
        base=np.asarray(base);axis=normalize(axis);side=normalize(side);normal=normalize(np.cross(side,axis))
        if normal[1]<0:normal=-normal
        start=len(self.v)
        for i in range(segments+1):
            t=i/segments;profile=max(.008,math.sin(math.pi*t)**.8)*(1+serrate*(-1 if i%2 else 1))
            center=base+axis*length*t+normal*curl*math.sin(math.pi*t)
            for j in range(3):
                s=j-1;p=center+side*width*profile*s*.5-normal*abs(s)*width*.11*profile
                nn=normalize(normal+side*(s*.25)+axis*(-curl/length*math.pi*math.cos(math.pi*t)))
                self.vertex(p,nn,((s+1)*.5,t),color)
        for i in range(segments):
            for k in range(2):
                a=start+i*3+k;b=a+3
                self.triangle(a,b,a+1,material);self.triangle(a+1,b,b+1,material)
    def finish(self):return Mesh(self.name,self.v,self.f)

def fern(seed):
    rng=np.random.default_rng(seed);b=Builder(f'fern_lacy_{seed}')
    for fr in range(7+(seed%2)):
        angle=fr*2.399963+rng.normal(0,.14)
        direction=np.array([math.cos(angle),0,math.sin(angle)]);side=np.array([-math.sin(angle),0,math.cos(angle)])
        L=rng.uniform(.8,1.35)
        def p(t):return direction*(L*.87*t)+np.array([0,L*(.95*t-.61*t*t)+.02,0])
        ts=np.linspace(0,1,20)
        b.tube([p(t) for t in ts],[.004*(1-t)+.0007 for t in ts],color=(.105,.13,.029),sides=5)
        for k in range(3,20):
            t=k/21.;frond_width=.19*L*math.sin(math.pi*t)**.85
            for sign in [-1,1]:
                outward=normalize(side*sign+direction*.35+np.array([0,.04,0]));origin=p(t)
                b.tube([origin,origin+outward*frond_width],[.0015,.0003],color=(.07,.12,.022),sides=4)
                n=7
                for q in range(n):
                    f=(q+.6)/n;bl=.035*L*(1-f*.7)*math.sin(math.pi*t)**.4
                    for s in [-1,1]:
                        leafaxis=normalize(outward*.56+direction*(s*.75)+np.array([0,.11,0]))
                        leafside=normalize(np.cross([0,1,0],leafaxis))
                        col=np.array([.077,.17,.026])*rng.uniform(.75,1.28)
                        b.leaf(origin+outward*frond_width*f,leafaxis,leafside,bl,bl*.43,col,segments=3,curl=.003,serrate=.20)
                b.leaf(origin+outward*frond_width*.93,outward,direction,.026,.01,(.08,.18,.025),segments=3,curl=.002)
    return b.finish()

def transform(node):
    if 'matrix' in node:return np.array(node['matrix']).reshape(4,4).T
    x,y,z,w=node.get('rotation',[0,0,0,1]);s=np.array(node.get('scale',[1,1,1]))
    R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)], [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)], [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    M=np.eye(4);M[:3,:3]=R*s;M[:3,3]=node.get('translation',[0,0,0]);return M

def prepare(glb:Path,out:Path):
    started=time.time();out.mkdir(parents=True,exist_ok=True);g=GLB(glb);rng=np.random.default_rng(61147)
    meshes=[]
    for i,m in enumerate(g.j['meshes']):
        attr=m['primitives'][0]['attributes'];v=np.column_stack([g.accessor(attr[x]) for x in ['POSITION','NORMAL','TEXCOORD_0','COLOR_0']]);faces=[]
        for prim in m['primitives']:
            ids=g.accessor(prim['indices']).reshape(-1,3)
            faces.append(np.column_stack([ids,np.full(len(ids),prim['material'])]))
        meshes.append(Mesh(m['name'],v,np.vstack(faces)))
    terrain=meshes[24].v[:,:3];xs=np.unique(terrain[:,0]);zs=np.unique(terrain[:,2]);H=terrain[:,1].reshape(len(zs),len(xs))
    assert len(xs)*len(zs)==len(terrain)
    def ground(x,z):
        x=np.asarray(x);z=np.asarray(z);ix=np.clip(np.searchsorted(xs,x)-1,0,len(xs)-2);iz=np.clip(np.searchsorted(zs,z)-1,0,len(zs)-2)
        u=np.clip((x-xs[ix])/(xs[ix+1]-xs[ix]),0,1);v=np.clip((z-zs[iz])/(zs[iz+1]-zs[iz]),0,1)
        return (H[iz,ix]*(1-u)+H[iz,ix+1]*u)*(1-v)+(H[iz+1,ix]*(1-u)+H[iz+1,ix+1]*u)*v
    far_fern_ids=[]
    for i in range(4):
        far_fern_ids.append(len(meshes));meshes.append(meshes[7+i]);meshes[7+i]=fern(190+i)
    instances=[];rootfix=0;tree_instances=[]
    for idx,node in enumerate(g.j['nodes']):
        if 'mesh' not in node:continue
        mid=node['mesh'];M=transform(node);t=M[:3,3]
        tint=np.ones(3)
        if mid<5:
            # Preserve each simulated branching graph; vary mature instance proportions.
            if np.hypot(t[0],t[2]-6)>15:
                M[:3,:3]*=np.array([rng.uniform(.89,1.08),rng.uniform(.82,1.15),rng.uniform(.89,1.08)])
                M[0,1]+=rng.uniform(-.035,.035);M[2,1]+=rng.uniform(-.025,.025)
            tint=np.array([rng.uniform(.89,1.12),rng.uniform(.92,1.1),rng.uniform(.86,1.15)])
            tree_instances.append((mid,M.copy()))
            if abs(t[0])<15 and -20<t[2]<36:
                src=meshes[mid];v=src.v.copy();p=v[:,:3]
                wp=p@M[:3,:3].T+t
                w=np.exp(-np.maximum(p[:,1],0)/.35)
                dy=(ground(wp[:,0],wp[:,2])-t[1]-.035)*w
                p[:]+=dy[:,None]*np.linalg.inv(M[:3,:3])[:,1]
                # Actual small geometric relief on basal bark. Fine detail is a bump field.
                barkids=np.unique(src.f[src.f[:,3]==1,:3]);q=p[barkids]
                basal=(q[:,1]<3.8)&(np.hypot(q[:,0],q[:,2])<1.1)
                selected=barkids[basal];q=p[selected]
                relief=.009*np.sin(q[:,0]*51+q[:,2]*37+np.sin(q[:,1]*8))*.65
                p[selected]+=v[selected,3:6]*relief[:,None]
                mid=len(meshes);meshes.append(Mesh(src.name+f'_grounded_{rootfix}',v,src.f.copy()));rootfix+=1
        elif mid in range(7,11):
            if np.hypot(t[0]+.32,t[2]+8.8)>24:mid=far_fern_ids[mid-7]
            tint=np.array([rng.uniform(.83,1.25),rng.uniform(.8,1.13),rng.uniform(.77,1.15)])
            # Some dry fronds; never all the same saturated green.
            if rng.random()<.06:tint=np.array([1.7,.86,.68])
        elif mid in [12,13,14]:tint*=rng.uniform(.8,1.15)
        instances.append((mid,M,tint))
    # The GLB's distant trunk proxy had no corresponding crowns. Add actual
    # instanced grown-graph crowns so the background is not a wall of bare poles.
    additional_crowns=105
    for k in range(additional_crowns):
        x=rng.uniform(-48,48);z=rng.uniform(32,112);angle=rng.uniform(0,2*math.pi)
        M=np.eye(4);scale=rng.uniform(.8,1.35);c=math.cos(angle);s=math.sin(angle)
        M[:3,:3]=np.array([[c,0,s],[0,rng.uniform(.9,1.25),0],[-s,0,c]])*scale
        M[:3,3]=[x,ground(x,z)-.04,z]
        instances.append((k%5,M,np.array([rng.uniform(.9,1.13),rng.uniform(.92,1.08),rng.uniform(.83,1.12)])))
    # Root flares that follow the actual height field, not a flat Y=0 apron.
    roots=Builder('terrain_conforming_root_flares')
    for mid,M in tree_instances:
        t=M[:3,3]
        if abs(t[0])>16 or t[2]<-18 or t[2]>32:continue
        radius=np.linalg.norm(M[:3,0])*.36
        for k in range(5):
            a=k*2*math.pi/5+rng.normal(0,.21);d=np.array([math.cos(a),0,math.sin(a)]);L=rng.uniform(1.15,2.15)*radius/.4
            pts=[];rr=[]
            for f in np.linspace(0,1,8):
                p=t+d*(radius*.64+L*f);p[1]=ground(p[0],p[2])+.24*(1-f)**2-.028
                pts.append(p);rr.append((.15*(1-f)**1.45+.007)*radius/.4)
            roots.tube(pts,rr,color=(.18,.14,.095),sides=9)
    meshes.append(roots.finish());instances.append((len(meshes)-1,np.eye(4),np.ones(3)))
    # Actual curled dry leaves, concentrated where the camera resolves them.
    litter=Builder('nearfield_curled_leaf_litter')
    for k in range(14500):
        x=rng.uniform(-11,11);z=rng.uniform(-13,34);a=rng.uniform(0,2*math.pi)
        base=[x,ground(x,z)+rng.uniform(.002,.011),z];L=rng.uniform(.035,.15);W=L*rng.uniform(.38,.75)
        axis=[math.cos(a),rng.uniform(-.03,.05),math.sin(a)];side=[-math.sin(a),0,math.cos(a)]
        col=np.array([.17,.082,.026])*rng.uniform(.42,1.6)
        if rng.random()<.13:col=np.array([.095,.12,.024])*rng.uniform(.7,1.2)
        litter.leaf(base,axis,side,L,W,col,material=6,segments=4,curl=rng.uniform(.004,.014),serrate=.2)
    meshes.append(litter.finish());instances.append((len(meshes)-1,np.eye(4),np.ones(3)))
    debris=Builder('nearfield_twigs_and_branches')
    for k in range(430):
        x=rng.uniform(-13,13);z=rng.uniform(-13,37);a=rng.uniform(0,2*math.pi);L=rng.uniform(.13,.9)
        d=np.array([math.cos(a),0,math.sin(a)]);p=np.array([x,0,z]);r=rng.uniform(.004,.015)
        pts=[]
        for t in np.linspace(0,1,4):
            q=p+d*L*t;q[1]=ground(q[0],q[2])+r+.012*math.sin(t*3);pts.append(q)
        debris.tube(pts,np.linspace(r,r*.4,4),color=(.11,.074,.038),sides=5)
    meshes.append(debris.finish());instances.append((len(meshes)-1,np.eye(4),np.ones(3)))
    cameras=[]
    for node in g.j['nodes']:
        if 'camera' in node:
            cm=g.j['cameras'][node['camera']];M=transform(node);eye=M[:3,3];fw=-M[:3,2];up=M[:3,1]
            cameras.append(dict(name=cm['name'],eye=eye.tolist(),target=(eye+fw*12).tolist(),up=up.tolist(),fov=cm['perspective']['yfov']*180/math.pi))
    # Slightly tighter hero lens and still grounded at human eye height.
    cameras.append(dict(name='Hero',eye=[-.32,float(ground(-.32,-8.8)+1.58),-8.8],target=[.42,2.1,13.5],up=[0,1,0],fov=49.0))
    validation={'input_sha256':hashlib.sha256(g.bytes).hexdigest(),'input_file':glb.name,'geometry_source':'CYBR VEG exported 3D GLB','root_grounding_copies':rootfix,'procedural_fern_replacements':4,'added_curled_leaves':14500,'added_twigs':430,'additional_background_crowns':105,'detailed_fern_radius_m':24,'meshes':[]}
    with open(out/'forest.cys','wb') as f:
        f.write(struct.pack('<4sIIII',b'CYS2',2,len(meshes),len(instances),len(cameras)))
        for m in meshes:
            assert np.isfinite(m.v).all() and m.f[:,:3].max()<len(m.v)
            assert m.f[:,3].max()<8
            n=m.v[:,3:6];norm=np.linalg.norm(n,axis=1);n[:]=n/np.maximum(norm[:,None],1e-15)
            name=m.name.encode();f.write(struct.pack('<III',len(name),len(m.v),len(m.f)));f.write(name);f.write(m.v.astype('<f4').tobytes());f.write(m.f.astype('<u4').tobytes())
            p=m.v[:,:3];inds=m.f[:,:3];area=np.linalg.norm(np.cross(p[inds[:,1]]-p[inds[:,0]],p[inds[:,2]]-p[inds[:,0]]),axis=1)*.5
            validation['meshes'].append(dict(name=m.name,vertices=len(m.v),triangles=len(m.f),zero_area_faces=int(np.sum(area<1e-13)),finite=True))
        for mid,M,tint in instances:
            inv=np.linalg.inv(M);f.write(struct.pack('<I',mid));f.write(np.asarray(M[:3,:],dtype='<f4').tobytes());f.write(np.asarray(inv[:3,:],dtype='<f4').tobytes());f.write(np.asarray(tint,dtype='<f4').tobytes())
        for cam in cameras:
            name=cam['name'].encode();f.write(struct.pack('<I',len(name)));f.write(name)
            f.write(struct.pack('<10f',*cam['eye'],*cam['target'],*cam['up'],cam['fov']))
    validation['unique_vertices']=sum(len(m.v) for m in meshes);validation['unique_triangles']=sum(len(m.f) for m in meshes)
    validation['instances']=len(instances);validation['instance_expanded_triangles']=sum(len(meshes[mid].f) for mid,_,_ in instances)
    validation['textures']=texture_pack(out);validation['elapsed_seconds']=time.time()-started
    (out/'scene_manifest.json').write_text(json.dumps(validation,indent=2));(out/'cameras.json').write_text(json.dumps(cameras,indent=2))
    print(json.dumps({k:v for k,v in validation.items() if k not in ['meshes','textures']},indent=2))

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('glb',type=Path);ap.add_argument('out',type=Path);args=ap.parse_args();prepare(args.glb,args.out)
