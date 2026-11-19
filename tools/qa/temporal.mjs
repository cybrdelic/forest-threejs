// Native Dawn regression checks for the production temporal resolve.
import assert from 'node:assert/strict';
import { create, globals } from 'webgpu';
import { historyTransform, temporalShader } from '../../dist/temporal.js';
import { inverse } from '../../dist/math.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan']);
const adapter=await gpu.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();
device.pushErrorScope('validation');
const size=[16,8], [width,height]=size;
const module=device.createShaderModule({code:temporalShader});
const pipeline=await device.createRenderPipelineAsync({
 layout:'auto',vertex:{module,entryPoint:'vs'},
 fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}
});
const texture=()=>device.createTexture({size,format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
const current=texture(),history=texture(),motion=texture();
const depth=device.createTexture({size,format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
const output=device.createTexture({size,format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const uniform=size=>device.createBuffer({size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const u=uniform(384),previous=uniform(80);
const group0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:u}}]});
const group1=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[
 {binding:0,resource:current.createView()}, {binding:1,resource:history.createView()},
 {binding:2,resource:depth.createView()}, {binding:3,resource:motion.createView()}, {binding:4,resource:{buffer:previous}}
]});
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const rows=(sample)=>Uint8Array.from({length:width*height*4},(_,i)=>sample((i>>2)%width,Math.floor(i/(4*width)),i%4));
const checker=rows((x,y,k)=>k===3?255:(x+y)%2?225:23);
const upload=(target,bytes)=>device.queue.writeTexture({texture:target},bytes,{bytesPerRow:width*4},size);
upload(current,checker);
const readback=device.createBuffer({size:height*256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
async function resolve({currentJitter=0,previousJitter=0,cameraMotion=0,historyBytes=checker}) {
 const currentVP=identity(),previousVP=identity();
 currentVP[12]=2*currentJitter/width;
 previousVP[12]=2*(previousJitter+cameraMotion)/width;
 const uniforms=new Float32Array(96);uniforms.set(currentVP);uniforms.set(inverse(currentVP),16);
 const old=new Float32Array(20);old.set(historyTransform(currentVP,previousVP));old[16]=1;old[19]=1;old[17]=(currentJitter-previousJitter)/width;
 device.queue.writeBuffer(u,0,uniforms);device.queue.writeBuffer(previous,0,old);upload(history,historyBytes);
 const encoder=device.createCommandEncoder();
 let pass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:0.5,depthLoadOp:'clear',depthStoreOp:'store'}});
 pass.end();
 pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}]});
 pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.draw(3);pass.end();
 encoder.copyTextureToBuffer({texture:output},{buffer:readback,bytesPerRow:256},size);
 device.queue.submit([encoder.finish()]);
 await readback.mapAsync(GPUMapMode.READ);
 const padded=new Uint8Array(readback.getMappedRange()),packed=new Uint8Array(checker.length);
 for(let row=0;row<height;row++)packed.set(padded.subarray(row*256,row*256+width*4),row*width*4);
 readback.unmap();return packed;
}
const steady=await resolve({currentJitter:.375,previousJitter:-.4375});
assert.deepEqual(steady,checker,'Static subpixel projection jitter must preserve resolved history coordinates');
const split=(rejectedColor)=>rows((x,y,k)=>k===3?(x%2?0:255):x%2?rejectedColor:180);
const dark=await resolve({cameraMotion:.5,historyBytes:split(0)});
const bright=await resolve({cameraMotion:.5,historyBytes:split(255)});
assert.deepEqual(dark,bright,'Rejected surface samples must not leak RGB through a depth edge');
assert.ok(dark.some((value,index)=>Math.abs(value-checker[index])>10),'Surviving same-surface taps contributed');
const error=await device.popErrorScope();
assert.equal(error,null,error?.message);
console.log('Passed static jitter cancellation, depth-edge isolation, valid subpixel history contribution.');
device.destroy();
