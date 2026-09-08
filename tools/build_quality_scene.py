#!/usr/bin/env python3
"""Deterministic, additive foreground upgrade of the ORIGINAL CYBR forest GLB.

Retains every original mesh buffer; only explicitly listed near-camera instances
are redirected to higher-detail copies. The source GLB is never modified.
No photographs, generated-image geometry, remote models, or billboard crowns.
"""
from __future__ import annotations
import argparse, hashlib, json, math, struct, sys, time
from pathlib import Path
import numpy as np
from scipy.interpolate import RegularGridInterpolator
from skimage.measure import marching_cubes
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from prepare_scene import GLB,Mesh,Builder,transform,normalize

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1<<20),b''):h.update(b)
    return h.hexdigest()

def normals(mesh:Mesh, selected=None):
    """Area-weighted normals after deformation, not re-normalized stale normals.

Weld identical positions within the selected surface only. Leaf blades keep their
independent smoothing groups. Opposite sides and material boundaries are separate.
"""
    faces=mesh.f if selected is None else mesh.f[selected]
    used=np.unique(faces[:,:3]);p=mesh.v[:,:3].astype(np.float64)
    area=np.cross(p[faces[:,1]]-p[faces[:,0]],p[faces[:,2]]-p[faces[:,0]])
    sums=np.zeros_like(p)
    for k in range(3):np.add.at(sums,faces[:,k],area)
    # Geometric seams on tubes duplicate the end ring, but should shade continuously.
    _,inverse=np.unique(np.round(p[used],6),axis=0,return_inverse=True)
    welded=np.zeros((int(inverse.max())+1,3));np.add.at(welded,inverse,sums[used])
    good=np.linalg.norm(welded[inverse],axis=1)>1e-16
    mesh.v[used[good],3:6]=normalize(welded[inverse[good]])
    return mesh

def merge(name,*meshes):
    vs=[];fs=[];off=0
    for m in meshes:
        f=m.f.copy();f[:,:3]+=off;vs.append(m.v);fs.append(f);off+=len(m.v)
    return Mesh(name,np.vstack(vs),np.vstack(fs))

def load_original(path):
    g=GLB(path);meshes=[];instances=[];cameras=[]
    for m in g.j['meshes']:
        attr=m['primitives'][0]['attributes']
        v=np.column_stack([g.accessor(attr[k]) for k in ('POSITION','NORMAL','TEXCOORD_0','COLOR_0')]).astype('<f4')
        f=np.vstack([np.column_stack((g.accessor(p['indices']).reshape(-1,3),
                        np.full(g.accessor(p['indices']).size//3,p['material']))) for p in m['primitives']])
        meshes.append(Mesh(m['name'],v,f))
    def visit(i,parent):
        n=g.j['nodes'][i];M=parent@transform(n)
        if 'mesh' in n:instances.append([n['mesh'],M,np.ones(3)])
        if 'camera' in n:
            c=g.j['cameras'][n['camera']]
            cameras.append(dict(name=c['name'],eye=M[:3,3].tolist(),target=(M[:3,3]-12*M[:3,2]).tolist(),
                                up=M[:3,1].tolist(),fov=float(np.degrees(c['perspective']['yfov']))))
        for j in n.get('children',[]):visit(j,M)
    for i in g.j['scenes'][g.j.get('scene',0)]['nodes']:visit(i,np.eye(4))
    return meshes,instances,cameras

def ground_function(mesh):
    p=mesh.v[:,:3];x=np.unique(p[:,0]);z=np.unique(p[:,2]);height=np.empty((len(z),len(x)))
    height[np.searchsorted(z,p[:,2]),np.searchsorted(x,p[:,0])]=p[:,1]
    interp=RegularGridInterpolator((z,x),height,bounds_error=False,fill_value=None)
    def at(x,z):
        x,z=np.broadcast_arrays(x,z);result=interp(np.column_stack((z.ravel(),x.ravel())))
        return result.reshape(x.shape)
    return at

def smoothmin(a,b,k):
    h=np.clip(.5+.5*(b-a)/k,0,1)
    return b*(1-h)+a*h-k*h*(1-h)

def capsule(X,Y,Z,a,b,ra,rb):
    a=np.asarray(a);b=np.asarray(b);v=b-a
    t=np.clip(((X-a[0])*v[0]+(Y-a[1])*v[1]+(Z-a[2])*v[2])/np.dot(v,v),0,1)
    return np.sqrt((X-a[0]-v[0]*t)**2+(Y-a[1]-v[1]*t)**2+(Z-a[2]-v[2]*t)**2)-(ra*(1-t)+rb*t)

def integrated_root_base(seed,M,ground,step=.027):
    """A closed isosurface unites the trunk flare with tapered roots.

The upper trunk junction intentionally overlaps the retained original woody
skeleton; the new basal component itself is closed and connected.
"""
    rng=np.random.default_rng(seed);lim=2.05
    x=np.arange(-lim,lim+step,step);y=np.arange(-.85,1.77+step,step);z=x.copy()
    X=x[:,None,None];Y=y[None,:,None];Z=z[None,None,:]
    radius=.32-.026*np.clip(Y,0,1.6)+.045*np.exp(-np.maximum(Y,0)*3.2)
    radial=np.sqrt((X-.013*Y)**2+(Z-.010*Y)**2)-radius
    cap=np.abs(Y-.59)-.99
    field=np.minimum(np.maximum(radial,cap),0)+np.hypot(np.maximum(radial,0),np.maximum(cap,0))
    for i in range(9):
        theta=i*2.399963+float(rng.uniform(-.15,.15));d=np.array([np.cos(theta),0,np.sin(theta)])
        L=rng.uniform(1.20,1.75)
        for a,b,ra,rb in [([0,.43,0],d*.55+np.array([0,.14,0]),.22,.16),
                          (d*.55+np.array([0,.14,0]),d*L+np.array([0,-.16,0]),.16,.035)]:
            field=smoothmin(field,capsule(X,Y,Z,a,b,ra,rb),.16)
    # Terrain matching is a vertical coordinate deformation of the finished surface.
    verts,faces,_,_=marching_cubes(field.astype(np.float32),0,spacing=(step,step,step),allow_degenerate=False)
    verts+=np.array([x[0],y[0],z[0]])
    world=verts@M[:3,:3].T+M[:3,3];base=M[1,3]
    delta=(ground(world[:,0],world[:,2])-base-.045)*np.exp(-np.maximum(verts[:,1],0)*5)
    verts+=delta[:,None]*np.linalg.inv(M)[:3,1]
    a=np.arctan2(verts[:,2],verts[:,0]);h=verts[:,1]
    # Centimetre-scale longitudinal bark relief is genuine displacement.
    radial_dirs=normalize(np.column_stack((verts[:,0],np.zeros(len(verts)),verts[:,2])))
    grooves=.007*np.sin(a*37+np.sin(h*2.7))+.004*np.sin(a*83+h*3.1)
    verts+=radial_dirs*grooves[:,None]
    color=np.tile([.19,.165,.12],(len(verts),1));uv=np.column_stack(((a+math.pi)*.33,h))
    color*= (.90+.10*np.sin(h*1.9+a*3))[:,None]
    f=np.column_stack((faces,np.ones(len(faces),dtype=np.uint32)))
    # Ensure outward orientation by signed volume before computing area-weighted normals.
    signed=np.sum(np.einsum('ij,ij->i',verts[faces[:,0]],np.cross(verts[faces[:,1]],verts[faces[:,2]])))
    if signed<0:f[:,[1,2]]=f[:,[2,1]]
    mesh=Mesh(f'integrated_root_bark_{seed}',np.column_stack((verts,np.zeros_like(verts),uv,color)),f)
    normals(mesh)
    # Preserve geometry, split only attributes along the cylindrical texture seam.
    seam=np.ptp(mesh.v[mesh.f[:,:3],6],axis=1)>math.pi*.33
    extra=[]
    for face in np.flatnonzero(seam):
        for k in range(3):
            vid=mesh.f[face,k]
            if mesh.v[vid,6]<math.pi*.33:
                v=mesh.v[vid].copy();v[6]+=math.tau*.33
                mesh.f[face,k]=len(mesh.v)+len(extra);extra.append(v)
    if extra:mesh.v=np.vstack((mesh.v,extra)).astype('<f4')
    return mesh

def upgrade_tree(original,seed,M,ground):
    v=original.v.copy();f=original.f.copy();y=v[:,1].copy()
    # Bend wood and its attached leaves with the same C1 deformation, not independently.
    dx=.045*(np.sin(y*.72)-y*.72*np.exp(-y*2))
    dz=.055*(np.sin(y*.48)-y*.48*np.exp(-y*2))
    dxd=.045*(.72*np.cos(y*.72)-.72*np.exp(-y*2)+1.44*y*np.exp(-y*2))
    dzd=.055*(.48*np.cos(y*.48)-.48*np.exp(-y*2)+.96*y*np.exp(-y*2))
    v[:,0]+=dx;v[:,2]+=dz
    v[:,4]-=dxd*v[:,3]+dzd*v[:,5];v[:,3:6]=normalize(v[:,3:6])
    p=v[:,:3];wood=f[:,3]==1
    near=(p[f[:,:3],1].max(1)<1.37)&wood
    body=Mesh(f'hero_retained_crown_{seed}',v,f[~near]);ids=np.unique(body.f[body.f[:,3]==1,:3])
    # Geometry-level bark detail only on retained wood, followed by recomputed normals.
    q=body.v[ids,:3];d=.004*np.sin(q[:,0]*92+q[:,1]*.8)*np.sin(q[:,2]*73+q[:,1]*1.7)
    body.v[ids,:3]+=body.v[ids,3:6]*d[:,None]
    normals(body,body.f[:,3]==1)
    basal=integrated_root_base(seed,M,ground)
    return merge(f'hero_tree_{seed}',body,basal),int(near.sum()),basal

def fern(seed):
    rng=np.random.default_rng(seed);b=Builder(f'broad_divided_fern_{seed}')
    for j in range(9):
        theta=j*2.399963+rng.normal(0,.12);d=np.array([np.cos(theta),0,np.sin(theta)])
        side=np.array([-d[2],0,d[0]]);L=float(rng.uniform(.87,1.35));height=rng.uniform(.58,.78)
        def center(t):return d*(L*.91*t)+np.array([0,L*(height*np.sin(t*2.2)+.05*t),0])
        ts=np.linspace(0,1,25)
        b.tube([center(t) for t in ts],[.005*(1-t)+.0009 for t in ts],3,(.065,.105,.025),6)
        for i,t in enumerate(np.linspace(.12,.96,23)):
            width=L*.26*np.sin(math.pi*(t+.02))**.7
            for sign in [-1,1]:
                origin=center(t);axis=normalize(side*sign+d*(.24+.36*t)+[0,.03,0])
                leafside=normalize(np.cross([0,1,0],axis))
                col=np.array([.068,.155,.020])*rng.uniform(.8,1.14)
                # A continuous, lobed pinna with substantial projected area.
                start=len(b.v);sections=14
                for k in range(sections+1):
                    s=k/sections;edge=(np.sin(math.pi*s)**.6 if k not in (0,sections) else .015)
                    lobes=.77+.23*np.cos(s*math.tau*5)
                    half=.033*L*edge*lobes*(1-.22*t)
                    c=origin+axis*width*s+[0,.014*np.sin(math.pi*s),0]
                    for cside in [-1,0,1]:
                        pos=c+leafside*half*cside-[0,abs(cside)*half*.13,0]
                        normal=normalize(np.array([0,1,0])+leafside*cside*.21)
                        b.vertex(pos,normal,((cside+1)/2,s),col)
                for k in range(sections):
                    for s in range(2):
                        a=start+3*k+s;b.triangle(a,a+1,a+3,3);b.triangle(a+1,a+4,a+3,3)
        # Tender terminal blade, attached to the same rachis curve.
        b.leaf(center(.96),normalize(center(1)-center(.94)),side,L*.08,.038*L,(.09,.18,.028),segments=6)
    return b.finish()

def hollow_log(center,direction,length,radius,seed):
    rng=np.random.default_rng(seed);b=Builder('hollow_fallen_timber');d=normalize(direction)
    up=normalize(np.array([0,1,0])-d*d[1]);side=normalize(np.cross(d,up));center=np.asarray(center)
    nr=96;nt=61;phase=rng.uniform(0,math.tau,5)
    def endpoint(a,k):return .12*np.sin(a*7+phase[k])+.07*np.sin(a*17+phase[2])+ .10*np.maximum(0,np.sin(a*3+phase[3]))
    def position(t,a,inner):
        axis_distance=(t-.5)*length+endpoint(a,0)*(1-t)**8+endpoint(a,1)*t**8
        c=center+d*axis_distance+up*.025*np.sin(math.pi*t)+side*.03*np.sin(t*math.tau)
        irregular=1+.05*np.sin(a*3+t*2)+.03*np.sin(a*7-t*8)
        # Outer relief and chipped cambium; interior stays a genuinely separate surface.
        r=radius*irregular*(.69 if inner else 1)+(.002 if inner else .006)*np.sin(a*47+t*8)
        return c+(up*np.cos(a)+side*np.sin(a))*r
    for inner in [False,True]:
        base=len(b.v)
        for i in range(nt):
            t=i/(nt-1)
            for k in range(nr+1):
                a=k*math.tau/nr;p=position(t,a,inner)
                n=(up*np.cos(a)+side*np.sin(a))*(-1 if inner else 1)
                col=(.11,.073,.038) if inner else (.19,.145,.095)
                b.vertex(p,n,(a*radius,(t-.5)*length),col)
        for i in range(nt-1):
            for k in range(nr):
                a=base+i*(nr+1)+k
                if inner:b.triangle(a,a+1,a+nr+1,1);b.triangle(a+1,a+nr+2,a+nr+1,1)
                else:b.triangle(a,a+nr+1,a+1,1);b.triangle(a+1,a+nr+1,a+nr+2,1)
    # Join ragged inner/outer bark rings. No filled end discs hiding the hollow cavity.
    for t in [0,1]:
        base=len(b.v)
        for k in range(nr+1):
            a=k*math.tau/nr
            for inner in [False,True]:
                p=position(t,a,inner);r=radius*(.69 if inner else 1)
                b.vertex(p,d*(-1 if t==0 else 1),(r*np.cos(a),r*np.sin(a)),(.24,.15,.065))
        for k in range(nr):
            a=base+2*k
            if t==0:b.triangle(a,a+1,a+2,7);b.triangle(a+2,a+1,a+3,7)
            else:b.triangle(a,a+2,a+1,7);b.triangle(a+2,a+3,a+1,7)
    # Bracket fungi: layered shells with thickness, attached to the timber surface.
    for j in range(15):
        t=rng.uniform(.10,.93);a=rng.uniform(-1.3,1.3);anchor=position(t,a,False)
        n=normalize(up*np.cos(a)+side*np.sin(a));s=normalize(np.cross(n,d));R=rng.uniform(.055,.14)
        start=len(b.v)
        for layer in [0,1]:
            for row in range(7):
                rr=R*row/6
                for k in range(17):
                    angle=-math.pi*.78+k/16*math.pi*1.56
                    p=anchor+s*np.sin(angle)*rr+n*(np.cos(angle)*rr*.72)+up*(.024*(1-row/6)**2-layer*.009)
                    col=np.array([.27,.21,.13])*(.85+.15*np.cos(rr/R*math.pi*5)) if not layer else [.19,.16,.10]
                    b.vertex(p,up if not layer else -up,(rr,np.sin(angle)),col)
        for row in range(6):
            for k in range(16):
                a0=start+row*17+k;b.triangle(a0,a0+1,a0+17,6);b.triangle(a0+1,a0+18,a0+17,6)
                a0+=119;b.triangle(a0,a0+17,a0+1,6);b.triangle(a0+1,a0+17,a0+18,6)
    m=b.finish()
    points=m.v[:,:3].astype(np.float64)
    area=np.cross(points[m.f[:,1]]-points[m.f[:,0]],points[m.f[:,2]]-points[m.f[:,0]])
    m.f=m.f[np.linalg.norm(area,axis=1)>1e-13]
    normals(m,m.f[:,3]==1)
    # Moss is spatial material variation, not baked illumination.
    verts=m.v;normal=verts[:,3:6]
    patches=np.maximum(0,np.sin(verts[:,0]*11+verts[:,2]*7)*np.sin(verts[:,2]*17+verts[:,1]*4))
    amount=np.clip((normal[:,1]-.25)*1.1,0,1)*patches*.72
    verts[:,8:11]=verts[:,8:11]*(1-amount[:,None])+np.array([.045,.078,.018])*amount[:,None]
    return m

def write_scene(path,meshes,instances,cameras):
    path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix('.tmp')
    with tmp.open('wb') as out:
        out.write(struct.pack('<4sIIII',b'CYS2',2,len(meshes),len(instances),len(cameras)))
        for m in meshes:
            name=m.name.encode();out.write(struct.pack('<III',len(name),len(m.v),len(m.f)))
            out.write(name);out.write(m.v.astype('<f4').tobytes());out.write(m.f.astype('<u4').tobytes())
        for mid,M,tint in instances:
            out.write(struct.pack('<I',mid));out.write(M[:3].astype('<f4').tobytes())
            out.write(np.linalg.inv(M)[:3].astype('<f4').tobytes());out.write(np.asarray(tint,dtype='<f4').tobytes())
        for c in cameras:
            n=c['name'].encode();out.write(struct.pack('<I',len(n)));out.write(n)
            out.write(struct.pack('<10f',*c['eye'],*c['target'],*c['up'],c['fov']))
    tmp.replace(path)

def build(source,out):
    begin=time.time();meshes,instances,cameras=load_original(source);ground=ground_function(meshes[24])
    original_hashes=[hashlib.sha256(m.v.tobytes()+m.f.tobytes()).hexdigest() for m in meshes]
    edits=[];bases=[]
    for target,seed in [((-3.8,-1.5),7113),((3.699,-4.638),9017),((4.7,5.7),12181)]:
        candidates=[(np.linalg.norm(M[[0,2],3]-target),i) for i,(mid,M,tint) in enumerate(instances) if mid<5]
        _,i=min(candidates);mid,M,tint=instances[i]
        new,removed,basal=upgrade_tree(meshes[mid],seed,M,ground)
        instances[i][0]=len(meshes);meshes.append(new);bases.append(basal)
        edits.append(dict(kind='connected_root_trunk_with_retained_crown',instance=i,source_mesh=mid,new_mesh=len(meshes)-1,
                          removed_lower_wood_faces=removed,new_vertices=len(new.v),new_triangles=len(new.f)))
        print('TREE',seed,len(new.v),len(new.f),flush=True)
    fern_ids=[]
    for seed in [152,691,817,911]:
        f=fern(seed);fern_ids.append(len(meshes));meshes.append(f)
    replaced=[]
    for i,(mid,M,tint) in enumerate(instances):
        if 7<=mid<=10 and -9<M[2,3]<18 and abs(M[0,3])<11:
            instances[i][0]=fern_ids[mid-7];replaced.append(i)
    edits.append(dict(kind='divided_frond_replacement',instances=replaced,new_meshes=fern_ids))
    # Replace the first old log, preserving the other fallen timber buffers in a copy.
    old=meshes[6];low=old.v[old.f[:,:3],2].max(1)<6
    old_copy=Mesh('retained_background_timber',old.v.copy(),old.f[~low]);mid=len(meshes);meshes.append(old_copy)
    for ins in instances:
        if ins[0]==6:ins[0]=mid
    cen=np.array([-5.05,float(ground(-5.05,3.25))+.285,3.25]);log=hollow_log(cen,[-.875,.017,-.483],4.95,.37,8169)
    instances.append([len(meshes),np.eye(4),np.ones(3)]);meshes.append(log)
    edits.append(dict(kind='hollow_fallen_log',removed_original_faces=int(low.sum()),new_mesh=len(meshes)-1,
                      triangles=len(log.f),position=cen.tolist()))
    # Directed close plants support a real macro shot without replacing the whole forest.
    for i,(x,z) in enumerate([(-2.4,-1.5),(-2.2,.9),(-4.1,.2),(-5.9,1.4),(-4.2,5.5),(2.6,-3.3),(3.0,1.3)]):
        theta=i*2.399963;S=.84+.07*(i%3);c=math.cos(theta);s=math.sin(theta);M=np.eye(4)
        M[:3,:3]=np.array([[c,0,s],[0,1,0],[-s,0,c]])*S;M[:3,3]=[x,float(ground(x,z))-.025,z]
        instances.append([fern_ids[i%4],M,np.ones(3)])
    # Preserve original buffers exactly; higher-detail changes use additional meshes.
    assert all(hashlib.sha256(m.v.tobytes()+m.f.tobytes()).hexdigest()==h for m,h in zip(meshes[:25],original_hashes))
    bad=0;zero=0
    for m in meshes:
        if not np.isfinite(m.v).all() or np.any(m.f[:,:3]>=len(m.v)):raise ValueError('Invalid mesh '+m.name)
        n=np.linalg.norm(m.v[:,3:6],axis=1);bad+=int(np.sum(np.abs(n-1)>1e-3))
        p=m.v[:,:3].astype(np.float64);cross=np.cross(p[m.f[:,1]]-p[m.f[:,0]],p[m.f[:,2]]-p[m.f[:,0]])
        zero+=int(np.sum(np.linalg.norm(cross,axis=1)<1e-13))
    write_scene(out/'forest.cys',meshes,instances,cameras)
    report=dict(schema='cybr-quality-scene-v1',source_glb_sha256=sha(source),scene_sha256=sha(out/'forest.cys'),
                original_mesh_buffers_preserved=25,original_instance_count=9810,meshes=len(meshes),instances=len(instances),
                unique_triangles=sum(len(m.f) for m in meshes),instance_expanded_triangles=sum(len(meshes[x[0]].f) for x in instances),
                nonunit_normals=bad,zero_area_faces=zero,edits=edits,build_seconds=time.time()-begin,
                generated_images_used=False,new_biological_growth_run=False,
                limitations=['Upper branch junctions retain original intersections','Fungi use shell approximations','Mature trees are art-directed geometry, not newly simulated decades'])
    (out/'quality-scene.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='edits'},indent=2),flush=True)
    return report

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=ROOT/'assets/input/CYBR_FOREST.glb')
    ap.add_argument('--out',type=Path,default=ROOT/'assets');a=ap.parse_args();build(a.source,a.out)
