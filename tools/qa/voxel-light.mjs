// Exercise production injection, including cloud-mask sampling, directional
// slope cosines, the foliage orientation average, and deeply buried ground.
import {create,globals} from 'webgpu';
import assert from 'node:assert/strict';
import {volumeShader} from '../../dist/shaders.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
const adapter=await gpu.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();device.pushErrorScope('validation');
const module=device.createShaderModule({code:volumeShader});
const compilation=await module.getCompilationInfo();assert.deepEqual(compilation.messages.filter(m=>m.type==='error'),[]);
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'light'}});
const sampled=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST;
const occ=device.createTexture({size:[64,64,64],dimension:'3d',format:'rgba8unorm',usage:sampled});
const cloud=device.createTexture({size:[1,1],format:'r8unorm',usage:sampled});
const output=device.createTexture({size:[64,64,64],dimension:'3d',format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
const input=new Uint8Array(64**3*4);
const probes=[[4,12,4,128,128,255,230],[24,12,4,230,128,255,230],[44,12,4,26,128,255,230],[4,12,30,32,46,13,170],[28,12,30,0,0,0,255]];
for(const [x,y,z,...data] of probes)input.set(data,(x+y*64+z*4096)*4);
device.queue.writeTexture({texture:occ},input,{bytesPerRow:256,rowsPerImage:64},[64,64,64]);
const uniforms=device.createBuffer({size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const g0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniforms}}]});
const g1=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{binding:0,resource:occ.createView()},{binding:1,resource:output.createView()},{binding:2,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},{binding:3,resource:cloud.createView()}]});
const staging=device.createBuffer({size:probes.length*256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
function half(x){const e=x>>10&31,m=x&1023;return e===0?m*2**-24:(1+m/1024)*2**(e-15);}
async function sample(elevation,transmittance,procedural=false) {
 const f=new Float32Array(96);f.set([Math.cos(elevation),Math.sin(elevation),0,0],52);f[62]=+procedural;
 device.queue.writeBuffer(uniforms,0,f);device.queue.writeTexture({texture:cloud},new Uint8Array([transmittance]),{},[1,1]);
 const encoder=device.createCommandEncoder();const p=encoder.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,g0);p.setBindGroup(1,g1);p.dispatchWorkgroups(16,16,16);p.end();
 probes.forEach(([x,y,z],i)=>encoder.copyTextureToBuffer({texture:output,origin:[x,y,z]},{buffer:staging,offset:i*256},[1,1,1]));
 device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);
 const bytes=new Uint16Array(staging.getMappedRange());const result=probes.map((_,i)=>Array.from(bytes.subarray(i*128,i*128+4),half));staging.unmap();return result;
}
const evidence=[];
for(const degrees of [48,18]) {
 const elevation=degrees*Math.PI/180,clear=await sample(elevation,255),cloudy=await sample(elevation,0),procedural=await sample(elevation,0,true);
 assert.deepEqual(procedural,clear);
 const solar=[1.39009419,1.40065419,1.27155350].map((v,i)=>v*Math.exp(-[.15,.23,.42][i]*(1/Math.sin(elevation)-1/.741980412)));
 let maxAbsoluteError=0;
 for(let p=0;p<4;p++)for(let c=0;c<3;c++){
  const [, , ,r,g,,coverage]=probes[p];
  const nx=r/255*2-1,nz=g/255*2-1,ny=Math.sqrt(Math.max(.0001,1-nx*nx-nz*nz));
  const response=p===3?probes[p][3+c]/255*1.32*.25:[.1341,.2341,.026][c]*Math.max(0,nx*Math.cos(elevation)+ny*Math.sin(elevation));
  const expected=response*solar[c]*coverage/255,actual=clear[p][c]-cloudy[p][c];
  maxAbsoluteError=Math.max(maxAbsoluteError,Math.abs(expected-actual));
 }
 assert(maxAbsoluteError<.00055);assert.deepEqual(clear[4],[0,0,0,1]);
 assert(clear[1][1]>clear[2][1]);evidence.push({degrees,maxAbsoluteError,clear,cloudy});
}
assert.equal(await device.popErrorScope(),null);console.log(JSON.stringify({evidence},null,2));device.destroy();
