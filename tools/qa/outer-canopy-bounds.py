"""Bound the grazing outer-stand correction in a recorded native camera path.

Projects the indexed production outer stand, keeps any triangle that might
intersect the viewport and derives a conservative maximum Fresnel value over
each entire spherical triangle. The correction begins above Fresnel 0.12.
"""
import argparse
import json
from pathlib import Path
import numpy as np


def inspect(directory):
    record=json.loads((directory/'commands.json').read_text())
    width,height=record['width'],record['height']
    vao=program=bound=None
    buffers,position,index,uniform_names,matrix={},{},{},{},{}
    sun=None
    frames=[]
    triangles=None
    xyz=None
    for c in record['commands']:
        func=c['name'];a=c['args']
        if func=='bindVertexArray':vao=(a[0] or {}).get('ref')
        elif func=='bindBuffer':
            if a[0]==0x8892:bound=(a[1] or {}).get('ref')
            elif a[0]==0x8893:index[vao]=(a[1] or {}).get('ref')
        elif func=='bufferData' and isinstance(a[1],dict):
            handle=bound if a[0]==0x8892 else index[vao]
            buffers[handle]=a[1]['data']
        elif func=='vertexAttribPointer' and a[0]==0:position[vao]=bound
        elif func=='useProgram':program=a[0]['ref']
        elif func=='getUniformLocation':uniform_names[c['id']]=a[1]
        elif func=='uniformMatrix4fv' and uniform_names[a[0]['ref']]=='uViewProjection':matrix[program]=a[2]['data']
        elif func=='uniform3fv' and uniform_names[a[0]['ref']]=='uSun' and isinstance(a[1],list):sun=np.array(a[1])
        elif func=='drawElements' and a[1]==record['telemetry']['meshTriangles']['canopy']*3:
            if triangles is None:
                v=np.fromfile(directory/buffers[position[vao]],'<f4').reshape(-1,12)
                i=np.fromfile(directory/buffers[index[vao]],'<u4').reshape(-1,3)
                outer=(v[:,9]==2)&(v[:,10]>=0)
                # These components are disconnected in the production mesh.
                assert np.all(np.any(outer[i],axis=1)==np.all(outer[i],axis=1))
                triangles=i[np.all(outer[i],axis=1)]
                xyz=v[:,:3].astype(np.float64)
            vp=np.fromfile(directory/matrix[program],'<f4').reshape(4,4).T
            clip=xyz@vp[:,:3].T+vp[:,3]
            # Include a border for vertex rounding, the WebGPU temporal offset,
            # and edge coverage when selecting triangles near screen boundaries.
            w=clip[:,3]*1.004
            visible=np.ones(len(triangles),bool)
            for side in [w+clip[:,0],w-clip[:,0],w+clip[:,1],w-clip[:,1],clip[:,3]+clip[:,2],clip[:,3]-clip[:,2]]:
                visible&=np.any(side[triangles]>=-.1,axis=1)
            tri=triangles[visible]
            eye=np.asarray(record['frames'][len(frames)]['camera'])
            rays=xyz-eye;rays/=np.linalg.norm(rays,axis=1)[:,None]
            directions=rays[tri]
            center=directions.mean(axis=1);center/=np.linalg.norm(center,axis=1)[:,None]
            # All points in the spherical projection lie within the cap that
            # encloses its corners when its radius is less than 90 degrees.
            radius=np.max(np.arccos(np.clip((directions*center[:,None]).sum(axis=2),-1,1)),axis=1)
            assert np.all(radius<np.pi/2)
            angle=np.arccos(np.clip(center@sun,-1,1))
            proximity=np.cos(np.maximum(0,angle-radius-.0001))
            fresnel=.04+.96*(1-np.sqrt(np.maximum(0,.5*(1-proximity))))**5
            selected=tri[fresnel>=.12-1e-5]
            if len(selected):
                vertices=np.unique(selected)
                if np.any(clip[vertices,3]<=0):band=[0,height]
                else:
                    rows=height*(.5-.5*clip[vertices,1]/clip[vertices,3])
                    band=[max(0,int(np.floor(rows.min()))-4),min(height,int(np.ceil(rows.max()))+4)]
            else:band=None
            frames.append({'index':len(frames),'visibleOuterTriangles':len(tri),'eligibleTriangles':len(selected),
                           'fresnelUpperBound':float(fresnel.max(initial=0)),'rowRange':band})
    assert len(frames)==len(record['frames'])
    bs=[f['rowRange'] for f in frames if f['rowRange']]
    return {'width':width,'height':height,'frames':frames,
            'rowRange':[min(b[0] for b in bs),max(b[1] for b in bs)] if bs else None}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path)
    print(json.dumps(inspect(p.parse_args().directory),indent=2))
