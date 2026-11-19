import assert from 'node:assert/strict';
import {create,globals} from 'webgpu';
import {surfaceLightWGSL,gpuSurfaceDFG} from '../../dist/surface-light.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
const device=await(await gpu.requestAdapter()).requestDevice();
device.pushErrorScope('validation');
const samples=4096;
const cases=[];
for(const albedo of [[.95,.95,.95],[.06,.14,.025],[.30,.62,.20]])
 for(const roughness of [.42,.66,.91]) for(const degrees of [0,60,80,89]) for(const transmission of [0,.32,.50])
  cases.push([roughness,degrees*Math.PI/180,transmission,0,...albedo,0]);
const input=new Float32Array(cases.flat());
const parameters=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE,mappedAtCreation:true});
new Float32Array(parameters.getMappedRange()).set(input);parameters.unmap();
const result=device.createBuffer({size:cases.length*samples*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const read=device.createBuffer({size:result.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
const module=device.createShaderModule({code:'@group(2) @binding(6) var materialSampler:sampler;\n'+surfaceLightWGSL+`
struct Material {shape:vec4<f32>,albedo:vec4<f32>};
@group(0) @binding(0) var<storage,read> materialCases:array<Material>;
@group(0) @binding(1) var<storage,read_write> values:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
 if(id.x>=${samples}u||id.y>=arrayLength(&materialCases)) {return;}
 let material=materialCases[id.y].shape;
 let view=vec3<f32>(sin(material.y),cos(material.y),0.0);
 // Equal-area deterministic hemisphere quadrature, mirrored to cover both
 // sides of a thin surface. This integrates the actual compiled BRDF.
 let cosine=(f32(id.x)+0.5)/${samples}.0;
 let phi=f32(id.x)*2.399963229728653;
 let sine=sqrt(1.0-cosine*cosine);
 let upper=vec3<f32>(sine*cos(phi),cosine,sine*sin(phi));
 let lower=upper*vec3<f32>(1.0,-1.0,1.0);
 let n=vec3<f32>(0.0,1.0,0.0);
 let a=materialCases[id.y].albedo.xyz;
 let reflected=surfaceDirect(a,n,view,upper,material.x,material.z,1.0)/sunlightOverPi(upper);
 let transmitted=surfaceDirect(a,n,view,lower,material.x,material.z,1.0)/sunlightOverPi(lower);
 values[id.y*${samples}u+id.x]=2.0*max(reflected.x+transmitted.x,max(reflected.y+transmitted.y,reflected.z+transmitted.z))/${samples}.0;
}`});
assert.deepEqual((await module.getCompilationInfo()).messages.filter(m=>m.type==='error'),[]);
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:parameters}},{binding:1,resource:{buffer:result}}]});
const dfgGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[
 {binding:6,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
 {binding:11,resource:gpuSurfaceDFG(device).createView()}
]});
const encoder=device.createCommandEncoder();
const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(2,dfgGroup);pass.dispatchWorkgroups(samples/64,cases.length);pass.end();
encoder.copyBufferToBuffer(result,0,read,0,result.size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
const values=new Float32Array(read.getMappedRange());let maximum=0;
for(let i=0;i<cases.length;i++) {
 let energy=0;for(let s=0;s<samples;s++){const v=values[i*samples+s];assert(Number.isFinite(v)&&v>=0);energy+=v;}
 assert(energy<=1.001,`Reflected+transmitted energy ${energy} exceeds incoming energy for ${cases[i]}`);
 maximum=Math.max(maximum,energy);
}
read.unmap();assert.equal(await device.popErrorScope(),null);
console.log(JSON.stringify({materials:cases.length,quadratureSamplesPerHemisphere:samples,maximumReflectedPlusTransmittedEnergy:maximum,validationErrors:0}));
device.destroy();
