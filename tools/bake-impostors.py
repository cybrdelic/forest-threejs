import ctypes as c, re, json
from pathlib import Path
E=c.CDLL('/usr/lib/x86_64-linux-gnu/libEGL.so.1')
G=None
void=c.c_void_p; integer=c.c_int; uint=c.c_uint

def bind(lib,name,restype,args):
 if lib is None:return c.CFUNCTYPE(restype,*args)(getproc(name.encode()))
 f=getattr(lib,name); f.restype=restype; f.argtypes=args; return f
getproc=bind(E,'eglGetProcAddress',void,[c.c_char_p])
platform=c.CFUNCTYPE(void,uint,void,c.POINTER(integer))(getproc(b'eglGetPlatformDisplayEXT'))
attrs=(integer*5)(0x3203,0x3450,0x3209,0x3487,0x3038)
display=platform(0x31DD,None,(integer*1)(0x3038))
init=bind(E,'eglInitialize',uint,[void,c.POINTER(integer),c.POINTER(integer)])
major=integer();minor=integer()
if not init(display,c.byref(major),c.byref(minor)):raise RuntimeError('EGL init failed '+hex(bind(E,'eglGetError',uint,[])()))
assert bind(E,'eglBindAPI',uint,[uint])(0x30A0)
config=void();count=integer()
ca=(integer*15)(0x3033,1,0x3040,0x40,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3025,24,0x3038)
assert bind(E,'eglChooseConfig',uint,[void,c.POINTER(integer),c.POINTER(void),integer,c.POINTER(integer)])(display,ca,c.byref(config),1,c.byref(count)) and count.value
surface=bind(E,'eglCreatePbufferSurface',void,[void,void,c.POINTER(integer)])(display,config,(integer*5)(0x3057,16,0x3056,16,0x3038))
context=bind(E,'eglCreateContext',void,[void,void,void,c.POINTER(integer)])(display,config,None,(integer*3)(0x3098,3,0x3038))
assert context and surface
assert bind(E,'eglMakeCurrent',uint,[void,void,void,void])(display,surface,surface,context)
getstring=bind(G,'glGetString',c.c_char_p,[uint])
print('EGL',major.value,minor.value,'GL',getstring(0x1F02).decode(),'Renderer',getstring(0x1F01).decode())
create=bind(G,'glCreateShader',uint,[uint]);source=bind(G,'glShaderSource',None,[uint,integer,c.POINTER(c.c_char_p),c.POINTER(integer)])
compile=bind(G,'glCompileShader',None,[uint]);getiv=bind(G,'glGetShaderiv',None,[uint,uint,c.POINTER(integer)]);log=bind(G,'glGetShaderInfoLog',None,[uint,integer,c.POINTER(integer),c.c_char_p])
program=bind(G,'glCreateProgram',uint,[]);attach=bind(G,'glAttachShader',None,[uint,uint]);link=bind(G,'glLinkProgram',None,[uint]);getprogram=bind(G,'glGetProgramiv',None,[uint,uint,c.POINTER(integer)]);plog=bind(G,'glGetProgramInfoLog',None,[uint,integer,c.POINTER(integer),c.c_char_p])
import numpy as np
from scipy.ndimage import gaussian_filter,map_coordinates,distance_transform_edt
from PIL import Image
import argparse,time
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--name',required=True);parser.add_argument('--raw-fixtures',action='store_true');parser.add_argument('--output',default=str(Path(__file__).resolve().parents[1]/'dist/assets/impostors'));args=parser.parse_args()
root=Path(args.source);output=Path(args.output);output.mkdir(parents=True,exist_ok=True);meta=json.loads((root/'metadata.json').read_text())
v=np.fromfile(root/'vertices.bin',np.float32).reshape(-1,9);ind=np.fromfile(root/'indices.bin',np.uint32);lo,hi=np.array(meta['bounds'],np.float32);center=np.array([0,(lo[1]+hi[1])*.5,0],np.float32)
N=96;mn=lo-1;extent=hi-lo+2;density=np.zeros((N,N,N),np.float32)
for primitive in meta['primitives']:
 if primitive['material']!=2:continue
 texture=np.asarray(Image.open(primitive['diffuse_texture']).convert('RGBA'));th,tw=texture.shape[:2]
 for first in range(primitive['indexFirst'],primitive['indexFirst']+primitive['indexCount'],300000):
  ids=ind[first:min(first+300000,primitive['indexFirst']+primitive['indexCount'])].reshape(-1,3);tri=v[ids,:3];p=tri.mean(axis=1);area=np.linalg.norm(np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]),axis=1)*.5
  uv=v[ids,6:8].mean(axis=1);px=np.mod(uv[:,0],1)*(tw-1);py=np.mod(uv[:,1],1)*(th-1);coverage=map_coordinates(texture[:,:,3].astype(np.float32)/255,[py,px],order=1,mode='nearest')
  coordinate=np.minimum(N-1,np.maximum(0,((p-mn)/extent*N).astype(int)));np.add.at(density,tuple(coordinate.T),area*coverage)
voxelvol=np.prod(extent/N);density=gaussian_filter(density,1.35)/voxelvol;optical=np.cumsum(density[:,::-1,:],axis=1)[:,::-1,:]*(extent[1]/N)*.32
sky=np.empty(len(v),np.float32)
for first in range(0,len(v),300000):
 p=((v[first:first+300000,:3]-mn)/extent*(N-1)).T;sky[first:first+300000]=np.clip(np.exp(-map_coordinates(optical,p,order=1,mode='nearest')),.13,1.)
packed=np.column_stack([v[:,:8],sky]).astype(np.float32)
print('FULL source',args.name,'triangles',len(ind)//3,'sky',np.quantile(sky,[0,.5,.9,1]),flush=True)
vs='''#version 300 es
precision highp float;layout(location=0)in vec3 position;layout(location=1)in vec3 normal;layout(location=2)in vec2 uv;layout(location=3)in float sky;
uniform vec3 uRight,uUp,uView,uCenter;uniform vec2 uSize;out vec3 vNormal;out vec2 vUV;out float vSky;out vec3 vModelPosition;
void main(){vec3 p=position-uCenter;gl_Position=vec4(dot(p,uRight)/uSize.x*2.,dot(p,uUp)/uSize.y*2.,-dot(p,uView)/64.,1.);vNormal=normal;vUV=uv;vSky=sky;vModelPosition=position;}
'''
fs='''#version 300 es
precision highp float;in vec3 vNormal;in vec2 vUV;in float vSky;in vec3 vModelPosition;uniform sampler2D uDiffuse;uniform float uCutoff;uniform vec3 uView,uModelMin,uModelExtent;
layout(location=0)out vec4 albedo;layout(location=1)out vec4 surface;layout(location=2)out vec4 modelPosition;
void main(){vec4 color=texture(uDiffuse,vUV);if(color.a<uCutoff)discard;albedo=vec4(color.rgb,1.);vec3 n=normalize(vNormal);if(dot(n,uView)<0.)n=-n;surface=vec4(n*.5+.5,vSky);modelPosition=vec4(clamp((vModelPosition-uModelMin)/uModelExtent,0.,1.),step(.1,uCutoff));}
'''
def make_shader(kind,data):
 h=create(kind);s=data.encode();source(h,1,(c.c_char_p*1)(s),(integer*1)(len(s)));compile(h);ok=integer();getiv(h,0x8B81,c.byref(ok));buf=c.create_string_buffer(8192);log(h,8192,None,buf)
 if not ok.value:raise RuntimeError(buf.value.decode())
 return h
p=program();attach(p,make_shader(0x8B31,vs));attach(p,make_shader(0x8B30,fs));link(p);ok=integer();getprogram(p,0x8B82,c.byref(ok));assert ok.value;bind(G,'glUseProgram',None,[uint])(p)
loc=bind(G,'glGetUniformLocation',integer,[uint,c.c_char_p]);set3=bind(G,'glUniform3f',None,[integer,c.c_float,c.c_float,c.c_float]);set2=bind(G,'glUniform2f',None,[integer,c.c_float,c.c_float]);setf=bind(G,'glUniform1f',None,[integer,c.c_float]);seti=bind(G,'glUniform1i',None,[integer,integer])
gen=bind(G,'glGenBuffers',None,[integer,c.POINTER(uint)]);bb=bind(G,'glBindBuffer',None,[uint,uint]);upload=bind(G,'glBufferData',None,[uint,c.c_ssize_t,void,uint]);enable=bind(G,'glEnableVertexAttribArray',None,[uint]);attr=bind(G,'glVertexAttribPointer',None,[uint,integer,uint,c.c_ubyte,integer,void]);vao=uint();bind(G,'glGenVertexArrays',None,[integer,c.POINTER(uint)])(1,c.byref(vao));bind(G,'glBindVertexArray',None,[uint])(vao)
buffers=(uint*2)();gen(2,buffers);bb(0x8892,buffers[0]);upload(0x8892,packed.nbytes,packed.ctypes.data,0x88E4)
for i,(size,offset)in enumerate([(3,0),(3,12),(2,24),(1,32)]):enable(i);attr(i,size,0x1406,0,36,void(offset))
bb(0x8893,buffers[1]);upload(0x8893,ind.nbytes,ind.ctypes.data,0x88E4)
bt=bind(G,'glBindTexture',None,[uint,uint]);ti=bind(G,'glTexImage2D',None,[uint,integer,integer,integer,integer,integer,uint,uint,void]);param=bind(G,'glTexParameteri',None,[uint,uint,integer]);gentex=bind(G,'glGenTextures',None,[integer,c.POINTER(uint)])
source_textures=[]
for primitive in meta['primitives']:
 texture=uint();gentex(1,c.byref(texture));bt(0x0DE1,texture);image=np.asarray(Image.open(primitive['diffuse_texture']).convert('RGBA')).copy();ti(0x0DE1,0,0x8C43,image.shape[1],image.shape[0],0,0x1908,0x1401,image.ctypes.data);bind(G,'glGenerateMipmap',None,[uint])(0x0DE1);param(0x0DE1,0x2801,0x2703);param(0x0DE1,0x2800,0x2601);param(0x0DE1,0x2802,0x2901);param(0x0DE1,0x2803,0x2901);source_textures.append(texture)
F=uint();bind(G,'glGenFramebuffers',None,[integer,c.POINTER(uint)])(1,c.byref(F));bind(G,'glBindFramebuffer',None,[uint,uint])(0x8D40,F)
tex=(uint*3)();gentex(3,tex);attachtex=bind(G,'glFramebufferTexture2D',None,[uint,uint,uint,uint,integer]);CELL=512;W,H=CELL*8,CELL*2
for i in range(3):bt(0x0DE1,tex[i]);ti(0x0DE1,0,0x8058,W,H,0,0x1908,0x1401,None);param(0x0DE1,0x2801,0x2600);param(0x0DE1,0x2800,0x2600);attachtex(0x8D40,0x8CE0+i,0x0DE1,tex[i],0)
rb=uint();bind(G,'glGenRenderbuffers',None,[integer,c.POINTER(uint)])(1,c.byref(rb));bind(G,'glBindRenderbuffer',None,[uint,uint])(0x8D41,rb);bind(G,'glRenderbufferStorage',None,[uint,uint,integer,integer])(0x8D41,0x81A6,W,H);bind(G,'glFramebufferRenderbuffer',None,[uint,uint,uint,uint])(0x8D40,0x8D00,0x8D41,rb)
bind(G,'glDrawBuffers',None,[integer,c.POINTER(uint)])(3,(uint*3)(0x8CE0,0x8CE1,0x8CE2));assert bind(G,'glCheckFramebufferStatus',uint,[uint])(0x8D40)==0x8CD5
bind(G,'glEnable',None,[uint])(0x0B71);bind(G,'glDepthFunc',None,[uint])(0x0201);bind(G,'glClearColor',None,[c.c_float]*4)(0,0,0,0);bind(G,'glClear',None,[uint])(0x4100)
viewport=bind(G,'glViewport',None,[integer]*4);draw=bind(G,'glDrawElements',None,[uint,integer,uint,void]);size=[float(max(abs(lo[0]),abs(hi[0]),abs(lo[2]),abs(hi[2]))*2+1.2),float(hi[1]-lo[1]+5.)]
seti(loc(p,b'uDiffuse'),0);set3(loc(p,b'uModelMin'),*map(float,lo));set3(loc(p,b'uModelExtent'),*map(float,hi-lo))
for e,el in enumerate([0.,25.]):
 for a in range(8):
  az=a*np.pi/4.;elevation=el*np.pi/180.;view=np.array([np.sin(az)*np.cos(elevation),np.sin(elevation),np.cos(az)*np.cos(elevation)]);right=np.array([np.cos(az),0,-np.sin(az)]);up=np.cross(view,right)
  viewport(a*CELL,e*CELL,CELL,CELL)
  for key,value in [('uRight',right),('uUp',up),('uView',view),('uCenter',center)]:set3(loc(p,key.encode()),*map(float,value))
  set2(loc(p,b'uSize'),*size)
  for primitive,texture in zip(meta['primitives'],source_textures):
   bt(0x0DE1,texture);setf(loc(p,b'uCutoff'),primitive['alpha_cutoff']);draw(4,primitive['indexCount'],0x1405,void(primitive['indexFirst']*4))
  print('Rendered',args.name,e,a,flush=True)
bind(G,'glFinish',None,[])();read=bind(G,'glReadPixels',None,[integer,integer,integer,integer,uint,uint,void]);readbuf=bind(G,'glReadBuffer',None,[uint]);images=[]
for attachment in range(3):
 readbuf(0x8CE0+attachment);pixels=np.empty((H,W,4),np.uint8);read(0,0,W,H,0x1908,0x1401,pixels.ctypes.data);images.append(pixels[::-1].copy().astype(np.float32)/255)
# Premultiplied supersample resolve preserves tiny true-alpha leaflets.
color,normal,model_position=images;weights=color[:,:,3];coverage=weights.reshape(H//2,2,W//2,2).sum(axis=(1,3));divisor=np.maximum(.00001,coverage)
resolved_color=(color[:,:,:3]*weights[:,:,None]).reshape(H//2,2,W//2,2,3).sum(axis=(1,3))/divisor[:,:,None]
resolved_normal=((normal[:,:,:3]*2-1)*weights[:,:,None]).reshape(H//2,2,W//2,2,3).sum(axis=(1,3))/divisor[:,:,None]
resolved_sky=(normal[:,:,3]*weights).reshape(H//2,2,W//2,2).sum(axis=(1,3))/divisor
resolved_position=(model_position*weights[:,:,None]).reshape(H//2,2,W//2,2,4).sum(axis=(1,3))/divisor[:,:,None]
arrays=[np.dstack([resolved_color,coverage*.25]),np.dstack([resolved_normal*.5+.5,resolved_sky]),resolved_position]
for attachment,pixels in enumerate(arrays):
 for row in range(2):
  for column in range(8):
   region=pixels[row*256:(row+1)*256,column*256:(column+1)*256];mask=coverage[row*256:(row+1)*256,column*256:(column+1)*256]>.01
   nearest=distance_transform_edt(~mask,return_distances=False,return_indices=True);filled=region[tuple(nearest)]
   if attachment==0:region[:,:,:3]=filled[:,:,:3]
   else:region[:]=filled
 pixels=np.round(np.clip(pixels,0,1)*255).astype(np.uint8);name=['albedo','normal','position'][attachment];Image.fromarray(pixels,'RGBA').save(output/(args.name+'-'+name+'.png'),optimize=True);
 if args.raw_fixtures:pixels.tofile(output/(args.name+'-'+name+'.bin'))
result={'name':args.name,'width':2048,'height':512,'columns':8,'rows':2,'cellSize':256,'projectionSize':size,'center':center.tolist(),'elevationRows':[25*np.pi/180,0.],'source':meta['source_url'],'license':'CC0','sourceMesh':'Full unreduced original geometry with official photographic diffuse PNG/JPEG and authored embedded RGBA8 leaf alpha','colorSpace':'linear RGBA8 albedo, alpha 2x supersampled coverage','normalSpace':'model XYZ normal oriented toward baked camera before coverage-weighted averaging, encoded [0,1]; alpha upward canopy visibility; vector length retains unresolved normal variance','positionSpace':'model XYZ normalized within sourceBounds; alpha leaf fraction (1 leaf, 0 wood)','triangles':len(ind)//3,'sourceBounds':[lo.tolist(),hi.tolist()],'leafBounds':[v[v[:,8]>1.5,:3].min(0).tolist(),v[v[:,8]>1.5,:3].max(0).tolist()]}
(output/(args.name+'.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True);print('Coverage',float((coverage>.1).mean()),'GLerror',hex(bind(G,'glGetError',uint,[])()),flush=True)
