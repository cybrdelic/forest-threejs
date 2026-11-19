// The same tree is observed while circling each transition and then walking
// cleanly through it in both directions. Compare WebGPU with the GL CPU path.
import assert from 'node:assert/strict';
import {create,globals} from 'webgpu';
import {treeDetailLevel,treeLodWGSL} from '../../dist/tree-lod.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
const device=await (await gpu.requestAdapter()).requestDevice();
device.pushErrorScope('validation');
const cases=[];
for(const [level,threshold] of [[1,65],[2,180],[3,750]]) {
 for(const scale of [0.25,1]){
  const range=level===3?threshold:threshold*scale;
  // Enter fine, oscillate ±2%, leave coarse, then return through the band.
  const ranges=[0.84,...Array.from({length:16},(_,i)=>i%2?1.02:0.98),1.12,...Array.from({length:16},(_,i)=>i%2?1.02:0.98),0.86];
  const expected=[...Array(17).fill(level),...Array(17).fill(level+1),level];
  cases.push({level,scale,ranges:ranges.map(r=>Math.fround(r*range)),expected});
 }
}
const count=cases[0].ranges.length;
const data=new Float32Array(cases.length*count*2);
for(const [i,sample] of cases.entries())sample.ranges.forEach((d,k)=>data.set([d,sample.scale],2*(i*count+k)));
const input=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(input,0,data);
const size=cases.length*count*4;
const output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const readback=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
const module=device.createShaderModule({code:treeLodWGSL+`
 @group(0) @binding(0) var<storage,read> samples:array<vec2<f32>>;
 @group(0) @binding(1) var<storage,read_write> results:array<u32>;
 @compute @workgroup_size(1) fn test(@builtin(global_invocation_id) id:vec3<u32>){
  var old=0u;
  for(var k=0u;k<${count}u;k++){
   let index=id.x*${count}u+k;
   old=treeDetailLevel(samples[index].x,samples[index].y,0.5,false,65.0,180.0,old);
   results[index]=old;
  }
 }`});
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'test'}});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(cases.length);pass.end();
encoder.copyBufferToBuffer(output,0,readback,0,size);
device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
const states=new Uint32Array(readback.getMappedRange());
for(const [i,sample] of cases.entries()) {
 let last=0;
 const cpu=sample.ranges.map(distance=>last=treeDetailLevel(distance,sample.scale,.5,false,65,180,last));
 assert.deepEqual(cpu,sample.expected,'Hysteresis must suppress oscillation and permit true crossings');
 assert.deepEqual(Array.from(states.slice(i*count,(i+1)*count)),cpu,'Both backends must select identical representations');
}
assert.equal(treeDetailLevel(135,.90,.5,true,65,180),1);
assert.equal(treeDetailLevel(95,.19,.5,false,65,180),3);
assert.equal(treeDetailLevel(1,.19,.5,false,65,180),1);
readback.unmap();
assert.equal(await device.popErrorScope(),null);device.destroy();
console.log(JSON.stringify({paths:cases.length,framesPerPath:count,matchingStates:cases.length*count,noiseInducedSwitches:0,deliberateCrossings:cases.length*2,nativeErrors:[]}));
