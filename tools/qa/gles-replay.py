import ctypes as c,json,time,sys,os,resource
from pathlib import Path
from PIL import Image
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]/'qa-output/gles';record=json.loads((root/'commands.json').read_text());width=record['width'];height=record['height']
# Optional output window in top-left, full-resolution pixels. Restrict the
# final draw target only. Both shadow passes, scene projection, LOD and texture
# derivatives still correspond to the complete application viewport.
virtual_width,virtual_height=width,height
crop=None
scissor=None
if 'TEST_SCISSOR' in os.environ:
 scissor=list(map(int,os.environ['TEST_SCISSOR'].split(',')))
 assert len(scissor)==4 and 'TEST_CROP' not in os.environ
 sx,sy,sw,sh=scissor
 assert sx>=0 and sy>=0 and sw>0 and sh>0 and sx+sw<=width and sy+sh<=height
if 'TEST_CROP' in os.environ:
 crop=list(map(int,os.environ['TEST_CROP'].split(',')))
 assert len(crop)==4, 'TEST_CROP expects x,y,width,height'
 x,y,width,height=crop
 assert width>0 and height>0 and x>=0 and y>=0 and x+width<=virtual_width and y+height<=virtual_height
 assert record['requestedSamples']>0, 'Crop mode needs the native default MSAA target'
E=c.CDLL('/usr/lib/x86_64-linux-gnu/libEGL.so.1');void=c.c_void_p;integer=c.c_int;uint=c.c_uint;flt=c.c_float;boolean=c.c_ubyte
getproc=E.eglGetProcAddress;getproc.restype=void;getproc.argtypes=[c.c_char_p]
def bind(name,result,args):return c.CFUNCTYPE(result,*args)(getproc(name.encode()))
platform=c.CFUNCTYPE(void,uint,void,c.POINTER(integer))(getproc(b'eglGetPlatformDisplayEXT'));display=platform(0x31dd,None,(integer*1)(0x3038))
E.eglInitialize.restype=uint;E.eglInitialize.argtypes=[void,c.POINTER(integer),c.POINTER(integer)];major=integer();minor=integer();assert E.eglInitialize(display,c.byref(major),c.byref(minor))
E.eglBindAPI.restype=uint;E.eglBindAPI.argtypes=[uint];assert E.eglBindAPI(0x30a0)
E.eglChooseConfig.restype=uint;E.eglChooseConfig.argtypes=[void,c.POINTER(integer),c.POINTER(void),integer,c.POINTER(integer)];config=void();count=integer()
requested_samples=int(os.environ.get('TEST_MSAA',record.get('requestedSamples',4)))
if 'requestedSamples' in record:
 assert requested_samples==record['requestedSamples'],'Replay must use the recorded sample count'
for candidate in dict.fromkeys([requested_samples,0]):
 attrs=[0x3033,1,0x3040,0x40,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3025,24,0x3031,candidate,0x3038]
 if E.eglChooseConfig(display,(integer*len(attrs))(*attrs),c.byref(config),1,c.byref(count)) and count.value:break
assert count.value,'No EGL configuration supports the requested color and depth formats'
E.eglCreatePbufferSurface.restype=void;E.eglCreatePbufferSurface.argtypes=[void,void,c.POINTER(integer)];surface=E.eglCreatePbufferSurface(display,config,(integer*5)(0x3057,width,0x3056,height,0x3038))
E.eglCreateContext.restype=void;E.eglCreateContext.argtypes=[void,void,void,c.POINTER(integer)];context=E.eglCreateContext(display,config,None,(integer*3)(0x3098,3,0x3038));assert context
E.eglMakeCurrent.restype=uint;E.eglMakeCurrent.argtypes=[void,void,void,void];assert E.eglMakeCurrent(display,surface,surface,context)
get_string=bind('glGetString',c.c_char_p,[uint])
adapter_name=get_string(0x1f01).decode()
gl_version=get_string(0x1f02).decode()
print('Native EGL',major.value,minor.value,adapter_name,flush=True)
U=uint;I=integer;B=boolean;F=flt;P=void;Z=c.c_ssize_t
signatures={
'activeTexture':[U],'attachShader':[U,U],'bindBuffer':[U,U],'bindFramebuffer':[U,U],'bindTexture':[U,U],'bindVertexArray':[U],'compileShader':[U],'deleteProgram':[U],'deleteShader':[U],'depthMask':[B],'disable':[U],'drawArrays':[U,I,I],'drawElements':[U,I,U,P],'drawElementsInstanced':[U,I,U,P,I],'enable':[U],'enableVertexAttribArray':[U],'framebufferTexture2D':[U,U,U,U,I],'linkProgram':[U],'polygonOffset':[F,F],'readBuffer':[U],'texImage2D':[U,I,I,I,I,I,U,U,P],'texImage3D':[U,I,I,I,I,I,I,U,U,P],'texParameteri':[U,U,I],'uniform1f':[I,F],'uniform1i':[I,I],'useProgram':[U],'vertexAttribDivisor':[U,U],'vertexAttribPointer':[U,I,U,B,I,P],'viewport':[I,I,I,I],'clear':[U],'clearColor':[F,F,F,F]
}
signatures.update({'bindRenderbuffer':[U,U],'renderbufferStorageMultisample':[U,I,U,I,I],'renderbufferStorage':[U,U,I,I],'framebufferRenderbuffer':[U,U,U,U],'blitFramebuffer':[I,I,I,I,I,I,I,I,U,U],'scissor':[I,I,I,I]})
functions={k:bind('gl'+k[0].upper()+k[1:],None,v)for k,v in signatures.items()}
handles={};blobs={};errors=[]
# GLES upload calls consume client pointers before returning. Free a binary
# payload immediately after its last recorded call, instead of retaining two
# complete copies of tree geometry, material mips and per-frame transforms.
last_blob_use={}
for n,cmd in enumerate(record['commands']):
 for arg in cmd['args']:
  if isinstance(arg,dict) and 'data' in arg:last_blob_use[arg['data']]=n
flush_indices=int(os.environ.get('TEST_FLUSH_INDICES','0'))
pending_indices=0
geterror=bind('glGetError',U,[]);shaderparam=bind('glGetShaderiv',None,[U,U,c.POINTER(I)]);programparam=bind('glGetProgramiv',None,[U,U,c.POINTER(I)])
def decode(arg):
 if isinstance(arg,dict):
  if 'ref'in arg:return handles[arg['ref']]
  if 'data'in arg:
   path=arg['data']
   if path not in blobs:blobs[path]=c.create_string_buffer((root/path).read_bytes())
   return blobs[path]
 return arg
frames_by_end={frame['endCommand']:frame for frame in record.get('frames',[])}
frame_limit=int(os.environ.get('TEST_FRAME_LIMIT',len(frames_by_end)))
assert 1<=frame_limit<=len(frames_by_end) if frames_by_end else frame_limit==0
capture_many=len(frames_by_end)>1
timings=[]
# Use explicitly owned draw and resolve framebuffers. A headless EGL
# multisample pbuffer may defer its front/back resolve until a window swap.
max_samples=I()
bind('glGetIntegerv',None,[U,c.POINTER(I)])(0x8d57,c.byref(max_samples))
samples=I(min(max_samples.value,requested_samples))
assert samples.value==requested_samples,'Driver sample count cannot fulfill the recorded request'
print('Framebuffer samples',samples.value,flush=True)
resolve_framebuffer=U()
draw_framebuffer=U()
if samples.value:
 def make_framebuffer():
  handle=U();bind('glGenFramebuffers',None,[I,c.POINTER(U)])(1,c.byref(handle))
  functions['bindFramebuffer'](0x8d40,handle.value)
  return handle
 draw_framebuffer=make_framebuffer()
 # The production WebGL canvas requests alpha:false. An RGB8 attachment
 # still uses fragment alpha for sample coverage while readback remains opaque.
 for format,attachment in [(0x8051,0x8ce0),(0x81a6,0x8d00)]:
  renderbuffer=U()
  bind('glGenRenderbuffers',None,[I,c.POINTER(U)])(1,c.byref(renderbuffer))
  bind('glBindRenderbuffer',None,[U,U])(0x8d41,renderbuffer.value)
  bind('glRenderbufferStorageMultisample',None,[U,I,U,I,I])(0x8d41,samples.value,format,width,height)
  bind('glFramebufferRenderbuffer',None,[U,U,U,U])(0x8d40,attachment,0x8d41,renderbuffer.value)
 assert bind('glCheckFramebufferStatus',U,[U])(0x8d40)==0x8cd5
 resolve_framebuffer=make_framebuffer()
 resolve_texture=U()
 bind('glGenTextures',None,[I,c.POINTER(U)])(1,c.byref(resolve_texture))
 functions['bindTexture'](0x0de1,resolve_texture.value)
 functions['texImage2D'](0x0de1,0,0x8051,width,height,0,0x1907,0x1401,None)
 functions['framebufferTexture2D'](0x8d40,0x8ce0,0x0de1,resolve_texture.value,0)
 assert bind('glCheckFramebufferStatus',U,[U])(0x8d40)==0x8cd5
 functions['bindFramebuffer'](0x8d40,draw_framebuffer.value)
 functions['bindTexture'](0x0de1,0)
def read_target(file):
 if samples.value:
  functions['bindFramebuffer'](0x8ca8,draw_framebuffer.value)
  functions['bindFramebuffer'](0x8ca9,resolve_framebuffer.value)
  bind('glBlitFramebuffer',None,[I,I,I,I,I,I,I,I,U,U])(0,0,width,height,0,0,width,height,0x4000,0x2600)
  functions['bindFramebuffer'](0x8ca8,resolve_framebuffer.value)
 data=(c.c_ubyte*(width*height*4))()
 bind('glReadPixels',None,[I,I,I,I,U,U,P])(0,0,width,height,0x1908,0x1401,data)
 if samples.value:functions['bindFramebuffer'](0x8d40,draw_framebuffer.value)
 assert geterror()==0,'GLES frame readback failed'
 image=Image.frombytes('RGBA',(width,height),bytes(data)).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
 if scissor is not None:image=image.crop((sx,sy,sx+sw,sy+sh))
 assert image.getchannel('A').getextrema()==(255,255),'Incomplete alpha in native scene capture'
 assert max(high-low for low,high in image.getextrema()[:3])>16,'Flat native scene capture'
 image.save(file,compress_level=1)
start=time.time()
frame_start=start
default_target=False
for n,command in enumerate(record['commands']):
 name=command['name'];raw=command['args'];a=[decode(x)for x in raw]
 if name=='bindFramebuffer' and a[0] in [0x8d40,0x8ca9]:
  default_target=a[1] is None
  if scissor is not None:
   if default_target:
    functions['enable'](0x0c11);functions['scissor'](sx,height-sy-sh,sw,sh)
   else:functions['disable'](0x0c11)
 if name=='viewport' and default_target and crop is not None:
  assert a==[0,0,virtual_width,virtual_height]
  functions['viewport'](-crop[0],-(virtual_height-crop[1]-height),virtual_width,virtual_height)
 elif name=='bindFramebuffer' and a[1] is None:
  functions['bindFramebuffer'](a[0],draw_framebuffer.value)
 elif name.startswith('create'):
  kind=name[6:]
  if kind in ['Shader','Program']:
   f=bind('glCreate'+kind,U,[U]if kind=='Shader'else[]);h=f(*a)
  else:
   h=U();bind('glGen'+{'Buffer':'Buffers','Texture':'Textures','VertexArray':'VertexArrays','Framebuffer':'Framebuffers','Renderbuffer':'Renderbuffers'}[kind],None,[I,c.POINTER(U)])(1,c.byref(h));h=h.value
  handles[command['id']]=h
 elif name=='getUniformLocation':handles[command['id']]=bind('glGetUniformLocation',I,[U,c.c_char_p])(a[0],a[1].encode())
 elif name=='shaderSource':
  data=a[1].encode();strings=(c.c_char_p*1)(data);bind('glShaderSource',None,[U,I,c.POINTER(c.c_char_p),c.POINTER(I)])(a[0],1,strings,(I*1)(len(data)))
 elif name=='bufferData':
  if isinstance(raw[1],dict):size=raw[1]['bytes'];data=a[1]
  else:size=a[1];data=None
  bind('glBufferData',None,[U,Z,P,U])(a[0],size,data,a[2])
 elif name=='bufferSubData':bind('glBufferSubData',None,[U,Z,Z,P])(a[0],a[1],raw[2]['bytes'],a[2])
 elif name=='uniformMatrix4fv':bind('glUniformMatrix4fv',None,[I,I,B,P])(a[0],1,a[1],a[2])
 elif name=='uniform3fv':
  data=(F*len(a[1]))(*a[1])if isinstance(a[1],list)else a[1];bind('glUniform3fv',None,[I,I,P])(a[0],1,data)
 elif name=='drawBuffers':bind('glDrawBuffers',None,[I,c.POINTER(U)])(len(a[0]),(U*len(a[0]))(*a[0]))
 elif name in ['deleteBuffer','deleteTexture','deleteVertexArray','deleteFramebuffer','deleteRenderbuffer']:
  bind('glDelete'+{'deleteBuffer':'Buffers','deleteTexture':'Textures','deleteVertexArray':'VertexArrays','deleteFramebuffer':'Framebuffers','deleteRenderbuffer':'Renderbuffers'}[name],None,[I,c.POINTER(U)])(1,c.byref(U(a[0])))
 else:functions[name](*[0 if x is None and signatures[name][i]in[U,I]else x for i,x in enumerate(a)])
 for arg in raw:
  if isinstance(arg,dict) and 'data' in arg and last_blob_use[arg['data']]==n:blobs.pop(arg['data'],None)
 if flush_indices and name in ['drawElements','drawElementsInstanced']:
  pending_indices+=a[1]*(a[4] if name=='drawElementsInstanced' else 1)
  if pending_indices>=flush_indices:
   bind('glFinish',None,[])()
   pending_indices=0
 if name in ['compileShader','linkProgram']:
  valid=I();(shaderparam if name=='compileShader'else programparam)(a[0],0x8b81 if name=='compileShader'else 0x8b82,c.byref(valid))
  if not valid.value:
   msg=c.create_string_buffer(16384);bind('glGetShaderInfoLog'if name=='compileShader'else'glGetProgramInfoLog',None,[U,I,c.POINTER(I),c.c_char_p])(a[0],16384,None,msg);raise Exception(name+msg.value.decode())
 err=geterror()
 if err:errors.append({'command':n,'name':name,'error':hex(err)})
 if name.startswith('draw') and not capture_many:print('Draw',n,name,'elapsed',round(time.time()-start,1),flush=True)
 if n+1 in frames_by_end:
  frame=frames_by_end[n+1]
  bind('glFinish',None,[])()
  timings.append(time.time()-frame_start)
  if capture_many:
   read_target(root/('frame-%04d.png'%frame['index']))
   print('Frame',frame['index'],'seconds',round(timings[-1],3),flush=True)
  frame_start=time.time()
  if len(timings)>=frame_limit:break
bind('glFinish',None,[])()
read_target(root/('fallback-'+record.get('scene','meadow')+'.png'))
metadata={'viewport':[virtual_width,virtual_height],'crop':crop,'savedScissor':scissor,'settings':record.get('settings'),'startTime':record.get('startTime',1),'width':width,'height':height,'elapsed':time.time()-start,'errors':errors,'telemetry':record['telemetry'],'frames':record.get('frames',[])[:frame_limit],'frameRate':record.get('frameRate'),'frameSeconds':timings,'samples':samples.value,'nativePeakResidentMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'sourceHashes':record.get('sourceHashes',{}),'fetchedAssets':record.get('fetchedAssets',{}),'adapter':adapter_name,'api':gl_version}
(root/('result-'+record.get('scene','meadow')+'.json')).write_text(json.dumps(metadata,indent=2))
print('Result',len(errors),'errors','elapsed',round(metadata['elapsed'],2),flush=True)
assert not errors
