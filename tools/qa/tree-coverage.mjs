// Isolate geometric sample occupancy in one tree, independent of shading and
// tone mapping. The comparison includes the full unreduced source atlas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {create,globals} from 'webgpu';
import {coveragePatternWGSL} from '../../dist/sample-coverage.js';
import {decodeTreeVertices} from '../../dist/geometry-assets.js';
import {loadMaterialTextures} from '../../dist/materials.js';
import {decodeRGBA8PNG} from '../../dist/impostors.js';

Object.assign(globalThis,globals);
const output=process.env.TREE_COVERAGE_OUTPUT;
if(output) fs.mkdirSync(output,{recursive:true});
const read=name=>fs.readFileSync(new URL('../../dist/assets/'+name,import.meta.url));
globalThis.forestMaterialBytes={albedo:read('albedo.bin'),normal:read('normal.bin')};
const api=create(['backend=vulkan']);
const device=await(await api.requestAdapter({forceFallbackAdapter:true})).requestDevice();
device.pushErrorScope('validation');
const [color,normal]=await loadMaterialTextures(device);
const sampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4});
const camera=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const layout=device.createBindGroupLayout({entries:[
 {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{}},
 {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array'}},
 {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array'}},
 {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]});
const group=device.createBindGroup({layout,entries:[
 {binding:0,resource:{buffer:camera}},{binding:1,resource:color.createView()},
 {binding:2,resource:normal.createView()},{binding:3,resource:sampler}]});
const materialShader=coveragePatternWGSL+`
@group(0) @binding(0) var<uniform> params:vec4<f32>;
@group(0) @binding(1) var calibrated:texture_2d_array<f32>;
@group(0) @binding(2) var raw:texture_2d_array<f32>;
@group(0) @binding(3) var sampleTex:sampler;
struct Vertex {@builtin(position) p:vec4<f32>,@location(0) mat:vec3<f32>,@location(1) local:vec3<f32>,@location(2) @interpolate(flat) phase:f32};
@vertex fn vs(@location(0)p:vec3<f32>,@location(1)mat:vec3<f32>)->Vertex{
 var out:Vertex;
 out.p=vec4<f32>(2.*p.x/params.x,2.*(p.y-params.z)/params.y,.5-p.z/128.,1.);
 out.phase=shootPhase(.438,p,mat.yz);
 out.mat=mat;out.local=p;return out;
}
struct Frag{@location(0) color:vec4<f32>,@builtin(sample_mask) mask:u32};
@fragment fn fs(v:Vertex)->Frag {
 let layer=max(0,i32(round(v.mat.x))-2); let uv=v.mat.yz;
 let dx=dpdx(uv); let dy=dpdy(uv);
 let weight=textureSampleGrad(raw,sampleTex,uv,layer,dx,dy).a;
 let adjusted=textureSampleGrad(calibrated,sampleTex,uv,layer,dx,dy).a;
 let source=textureSampleLevel(raw,sampleTex,uv,layer,0.).a;
 var coverage=1.; var mask=15u;
 if(v.mat.x>4.5) { TEST }
 var result:Frag;result.color=vec4<f32>(1.,1.,1.,coverage);result.mask=mask;return result;
}`;
const treatments={
 source:'if(source<.5){discard;}',
 hard:'if(adjusted<.5){discard;}',
 area:'coverage=weight;',
 phased:'let w=.22;coverage=(clamp(weight-v.phase,0.,w)+clamp(min(v.phase+w-1.,weight),0.,w))/w;',
 release:'mask=coverageMask(weight,v.phase);'
};
const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
const pipelines={};
for(const [id,tests] of Object.entries(treatments)) {
 const samples=id==='source'?1:4;
 const useHardwareCoverage=['area','phased'].includes(id);
 // A2C and an explicit sample-mask output are mutually exclusive on WebGPU.
 let shaderCode=materialShader.replace('TEST',tests);
 if(id!=='release') shaderCode=shaderCode.replace(',@builtin(sample_mask) mask:u32','').replace('result.mask=mask;','');
 const module=device.createShaderModule({code:shaderCode});
 const diagnostics=await module.getCompilationInfo();
 assert(!diagnostics.messages.some(item=>item.type==='error'),diagnostics.messages.map(item=>item.message).join('\n'));
 const definition={layout:pipelineLayout,vertex:{module,entryPoint:'vs',buffers:[{arrayStride:48,attributes:[{shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:36}]}]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},multisample:{count:samples,alphaToCoverageEnabled:useHardwareCoverage},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true}};
 pipelines[id]=await device.createRenderPipelineAsync(definition);
}
function gpuBuffer(data,usage) {
 const buffer=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
 device.queue.writeBuffer(buffer,0,data);
 return buffer;
}
async function render(mesh,mode,side) {
 const samples=mode==='source'?1:4;
 const outputTexture=device.createTexture({size:[side,side],format:'rgba8unorm',usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
 const multi=samples>1?device.createTexture({size:[side,side],format:'rgba8unorm',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT}):null;
 const depth=device.createTexture({size:[side,side],format:'depth32float',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT});
 const bpr=256*Math.ceil(side*4/256);
 const buffer=device.createBuffer({size:bpr*side,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const encoder=device.createCommandEncoder();
 const pass=encoder.beginRenderPass({colorAttachments:[{view:(multi||outputTexture).createView(),resolveTarget:multi?outputTexture.createView():undefined,clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'discard'}});
 pass.setPipeline(pipelines[mode]);pass.setBindGroup(0,group);pass.setVertexBuffer(0,mesh.vertices);
 pass.setIndexBuffer(mesh.indices,'uint32');pass.drawIndexed(mesh.count);pass.end();
 encoder.copyTextureToBuffer({texture:outputTexture},{buffer,bytesPerRow:bpr},[side,side]);device.queue.submit([encoder.finish()]);
 await buffer.mapAsync(GPUMapMode.READ);
 const bytes=new Uint8Array(buffer.getMappedRange());const values=new Uint8Array(side*side);
 for(let y=0;y<side;y++)for(let x=0;x<side;x++)values[y*side+x]=bytes[y*bpr+x*4];
 buffer.unmap();buffer.destroy();depth.destroy();multi?.destroy();outputTexture.destroy();return values;
}
function downsample(bytes,side,scale) {
 const output=new Float64Array(side*side);
 for(let y=0;y<side*scale;y++)for(let x=0;x<side*scale;x++)output[Math.floor(y/scale)*side+Math.floor(x/scale)]+=bytes[y*side*scale+x]/(255*scale*scale);
 return output;
}
function metric(tested,source) {
 let total=0,reference=0,interior=0,holes=0,edge=0,edgeError=0,mn=0,mx=0;
 for(let i=0;i<source.length;i++) {
  const a=tested[i],b=source[i];total+=a;reference+=b;mn+=Math.min(a,b);mx+=Math.max(a,b);
  if (b>=.9) {interior++;if(a<.5)holes++;}
  if (b>.04&&b<.96) {edge++;edgeError+=Math.abs(a-b);}
 }
 return {relativeArea:total/reference,softIoU:mn/mx,sourceInteriorHoles:holes/Math.max(1,interior),edgeMAE:edgeError/Math.max(1,edge),pixels:total};
}
const side=256,scale=8;
const results={};
for(const species of ['oak','jacaranda']) {
 const tree=JSON.parse(read('impostors/'+species+'.json'));
 device.queue.writeBuffer(camera,0,Float32Array.of(...tree.projectionSize,tree.center[1],0));
 const png=read('impostors/'+species+'-albedo.png');
 const {bytes:atlas,width}=await decodeRGBA8PNG(png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength));
 const full=Float64Array.from({length:side*side},(_,i)=>atlas[4*((Math.floor(i/side)+side)*width+i%side)+3]/255);
 for(const level of ['near','mid']) {
  const key=species+'-'+level;
  const name=(species==='oak'?'trees':'jacaranda')+'/'+level;
  const vertices=decodeTreeVertices(read(name+'-vertices.bin'));
  const indices=read(name+'-indices.bin');
  const mesh={vertices:gpuBuffer(vertices,GPUBufferUsage.VERTEX),indices:gpuBuffer(indices,GPUBufferUsage.INDEX),count:indices.length/4};
  const reference=downsample(await render(mesh,'source',side*scale),side,scale);
  assert(reference.some(value=>value===1)&&reference.some(value=>value===0));
  results[key]={sourceAgainstFullGeometry:metric(reference,full)};
  for(const mode of Object.keys(treatments).slice(1)) {
   const bytes=await render(mesh,mode,side);
   const value=Float64Array.from(bytes,x=>x/255);
   results[key][mode]=metric(value,reference);
   if(output) fs.writeFileSync(path.join(output,key+'-'+mode+'.pgm'),Buffer.concat([Buffer.from('P5\n256 256\n255\n'),bytes]));
  }
  if(output) fs.writeFileSync(path.join(output,key+'-reference.pgm'),Buffer.concat([Buffer.from('P5\n256 256\n255\n'),Uint8Array.from(reference,x=>Math.round(x*255))]));
  const {release,area}=results[key];
  assert(release.relativeArea>.88 && release.relativeArea<1.10,key+' projected area regression');
  assert(release.edgeMAE<area.edgeMAE && release.sourceInteriorHoles<.012,key+' crown edge or interior coverage regression');
  mesh.vertices.destroy();mesh.indices.destroy();
  console.log(key,JSON.stringify(results[key]));
 }
}
const error=await device.popErrorScope();assert(!error,error?.message);
if(output) fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify(results,null,2));
device.destroy();
