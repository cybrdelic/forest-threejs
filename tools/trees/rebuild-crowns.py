"""Rebuild close and middle crowns from the original CC0 Poly Haven glTFs.

Pass directories containing both original glTFs and their external geometry.
The existing trunk/wood LOD is kept. Each repeated UV island is isolated with
its exact authored triangle mask. A low-order fitted surface retains the
original position, bend, photographic cutout and normals of each crown shoot.
"""
from argparse import ArgumentParser
from pathlib import Path
import json
import struct
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, map_coordinates, shift
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

site = Path(__file__).resolve().parents[2]
parser = ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--only', choices=['oak', 'jacaranda'])
args = parser.parse_args()
dtype = np.dtype([('position', '<u2', 3), ('normal', 'i1', 2), ('visibility', 'u1', 9),
                  ('material', 'u1'), ('extras', '<u2', 2)])
assert dtype.itemsize == 22

def read_wood(directory, level):
    raw = (directory / (level+'-vertices.bin')).read_bytes()
    if raw[:4] == b'TRV6':
        _, n, *bounds = struct.unpack('<4sI6f', raw[:32])
        packed = np.frombuffer(raw, offset=32, count=n, dtype=dtype)
        v = np.ones((n, 12), np.float32)
        v[:, :3] = packed['position'] / 65535 * np.array(bounds[3:]) + bounds[:3]
        xy = packed['normal'].astype(np.float32) / 127
        z = 1 - np.abs(xy).sum(axis=1)
        v[:, 3:5] = np.where((z >= 0)[:,None], xy, (1-np.abs(xy[:,::-1]))*np.where(xy>=0,1,-1))
        v[:, 5] = z
        v[:, 9] = packed['material']
        v[:, 10:] = packed['extras'] / 65535
    else:
        v = np.frombuffer(raw, np.float32).reshape(-1, 12)
    f = np.fromfile(directory/(level+'-indices.bin'), np.uint32).reshape(-1, 3)
    f = f[v[f[:, 0], 9] == 1]
    used, indices = np.unique(f, return_inverse=True)
    return v[used].copy(), indices.reshape(-1, 3).astype(np.uint32)

def read_source(directory):
    doc=json.loads(next(directory.glob('*.gltf')).read_text())
    blob=(directory/doc['buffers'][0]['uri']).read_bytes()
    def accessor(i):
        a=doc['accessors'][i]
        b=doc['bufferViews'][a['bufferView']]
        t={5121:'u1',5123:'<u2',5125:'<u4',5126:'<f4'}[a['componentType']]
        w={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        return np.frombuffer(blob,t,count=a['count']*w,offset=b.get('byteOffset',0)+a.get('byteOffset',0)).reshape(-1,w)
    primitive=next(p for p in doc['meshes'][0]['primitives'] if 'leaves' in doc['materials'][p['material']]['name'])
    at=primitive['attributes']
    return accessor(at['POSITION']),accessor(at['NORMAL']),accessor(at['TEXCOORD_0']),accessor(primitive['indices']).reshape(-1,3)

def field_visibility(asset, positions):
    directory=site/'dist/assets/impostors'
    data=json.loads((directory/(asset+'-density.json')).read_text())
    n=data['size']
    grid=np.fromfile(directory/(asset+'-density.bin'),np.uint8).reshape(n,n,n).transpose(2,1,0)
    density=grid.astype(np.float32)*(data['decodeScale']/255)
    cell=np.array(data['extent'])/n
    coordinate=((positions-data['minimum'])/cell-.5).T
    output=np.zeros((len(positions),9),np.uint8)
    for k in range(7):
        elevation=np.radians(36 if k<6 else 90)
        azimuth=k*np.pi/3
        direction=np.array([np.sin(azimuth)*np.cos(elevation),np.sin(elevation),np.cos(azimuth)*np.cos(elevation)])
        # Sweep toward the sun through the measured full-source leaf density.
        # At each height, the previous slice stores all the optical depth ahead.
        step=cell[1]/direction[1]
        advance=direction[[0,2]]*step/cell[[0,2]]
        depth=np.zeros_like(density)
        for y in reversed(range(n-1)):
            ahead=shift(depth[:,y+1,:]+density[:,y+1,:]*step*.25,-advance,order=1,mode='constant',cval=0,prefilter=False)
            depth[:,y,:]=density[:,y,:]*step*.25+ahead
        extinction=map_coordinates(depth,coordinate,order=1,mode='constant',cval=0,prefilter=False)
        output[:,k]=np.round(np.exp(-extinction)*255).astype(np.uint8)
    output[:,7]=np.round(.75*output[:,:6].mean(axis=1)+.25*output[:,6]).astype(np.uint8)
    output[:,8]=255   # Mark physically sampled wood or foliage in the shared vertex layout.
    return output

def write_level(name, directory, level, v, faces):
    out=np.zeros(len(v),dtype)
    minimum=v[:,:3].min(0)
    extent=np.maximum(1e-4,v[:,:3].max(0)-minimum)
    out['position']=np.round(np.clip((v[:,:3]-minimum)/extent,0,1)*65535)
    norm=v[:,3:6]/np.maximum(1e-6,np.abs(v[:,3:6]).sum(1,keepdims=True))
    xy=norm[:,:2]
    octa=np.where((norm[:,2]>=0)[:,None],xy,(1-np.abs(xy[:,::-1]))*np.where(xy>=0,1,-1))
    out['normal']=np.round(np.clip(octa,-1,1)*127)
    out['material']=v[:,9]
    out['extras']=np.round(np.clip(v[:,10:],0,1)*65535)
    out['visibility']=field_visibility(name,v[:,:3])
    header=struct.pack('<4sI6f',b'TRV6',len(v),*minimum,*extent)
    (directory/(level+'-vertices.bin')).write_bytes(header+out.tobytes())
    faces.astype('<u4').tofile(directory/(level+'-indices.bin'))

def quadratic(u):
    x,y=u.T
    return np.column_stack([np.ones(len(u)),x,y,x*y,x*x,y*y])

def surface(samples, uv, grid, rows, use_curve):
    # All occurrences of this UV template share its parameterization but
    # carry their own pose, bending, and authored normals. Logical UV order
    # removes differences in glTF vertex enumeration across instances.
    template=np.round(uv[rows[0]],5)
    key=np.lexsort((template[:,1],template[:,0]))
    sorted_uv=uv[rows]
    order=np.lexsort((np.round(sorted_uv[:,:,1],5),np.round(sorted_uv[:,:,0],5)),axis=1)
    sorted_rows=np.take_along_axis(rows,order,axis=1)
    u=uv[rows[0,key]].astype(np.float64)
    lo,hi=uv[rows[0]].min(0),uv[rows[0]].max(0)
    local=(u-lo)/(hi-lo)
    if use_curve:
        fit=quadratic(grid)@np.linalg.pinv(quadratic(local),rcond=1e-6)
    else:
        basis=lambda xy:np.column_stack([np.ones(len(xy)),xy,xy[:,0]*xy[:,1]])
        fit=basis(grid)@np.linalg.pinv(basis(local),rcond=1e-6)
    return (fit.astype(np.float32)@samples[sorted_rows]).astype(np.float32)

def isolate_template(atlas, source, template_uv, triangles, box):
    x,y,size=box
    lo,hi=template_uv.min(0),template_uv.max(0)
    inner=size-6
    norm=(template_uv-lo)/(hi-lo)
    xy=norm*(inner-1)+3
    mask=Image.new('L',(size*4,size*4))
    draw=ImageDraw.Draw(mask)
    for tri in triangles:
        draw.polygon([tuple(p) for p in (xy[tri]+.5)*4],fill=255)
    coverage=np.asarray(mask.resize((size,size),Image.Resampling.BOX)).astype(np.float32)/255
    yy,xx=np.indices((size,size))
    u=lo[0]+(xx-3)/(inner-1)*(hi[0]-lo[0])
    v=lo[1]+(yy-3)/(inner-1)*(hi[1]-lo[1])
    rgba=np.stack([map_coordinates(source[:,:,c].astype(np.float32),[v*source.shape[0]-.5,u*source.shape[1]-.5],order=1,mode='nearest') for c in range(4)],axis=-1)
    rgba[:,:,3]*=coverage
    rgba=np.round(np.clip(rgba,0,255)).astype(np.uint8)
    # Copy nearest covered RGB into alpha borders for stable filtering.
    valid=rgba[:,:,3]>24
    if np.any(valid):
        nearest=distance_transform_edt(~valid,return_distances=False,return_indices=True)
        rgba[:,:,:3]=np.where(valid[:,:,None],rgba[:,:,:3],rgba[tuple(nearest)][:,:,:3])
    atlas[y:y+size,x:x+size]=rgba

def build(name,srcname,target,scale,yoffset,material):
    print('Reading',name,flush=True)
    pos,norm,uv,faces=read_source(args.source/srcname)
    pos=pos.copy()*scale; pos[:,1]+=yoffset
    pairs=np.concatenate([faces[:,[0,1]],faces[:,[1,2]]])
    count,labels=connected_components(coo_matrix((np.ones(len(pairs),np.uint8),(pairs[:,0],pairs[:,1])),shape=(len(pos),len(pos))),directed=False)
    del pairs
    order=np.argsort(labels,kind='stable')
    starts=np.r_[0,np.cumsum(np.bincount(labels))]
    counts=np.diff(starts)
    lo=np.minimum.reduceat(uv[order],starts[:-1])
    hi=np.maximum.reduceat(uv[order],starts[:-1])
    keys=np.column_stack([np.rint(np.column_stack([lo,hi])*512).astype(np.int32),counts])
    templates,group=np.unique(keys,axis=0,return_inverse=True)
    tiles=4
    leafdir=site/'assets-source/leaves'
    input_dir=site/'assets-source/leaf-originals'
    input_dir.mkdir(exist_ok=True)
    sources=[]
    atlases=[]
    for label in ['albedo-alpha','normal']:
        path=input_dir/(name+'-'+label+'-512.png')
        if not path.exists():path.write_bytes((leafdir/path.name).read_bytes())
        sources.append(np.asarray(Image.open(path).convert('RGBA')).copy())
        atlases.append(np.zeros((512,512,4),np.uint8))
    sources[1][:,:,3]=sources[0][:,:,3]
    polygon_labels=labels[faces[:,0]]
    face_order=np.argsort(polygon_labels,kind='stable')
    face_starts=np.r_[0,np.cumsum(np.bincount(polygon_labels))]
    directory=site/'dist/assets'/target
    mesh={level:[*([item] for item in read_wood(directory,level)),0,0] for level in ['near','mid']}
    for level in mesh:mesh[level][2]=len(mesh[level][0][0])
    data=np.column_stack([pos,norm])
    rng=np.random.default_rng(45271)
    rankings=rng.random(count)
    stats={}
    for variant,template in enumerate(templates):
        ids=np.flatnonzero(group==variant)
        nr=template[-1]
        rows=order[starts[ids,None]+np.arange(nr)]
        first=ids[0]
        tri=faces[face_order[face_starts[first]:face_starts[first+1]]]
        tri=np.searchsorted(rows[0],tri)
        # The atlas dedicates a square to each distinct isolated shoot.
        # Padding and RGB dilation keep neighbouring templates out of the
        # cutout as hardware trilinear filtering walks between mip levels.
        tile=128
        col=(variant%tiles)*tile
        row=(variant//tiles)*tile
        for output,source in zip(atlases,sources):
            isolate_template(output,source,uv[rows[0]],tri,(col,row,tile))
        for level in ['near','mid']:
            fraction=1 if level=='near' else (.37 if name=='oak' else .12)
            selected=rows[rankings[ids]<fraction]
            if not len(selected):continue
            # Omit extra subdivisions on individual small leaflets. Preserve
            # the true-scale frond population throughout both near crowns.
            nx=ny=1
            if level=='near' and name=='oak' and nr>=40:nx=ny=2
            if level=='near' and name=='jacaranda' and nr>=30:nx=2
            coord=np.array([(x/nx,y/ny) for y in range(ny+1) for x in range(nx+1)])
            fitted=surface(data,uv,coord,selected,nx*ny>1)
            geo=fitted[:,:,:3]
            normals=fitted[:,:,3:]
            center=geo.mean(1,keepdims=True)
            geo=center+(geo-center)/np.sqrt(fraction)
            vv=np.ones((len(selected),len(coord),12),np.float32)
            vv[:,:,:3]=geo
            vv[:,:,3:6]=normals/np.maximum(1e-5,np.linalg.norm(normals,axis=-1,keepdims=True))
            vv[:,:,9]=material
            vv[:,:,10:]=((np.array([col,row]) + 3.5)+coord*(tile-7))/512
            local=[]
            for iy in range(ny):
                for ix in range(nx):
                    a=iy*(nx+1)+ix
                    local.extend([[a,a+1,a+nx+2],[a,a+nx+2,a+nx+1]])
            local=np.array(local,np.uint32)
            ff=np.broadcast_to(local,(len(selected),*local.shape)).copy()
            triangles=geo[:,local]
            front=np.sum(np.cross(triangles[:,:,1]-triangles[:,:,0],triangles[:,:,2]-triangles[:,:,0])*vv[:,local[:,0],3:6],axis=-1)<0
            ij=np.where(front);ff[ij]=ff[ij][:,[0,2,1]]
            output,indices,start,total=mesh[level]
            ff+=np.arange(len(selected),dtype=np.uint32)[:,None,None]*len(coord)+start
            indices.append(ff.reshape(-1,3));output.append(vv.reshape(-1,12))
            mesh[level][2]+=vv.shape[0]*vv.shape[1];mesh[level][3]+=len(selected)
    for label,texture in zip(['albedo-alpha','normal'],atlases):
        Image.fromarray(texture).save(leafdir/(name+'-'+label+'-512.png'),optimize=True)
    for level,(v,f,_,shoots) in mesh.items():
        v=np.concatenate(v);f=np.concatenate(f)
        assert np.isfinite(v).all() and f.max()<len(v)
        write_level(name,directory,level,v,f)
        stats[level]=dict(shoots=int(shoots),vertices=len(v),triangles=len(f))
    result=dict(source='https://polyhaven.com/a/'+srcname,license='CC0',sourceShootCount=count,
                distinctUVTemplates=len(templates),coverage='Photographic alpha times each original shoot UV triangle mask.',
                directVisibility='Six azimuths at 36 degrees plus zenith integrated through the full-source 96^3 leaf-area density.',
                lods=stats)
    (directory/'crown-surface.json').write_text(json.dumps(result,indent=2)+'\n')
    print(name,stats,flush=True)

for species in [('oak','tree_small_02','trees',3.5,.0241038464*3.5,5),('jacaranda','jacaranda_tree','jacaranda',1,.1466151327,6)]:
    if args.only is None or args.only==species[0]:build(*species)
