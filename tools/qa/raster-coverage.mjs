// Render a translated cutout edge over the sky and read both resolved color
// and the production reprojection depth. No simulation or animation involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { create, globals } from 'webgpu';
import {motionPackingWGSL} from '../../dist/foliage-motion.js';
import { depthResolveShader, vegetationSampling, coveragePatternWGSL } from '../../dist/sample-coverage.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan']);
const adapter=await gpu.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();
device.pushErrorScope('validation');
const size=[16,16], targetUsage=GPUTextureUsage.RENDER_ATTACHMENT;
const tex=(format,usage,sampleCount=1)=>device.createTexture({size,format,usage,sampleCount});
const sampledColor=tex('rgba16float',targetUsage|GPUTextureUsage.TEXTURE_BINDING,4),sampledDepth=tex('depth32float',targetUsage|GPUTextureUsage.TEXTURE_BINDING,4);
const resolvedColor=tex('rgba16float',targetUsage|GPUTextureUsage.COPY_SRC), motion=tex('rg16float',targetUsage|GPUTextureUsage.COPY_SRC);
const resolvedDepth=tex('depth32float',targetUsage|GPUTextureUsage.COPY_SRC);
const shader=device.createShaderModule({code:`
 ${motionPackingWGSL}
 ${coveragePatternWGSL}
 @group(0) @binding(0) var<uniform> coverage:f32;
 @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
   let p=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));
   return vec4<f32>(p[i],.25,1.);
 }
 struct Result { @location(0) color:vec4<f32>, @builtin(sample_mask) mask:u32 };
 @fragment fn fs()->Result {return Result(vec4<f32>(1.,0.,0.,packFoliageMotion(vec2<f32>(-2.0,5.0))),coverageMask(coverage,.013));}`});
const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:shader,entryPoint:'vs'},fragment:{module:shader,entryPoint:'fs',targets:[{format:'rgba16float'}]},multisample:vegetationSampling,depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true}});
const resolve=device.createShaderModule({code:depthResolveShader});
const resolver=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:resolve,entryPoint:'vs'},fragment:{module:resolve,entryPoint:'fs',targets:[{format:'rg16float'}]},depthStencil:{format:'depth32float',depthCompare:'always',depthWriteEnabled:true}});
const depthGroup=device.createBindGroup({layout:resolver.getBindGroupLayout(0),entries:[{binding:0,resource:sampledDepth.createView()},{binding:1,resource:sampledColor.createView()}]});
const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
const reader=device.createBuffer({size:12288,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const colors=[],depths=[],motions=[];
for(let step=0;step<=16;step++){
 device.queue.writeBuffer(uniform,0,new Float32Array([step/16]));
 const encoder=device.createCommandEncoder();
 const pass=encoder.beginRenderPass({colorAttachments:[{view:sampledColor.createView(),resolveTarget:resolvedColor.createView(),loadOp:'clear',clearValue:[0,0,1,0],storeOp:'store'}],depthStencilAttachment:{view:sampledDepth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
 pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
 const depthPass=encoder.beginRenderPass({colorAttachments:[{view:motion.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}],depthStencilAttachment:{view:resolvedDepth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
 depthPass.setPipeline(resolver);depthPass.setBindGroup(0,depthGroup);depthPass.draw(3);depthPass.end();
 encoder.copyTextureToBuffer({texture:resolvedColor},{buffer:reader,bytesPerRow:256},size);
 encoder.copyTextureToBuffer({texture:resolvedDepth,aspect:'depth-only'},{buffer:reader,offset:4096,bytesPerRow:256},size);
 encoder.copyTextureToBuffer({texture:motion},{buffer:reader,offset:8192,bytesPerRow:256},size);
 device.queue.submit([encoder.finish()]);
 await reader.mapAsync(GPUMapMode.READ);
 const mapped=reader.getMappedRange();
 colors.push(Math.round(new Float16Array(mapped)[0]*255));
 motions.push(Array.from(new Float16Array(mapped,8192,2)));
 depths.push(new Float32Array(mapped,4096,1)[0]);
 reader.unmap();
}
const error=await device.popErrorScope();assert(!error,error?.message);
const distinct=[...new Set(colors)].sort((a,b)=>a-b);
assert.equal(distinct.length,5);
for(let i=0;i<5;i++)assert(Math.abs(distinct[i]-i*255/4)<=1);
for(let i=0;i<colors.length;i++)assert.equal(depths[i],colors[i]>=128?.25:1);
for(let i=0;i<colors.length;i++){
 const [x,y]=motions[i];
 if(depths[i]===1){assert.equal(x,0);assert.equal(y,0);}
 else {assert(Math.abs(x+2)<.14 && Math.abs(y-5)<.22,'Motion must come from the selected depth sample');}
}
const maxColorStep=Math.max(...colors.slice(1).map((v,i)=>Math.abs(v-colors[i])));
assert(maxColorStep<=64);
const read=name=>fs.readFileSync(new URL('../../dist/assets/'+name+'.bin',import.meta.url));
const alpha=read('albedo'),norm=read('normal'),base=[];
let offset=0,maxMipAreaError=0;
for(let level=0;level<10;level++){
 const side=512>>level,pixels=side*side;
 for(let layer=3;layer<9;layer++){
  let sum=0;
  for(let i=0;i<pixels;i++)sum+=norm[offset+4*(layer*pixels+i)+3];
  if(!level){
   let ref=0;
   for(let i=0;i<pixels;i++)ref+=alpha[4*(layer*pixels+i)+3];
   assert.equal(sum,ref);base[layer]=ref/(255*pixels);
  }
  maxMipAreaError=Math.max(maxMipAreaError,Math.abs(sum/(255*pixels)-base[layer]));
 }
 offset+=9*pixels*4;
}
assert(maxMipAreaError<=.5/255);
console.log(JSON.stringify({samples:vegetationSampling.count,steps:16,colors,depths,hardCutoutMaxStep:255,maxColorStep,maxMipAreaError,rawCoverageMips:60,gpuErrors:0}));
device.destroy();
