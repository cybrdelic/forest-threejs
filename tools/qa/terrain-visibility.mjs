import assert from 'node:assert/strict';
import {create,globals} from 'webgpu';
import {cullShader} from '../../dist/shaders.js';
import {CAMERA_START,createLandscape,createTreeInstances} from '../../dist/landscape.js';
import {buildTerrainVisibility,treeBehindTerrain} from '../../dist/terrain-visibility.js';
import {multiply,lookAt,perspective} from '../../dist/math.js';

Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
const device=await (await gpu.requestAdapter()).requestDevice();
device.pushErrorScope('validation');
const shader=device.createShaderModule({code:cullShader});
assert.deepEqual((await shader.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'trees'}});
function buffer(data,usage) {
 const b=device.createBuffer({size:data.byteLength,usage,mappedAtCreation:true});
 new data.constructor(b.getMappedRange()).set(data);b.unmap();return b;
}
const terrain=createLandscape();
const maps=buildTerrainVisibility(terrain);
const population=createTreeInstances(90000);
const cam=CAMERA_START.position;
const vp=multiply(perspective(50*Math.PI/180,16/9,.25,14000),lookAt(cam,CAMERA_START.target));
const u=new Float32Array(96);
u.set(vp);u.set(cam,48);u.set([90000,65,180,3000],64);
const ub=buffer(u,GPUBufferUsage.UNIFORM);
const ug=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:ub}}]});
const tb=buffer(population,GPUBufferUsage.STORAGE);
const capacity=Math.ceil(90000/64)*64;
const vis=device.createBuffer({size:capacity*6*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const indirect=buffer(new Uint32Array(30),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
const result=device.createBuffer({size:vis.size+indirect.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const lodState=buffer(new Uint32Array(90000),GPUBufferUsage.STORAGE);
async function cull(minima){
 const hb=buffer(minima,GPUBufferUsage.STORAGE);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[tb,vis,indirect,hb,lodState].map((b,binding)=>({binding,resource:{buffer:b}}))});
 device.queue.writeBuffer(indirect,0,new Uint32Array(30));
 const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
 pass.setPipeline(pipeline);pass.setBindGroup(0,ug);pass.setBindGroup(1,group);pass.dispatchWorkgroups(Math.ceil(90000/128));pass.end();
 encoder.copyBufferToBuffer(indirect,0,result,0,indirect.size);
 encoder.copyBufferToBuffer(vis,0,result,indirect.size,vis.size);
 device.queue.submit([encoder.finish()]);await result.mapAsync(GPUMapMode.READ);
 const bytes=new Uint32Array(result.getMappedRange());
 const buckets=Array.from({length:6},(_,i)=>new Set(bytes.slice(30+i*capacity,30+i*capacity+bytes[i*5+1])));
 result.unmap();hb.destroy();return buckets;
}
const unculled=await cull(new Float32Array(maps.length).fill(-1e20)),culled=await cull(maps);
assert.deepEqual(unculled[3],culled[3]);assert.deepEqual(unculled[4],culled[4]);
let before=0,after=0,removed=0;
for(const i of [0,1,2,5]){
 const expected=new Set([...unculled[i]].filter(id=>!treeBehindTerrain(maps,cam,population,id*8)));
 assert.deepEqual(culled[i],expected,'GPU and CPU tree identities must agree');
 before+=unculled[i].size;after+=culled[i].size;removed+=unculled[i].size-culled[i].size;
}
assert(removed>0);
const bounds=[-2048,-175,-125,125,175,2048];
const v=new Float32Array(bounds.length**2*12),idx=[];
for(let z=0;z<bounds.length;z++)for(let x=0;x<bounds.length;x++){
 const a=z*bounds.length+x;
 // Raised ridge running along Z with a flat 250m-wide top.
 v.set([bounds[x],Math.abs(bounds[x])<=125?80:0,bounds[z]],a*12);
 if(x+1<bounds.length&&z+1<bounds.length)idx.push(a,a+bounds.length,a+1,a+1,a+bounds.length,a+bounds.length+1);
}
const ridge=buildTerrainVisibility({vertices:v,indices:new Uint32Array(idx)});
const tree=new Float32Array([450,0,0,1,0,0,.7,0]);
assert(treeBehindTerrain(ridge,[-450,10,0],tree,0),'The opaque ridge must hide a far tree');
assert(!treeBehindTerrain(ridge,[200,10,0],tree,0),'A tree on the camera side of the ridge must remain');
tree[1]=275;
assert(!treeBehindTerrain(ridge,[-450,10,0],tree,0),'Tree above the ridge silhouette must remain');
tree[1]=0;tree[3]=3;
assert(!treeBehindTerrain(ridge,[-450,10,0],tree,0),'Oversize crown outside supported envelope must remain');
assert.equal(await device.popErrorScope(),null);
device.destroy();
console.log(JSON.stringify({before,after,removed,unchangedShadowCasters:culled[3].size+culled[4].size,bytes:maps.byteLength,nativeErrors:[]}));
