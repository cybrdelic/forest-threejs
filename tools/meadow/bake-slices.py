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
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--name',required=True);parser.add_argument('--raw-fixtures',action='store_true');parser.add_argument('--output',default=str(Path(__file__).resolve().parents[2]/'qa-output/meadow/baked'));args=parser.parse_args()
root=Path(args.source);output=Path(args.output);output.mkdir(parents=True,exist_ok=True);meta=json.loads((root/'metadata.json').read_text())
v=np.fromfile(root/'vertices.bin',np.float32).reshape(-1,9);ind=np.fromfile(root/'indices.bin',np.uint32);lo,hi=np.array(meta['bounds'],np.float32);center=np.array([0,(lo[1]+hi[1])*.5,0],np.float32)
packed=np.column_stack([v[:,:8],np.ones(len(v))]).astype(np.float32)
vs='''#version 300 es
precision highp float;layout(location=0)in vec3 position;layout(location=1)in vec3 normal;layout(location=2)in vec2 uv;layout(location=3)in float sky;
uniform vec3 uRight,uUp,uView,uCenter;uniform vec2 uSize;out vec3 vNormal;out vec2 vUV;out float vSky;out vec3 vWorld;out vec3 vModelPosition;
void main(){vec3 p=position-uCenter;gl_Position=vec4(dot(p,uRight)/uSize.x*2.,dot(p,uUp)/uSize.y*2.,-dot(p,uView)/64.,1.);vNormal=normal;vUV=uv;vSky=sky;vWorld=position;vModelPosition=position;}
'''
fs='''#version 300 es
precision highp float;
in vec3 vNormal;in vec2 vUV;in float vSky;in vec3 vWorld;
uniform sampler2D uDiffuse;uniform float uCutoff;uniform vec3 uView,uRight;uniform vec2 uSlab;
layout(location=0)out vec4 albedo;layout(location=1)out vec4 surface;layout(location=2)out vec4 modelPosition;
void main(){
 float depth=dot(vWorld,uView);
 if(depth<uSlab.x||depth>=uSlab.y||max(abs(vWorld.x),abs(vWorld.z))>.3||vWorld.y<0.||vWorld.y>.38)discard;
 vec4 color=texture(uDiffuse,vUV);if(color.a<uCutoff)discard;
 vec3 n=normalize(vNormal);if(dot(n,uView)<0.)n=-n;
 vec3 up=cross(uView,uRight);vec3 tangent=vec3(dot(n,uRight),-dot(n,up),dot(n,uView));
 albedo=vec4(color.rgb,1.);surface=vec4(tangent*.5+.5,1.);modelPosition=vec4(0.,0.,0.,1.);
}
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
# Filter source photographic RGB in linear light weighted by authored opacity.
# Raw transparent photograph RGB can be white and must never tint opaque foliage.
def resize_scalar(channel,size):
 return np.asarray(Image.fromarray(channel.astype(np.float32),mode='F').resize((size,size),Image.Resampling.BOX))
def to_linear(channel):return np.where(channel<=.04045,channel/12.92,((channel+.055)/1.055)**2.4)
def to_srgb(channel):return np.where(channel<=.0031308,channel*12.92,1.055*np.maximum(channel,0)**(1/2.4)-.055)
source_textures=[]
for primitive in meta['primitives']:
 texture=uint();gentex(1,c.byref(texture));bt(0x0DE1,texture)
 original=np.asarray(Image.open(primitive['diffuse_texture']).convert('RGBA'),np.float32)/255
 opacity=original[:,:,3];rgb=to_linear(original[:,:,:3]);valid=opacity>.9
 if not valid.any():valid=opacity>.5
 nearest=distance_transform_edt(~valid,return_distances=False,return_indices=True);rgb[~valid]=rgb[nearest[0][~valid],nearest[1][~valid]]
 level=0;side=original.shape[0]
 while side>=1:
  alpha=resize_scalar(opacity,side)
  weighted=np.stack([resize_scalar(rgb[:,:,i]*opacity,side)for i in range(3)],axis=2)
  color=weighted/np.maximum(alpha[:,:,None],1e-8)
  occupied=alpha>1e-5
  if occupied.any():
   nearest=distance_transform_edt(~occupied,return_distances=False,return_indices=True);color[~occupied]=color[nearest[0][~occupied],nearest[1][~occupied]]
  image=np.round(np.clip(np.dstack([to_srgb(color),alpha]),0,1)*255).astype(np.uint8)
  ti(0x0DE1,level,0x8C43,side,side,0,0x1908,0x1401,image.ctypes.data)
  level+=1;side//=2
 param(0x0DE1,0x2801,0x2703);param(0x0DE1,0x2800,0x2601);param(0x0DE1,0x2802,0x2901);param(0x0DE1,0x2803,0x2901);source_textures.append(texture)
F=uint();bind(G,'glGenFramebuffers',None,[integer,c.POINTER(uint)])(1,c.byref(F));bind(G,'glBindFramebuffer',None,[uint,uint])(0x8D40,F)
tex=(uint*3)();gentex(3,tex);attachtex=bind(G,'glFramebufferTexture2D',None,[uint,uint,uint,uint,integer]);CELL=256;W,H=CELL*4,CELL*4
for i in range(3):bt(0x0DE1,tex[i]);ti(0x0DE1,0,0x8058,W,H,0,0x1908,0x1401,None);param(0x0DE1,0x2801,0x2600);param(0x0DE1,0x2800,0x2600);attachtex(0x8D40,0x8CE0+i,0x0DE1,tex[i],0)
rb=uint();bind(G,'glGenRenderbuffers',None,[integer,c.POINTER(uint)])(1,c.byref(rb));bind(G,'glBindRenderbuffer',None,[uint,uint])(0x8D41,rb);bind(G,'glRenderbufferStorage',None,[uint,uint,integer,integer])(0x8D41,0x81A6,W,H);bind(G,'glFramebufferRenderbuffer',None,[uint,uint,uint,uint])(0x8D40,0x8D00,0x8D41,rb)
bind(G,'glDrawBuffers',None,[integer,c.POINTER(uint)])(3,(uint*3)(0x8CE0,0x8CE1,0x8CE2));assert bind(G,'glCheckFramebufferStatus',uint,[uint])(0x8D40)==0x8CD5
bind(G,'glEnable',None,[uint])(0x0B71);bind(G,'glDepthFunc',None,[uint])(0x0201);bind(G,'glClearColor',None,[c.c_float]*4)(0,0,0,0);bind(G,'glClear',None,[uint])(0x4100)
viewport=bind(G,'glViewport',None,[integer]*4);draw=bind(G,'glDrawElements',None,[uint,integer,uint,void]);size=[float(max(abs(lo[0]),abs(hi[0]),abs(lo[2]),abs(hi[2]))*2+1.2),float(hi[1]-lo[1]+5.)]
seti(loc(p,b'uDiffuse'),0);set3(loc(p,b'uModelMin'),*map(float,lo));set3(loc(p,b'uModelExtent'),*map(float,hi-lo))
slices=[]
for tile in range(16):
 if tile<6:axis='z';view=np.array([0.,0.,1.]);right=np.array([1.,0.,0.]);lower=-.3+(tile%6)*.1;upper=lower+.1;size=[.6,.38]
 elif tile<12:axis='x';view=np.array([1.,0.,0.]);right=np.array([0.,0.,-1.]);lower=-.3+((tile-6)%6)*.1;upper=lower+.1;size=[.6,.38]
 else:axis='y';view=np.array([0.,1.,0.]);right=np.array([1.,0.,0.]);lower=(tile-12)*.095;upper=lower+.095;size=[.6,.6]
 up=np.cross(view,right);viewport((tile%4)*CELL,(3-tile//4)*CELL,CELL,CELL)
 for key,value in [('uRight',right),('uUp',up),('uView',view),('uCenter',center)]:set3(loc(p,key.encode()),*map(float,value))
 set2(loc(p,b'uSize'),*size);set2(loc(p,b'uSlab'),lower,upper)
 for primitive,texture in zip(meta['primitives'],source_textures):
  bt(0x0DE1,texture);setf(loc(p,b'uCutoff'),primitive['alpha_cutoff']);draw(4,primitive['indexCount'],0x1405,void(primitive['indexFirst']*4))
 slices.append({'tile':tile,'axis':axis,'lower':lower,'upper':upper,'view':view.tolist(),'right':right.tolist(),'up':up.tolist(),'size':size})
 print('slice',args.name,tile,flush=True)
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
for attachment,pixels in enumerate(arrays[:2]):
 for row in range(4):
  for column in range(4):
   region=pixels[row*128:(row+1)*128,column*128:(column+1)*128];mask=coverage[row*128:(row+1)*128,column*128:(column+1)*128]>.01
   nearest=distance_transform_edt(~mask,return_distances=False,return_indices=True);filled=region[tuple(nearest)]
   if attachment==0:region[:,:,:3]=filled[:,:,:3]
   else:region[:]=filled
 
 if attachment==0:pixels[:,:,:3]=np.where(pixels[:,:,:3]<=.0031308,pixels[:,:,:3]*12.92,1.055*np.maximum(pixels[:,:,:3],0)**(1/2.4)-.055)
 pixels=np.round(np.clip(pixels,0,1)*255).astype(np.uint8);name=['albedo-alpha-512','normal-512'][attachment];Image.fromarray(pixels,'RGBA').save(output/(args.name+'-'+name+'.png'),optimize=True);
 if args.raw_fixtures:pixels.tofile(output/(args.name+'-'+name+'.bin'))
material=7 if args.name=='bermuda' else 8
vertices=[];indices=[]
for item in slices:
 tile=item['tile'];view=np.array(item['view']);right=np.array(item['right']);up=np.array(item['up']);width,height=item['size'];depth=(item['lower']+item['upper'])*.5
 center=np.array([0.,.19,0.]) if item['axis']!='y' else np.zeros(3);center+=view*depth;first=len(vertices)
 for horizontal,vertical in [(0,1),(1,1),(1,0),(0,0)]:
  position=center+right*(horizontal-.5)*width+up*(.5-vertical)*height;inset=.5/512
  u=(tile%4+horizontal)/4+(inset if horizontal==0 else -inset);vv=(tile//4+vertical)/4+(inset if vertical==0 else -inset)
  vertices.append([*position,*view,1,1,1,material,u,vv])
 indices.extend([first,first+1,first+2,first,first+2,first+3])
vertices=np.array(vertices,np.float32);indices=np.array(indices,np.uint32);vertices.tofile(output/(args.name+'-vertices.bin'));indices.tofile(output/(args.name+'-indices.bin'))
record={'name':args.name,'sourceAsset':'grass_medium_01','source_url':meta['source_url'],'license':'CC0','license_url':'https://polyhaven.com/license','authors':{'Rob Tuytel':'Photography','Rico Cilliers':'Modeling'},'material':material,'array_layer':material-2,'vertex_stride_floats':12,'vertices':64,'triangles':32,'bounds':[vertices[:,:3].min(0).tolist(),vertices[:,:3].max(0).tolist()],'sourcePlantCount':64,'sourceTriangleCount':meta['native_source_triangles'],'unclippedSourceLeafAreaIndex':meta['unclippedLeafAreaIndex'],'representation':'16 genuine source-geometry depth slabs:6X,6Z,4Y','atlasSize':[512,512],'atlasCells':[4,4],'cellPixels':128,'supersampling':2,'albedoColorSpace':'sRGB with linear opacity','normalSpace':'Tangent card basis right,-up,captureview. UVV=0top,1bottom; source normal oriented toward capture before AA.','slices':slices}
(output/(args.name+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record),flush=True)
error=bind(G,'glGetError',uint,[])();assert error==0,hex(error)
