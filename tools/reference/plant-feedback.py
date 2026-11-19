"""Capture the live release vertex shader's actual world-space plants for Cycles."""
import ctypes as c,json,os,sys
from pathlib import Path
import numpy as np
out=Path(sys.argv[1]);scene=json.loads((out/'scene.json').read_text())
src=next(command['args'][1] for command in json.loads((out/'raster-front/commands.json').read_text())['commands']
         if command['name']=='shaderSource' and 'out vec3 vPosition;' in command['args'][1])
# Surfaceless GLES3, a one-pixel surface is sufficient for transform feedback.
e=c.CDLL('libEGL.so.1');e.eglGetProcAddress.argtypes=[c.c_char_p];e.eglGetProcAddress.restype=c.c_void_p
I,U,P,F,Z=c.c_int,c.c_uint,c.c_void_p,c.c_float,c.c_ssize_t
def call(name,rt,*args):return c.CFUNCTYPE(rt,*args)(e.eglGetProcAddress(name.encode()))
d=call('eglGetPlatformDisplayEXT',P,U,P,P)(0x31dd,None,None);x=I();y=I();assert call('eglInitialize',U,P,P,P)(d,c.byref(x),c.byref(y))
assert call('eglBindAPI',U,U)(0x30a0)
cfg=P();num=I();assert call('eglChooseConfig',U,P,P,P,I,P)(d,(I*5)(0x3033,1,0x3040,0x40,0x3038),c.byref(cfg),1,c.byref(num)) and num.value
surf=call('eglCreatePbufferSurface',P,P,P,P)(d,cfg,(I*5)(0x3057,1,0x3056,1,0x3038))
cx=call('eglCreateContext',P,P,P,P,P)(d,cfg,None,(I*3)(0x3098,3,0x3038));assert call('eglMakeCurrent',U,P,P,P,P)(d,surf,surf,cx)
program=call('glCreateProgram',U)()
for source,stage in [(src,0x8b31),('#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1);}',0x8b30)]:
 sh=call('glCreateShader',U,U)(stage);buf=c.c_char_p(source.encode())
 call('glShaderSource',None,U,I,P,P)(sh,1,c.byref(buf),None);call('glCompileShader',None,U)(sh)
 yes=I();call('glGetShaderiv',None,U,U,P)(sh,0x8b81,c.byref(yes));assert yes.value,'shader failed'
 call('glAttachShader',None,U,U)(program,sh)
names=(c.c_char_p*4)(b'vPosition',b'vNormal',b'vColor',b'vExtra')
call('glTransformFeedbackVaryings',None,U,I,P,U)(program,4,names,0x8c8c)
call('glLinkProgram',None,U)(program);yes=I();call('glGetProgramiv',None,U,U,P)(program,0x8b82,c.byref(yes));assert yes.value,'feedback link failed'
call('glUseProgram',None,U)(program)
loc=lambda name:call('glGetUniformLocation',I,U,c.c_char_p)(program,name.encode())
call('glUniform1i',None,I,I)(loc('uInstanced'),1);call('glUniform3f',None,I,F,F,F)(loc('uCamera'),*scene['position'])
call('glUniform3f',None,I,F,F,F)(loc('uSun'),0,1,0);call('glUniform1f',None,I,F)(loc('uTime'),1);call('glUniform1f',None,I,F)(loc('uWind'),0)
def make_buffer(target,data,sz):
 h=U();call('glGenBuffers',None,I,P)(1,c.byref(h));call('glBindBuffer',None,U,U)(target,h)
 call('glBufferData',None,U,Z,P,U)(target,sz,data,0x88e4);return h
def attrib(index,n,stride,offset,div):
 call('glEnableVertexAttribArray',None,U)(index);call('glVertexAttribPointer',None,U,I,U,c.c_ubyte,I,P)(index,n,0x1406,0,stride,offset);call('glVertexAttribDivisor',None,U,U)(index,div)
allv=[];alli=[];count=0
call('glEnable',None,U)(0x8c89)
for i in range(5):
 verts=np.fromfile(out/(str(i)+'-vertices'),dtype='<f4').reshape(-1,12)
 inds=np.fromfile(out/(str(i)+'-indices'),dtype='<u4')
 roots=np.fromfile(out/(str(i)+'-roots'),dtype='<f4').reshape(-1,8)
 if not len(roots):continue
 buf1=make_buffer(0x8892,verts.ctypes.data,verts.nbytes)
 for k in range(4):attrib(k,3,48,k*12,0)
 buf2=make_buffer(0x8892,roots.ctypes.data,roots.nbytes);attrib(4,4,32,0,1);attrib(5,4,32,16,1)
 sz=verts.nbytes*len(roots);dest=make_buffer(0x8c8e,None,sz);call('glBindBufferBase',None,U,U,U)(0x8c8e,0,dest)
 call('glBeginTransformFeedback',None,U)(0);call('glDrawArraysInstanced',None,U,I,I,I)(0,0,len(verts),len(roots));call('glEndTransformFeedback',None)()
 ptr=call('glMapBufferRange',P,U,Z,Z,U)(0x8c8e,0,sz,1);assert ptr and call('glGetError',U)()==0
 ar=np.frombuffer(c.string_at(ptr,sz),dtype='f').reshape(-1,12);allv.append(ar)
 assert np.isfinite(ar).all() and np.all(abs(ar[:,0]-scene['position'][0])<8)
 call('glUnmapBuffer',c.c_ubyte,U)(0x8c8e)
 alli.append((inds[None,:]+np.arange(len(roots),dtype='u4')[:,None]*len(verts)+count).ravel());count+=len(ar)
 for buf in (buf1,buf2,dest):call('glDeleteBuffers',None,I,P)(1,c.byref(buf))
v=np.concatenate(allv);ind=np.concatenate(alli).reshape(-1,3)
# Far basal slices collapse to the terrain under the close modeled tier.
a,b,h=v[ind[:,0],:3],v[ind[:,1],:3],v[ind[:,2],:3]
ind=ind[np.linalg.norm(np.cross(b-a,h-a),axis=1)>1e-9]
v.tofile(out/'plants.f32');ind.tofile(out/'plants.u32');print('Exported',len(ind),'triangles,',len(v),'posed vertices.')
