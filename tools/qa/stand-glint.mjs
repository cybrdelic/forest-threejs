// Native validation of the foliage BSDF and all release shader generators
// which include it. The comparisons are computed by the compiled GPU code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {create,globals} from 'webgpu';
import {surfaceLightWGSL,gpuSurfaceDFG} from '../../dist/surface-light.js';
import {geometryShader} from '../../dist/shaders.js';
import {meshletVertexShader} from '../../dist/meshlets.js';
import {treeImpostorWGSL} from '../../dist/impostors.js';
Object.assign(globalThis,globals);
const api=create(['backend=vulkan']);const adapter=await api.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();device.pushErrorScope('validation');
async function compile(label,code) {
 const module=device.createShaderModule({label,code});
 const errors=(await module.getCompilationInfo()).messages.filter(e=>e.type==='error');
 assert.deepEqual(errors.map(e=>e.message),[],label);return module;
}
await compile('release geometry',geometryShader);
await compile('release meshlets',geometryShader+meshletVertexShader);
for(const name of ['jacaranda','oak']) {
 const meta=JSON.parse(fs.readFileSync(new URL('../../dist/assets/impostors/'+name+'.json',import.meta.url)));
 await compile('release '+name+' impostors',treeImpostorWGSL(meta));
}
const values=[];
for(const angle of [2,25,90,135,151,165,171])
 for(const normalOffset of [-.2,0,.14])for(const aperture of [.23,.65,1])
  for(const [material,horizon] of [[1,1],[1.99999988,1],[2,1],[2.00000024,1],[2,-2],[4.2,1]])
   values.push([angle,normalOffset,aperture,material,horizon,0,0,0]);
const shader=await compile('unresolved canopy test','@group(2) @binding(6) var materialSampler:sampler;\n'+surfaceLightWGSL+`
struct Case {a:vec4<f32>,b:vec4<f32>};
@group(0) @binding(0) var<storage,read> cases:array<Case>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4<f32>>;
@compute @workgroup_size(32) fn run(@builtin(global_invocation_id) id:vec3<u32>) {
 let i=id.x;if(i>=arrayLength(&cases)){return;}
 let c=cases[i];let theta=radians(c.a.x);
 let view=vec3<f32>(sin(theta*.5),cos(theta*.5),0);
 let sun=vec3<f32>(-view.x,view.y,.000001);
 let n=normalize(vec3<f32>(c.a.y,1.,0.));
 let color=vec3<f32>(.13,.21,.055);
 let raw=surfaceDirect(color,n,view,sun,.66,.32,1.);
 let aperture=select(-1.,c.a.z,c.a.w>1.9 && c.a.w<2.1 && c.b.x>=0.);
 let after=surfaceDirectFiltered(color,n,view,sun,.66,.32,1.,aperture);
 let wax=surfaceDirectFiltered(vec3<f32>(0),n,view,sun,.66,0.,1.,aperture)/sunlightOverPi(sun);
 let h=normalize(sun+view+vec3<f32>(.000001));
 let fr=.04+.96*pow(1.-dot(sun,h),5.);
 result[i]=vec4<f32>(raw.g,after.g,wax.g,fr);
}`);
const bytes=new Float32Array(values.flat());
const input=device.createBuffer({size:bytes.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,bytes);
const output=device.createBuffer({size:values.length*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const staging=device.createBuffer({size:output.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'run'}});
const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(pipeline);
pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]}));
pass.setBindGroup(2,device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[{binding:6,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},{binding:11,resource:gpuSurfaceDFG(device).createView()}]}));
pass.dispatchWorkgroups(Math.ceil(values.length/32));pass.end();encoder.copyBufferToBuffer(output,0,staging,0,output.size);device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);
const data=new Float32Array(staging.getMappedRange());let unchanged=0,bounded=0,lowered=0;
for(let i=0;i<values.length;i++){
 const [raw,after,wax,fresnel]=data.subarray(i*4,i*4+4);const [angle,offset,aperture,material,horizon]=values[i];
 assert(Number.isFinite(wax)&&after>=0&&after<=raw+1e-6);
 if(material<1.9||material>2.1||horizon<0||fresnel<=.12){assert.equal(raw,after);unchanged++;}
 else if(fresnel>=.16){assert(wax<=(.04+.96/21)*aperture+.00001&&wax>=-1e-6);bounded++;}
 if(raw>after+1e-5)lowered++;
}
staging.unmap();assert(lowered>10&&bounded>10);assert.equal(await device.popErrorScope(),null);
console.log(JSON.stringify({releaseWGSLModulesCompiled:4,materialLightCases:values.length,bitIdenticalControls:unchanged,fullyBoundedCases:bounded,loweredCases:lowered,validationErrors:0}));
device.destroy();
