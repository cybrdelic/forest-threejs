import { daylight } from './daylight.js';
import {createGPUHedgerow,prepareHedgerow} from './hedgerow.js';
import { gpuStandRelief } from './stand-relief.js';
import { motionFormat } from './foliage-motion.js';
import { depthResolveShader, normalFormat, sceneSamples, vegetationSampling } from './sample-coverage.js';
import { gpuSurfaceDFG } from './surface-light.js';
import { buildTerrainVisibility } from './terrain-visibility.js';
import { gpuSkyDetail } from './sky-detail.js';
import { getGPUStandTexture } from './stand-envelope.js';
import { SHADOW_HALF_WIDTH } from './forest-shadow.js';
import { gpuCloudMask } from './weather-light.js';
import { createLandscape, createTreeInstances, createGrassInstances, createCanopyProxy, terrainHeight, terrainSurfaceHeight, CAMERA_START } from './landscape.js';
import { createVegetation } from './vegetation.js';
import { createMeshletRenderer } from './meshlets.js';
import { fxaaShader } from './antialias.js';
import { historyTransform, temporalShader } from './temporal.js';
import { buildStreamingData } from './streaming.js';
import { loadMaterialTextures } from './materials.js';
import { loadRealTreeGeometry } from './geometry-assets.js';
import { loadMeadowGeometry, closeMeadow } from './meadow.js';
import { createTreeImpostors } from './impostors.js';
import { setupScreenshot } from './screenshot.js';
import { setupControls, updateStats, setLoading, setError } from './controls.js';
import { normalize, multiply, perspective, lookAt, orthographic, inverse } from './math.js';
import { cullShader, geometryShader, skyShader, postShader, volumeShader, mipShader } from './shaders.js';

let canvas = document.getElementById('scene');
const FIELD_OF_VIEW=50*Math.PI/180;
export const settings = { ...daylight.front, wind:0.8, density:90000, quality:'balanced', debug:'beauty',sky:'photographic' };
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
let device, renderer, controller;
let position = [...CAMERA_START.position];
let yaw = 0, pitch = 0, tour = false, tourTime = 0, activeView = 'meadow';
let fatal = false, lastTime = performance.now(), frames = 0, fpsTime = performance.now();
let screenshotCapture;
const telemetry = { status:'initializing', gpuErrors:[], frames:0, counts:[0,0,0], total:0, fps:0, resolution:[0,0], volumeUpdates:0 };
window.forestDiagnostics = telemetry;

function aimAt(target) {
 const delta=target.map((value,index)=>value-position[index]);
 yaw=Math.atan2(delta[0],-delta[2]);
 pitch=Math.atan2(delta[1],Math.hypot(delta[0],delta[2]));
}
aimAt(CAMERA_START.target);

export function setView(name) {
 activeView=name;
 if(name==='meadow') {
  position=[...CAMERA_START.position];aimAt(CAMERA_START.target);
 } else if(name==='forest') {
  position=[-345,terrainSurfaceHeight(-345,-75)+1.85,-75];
  aimAt([-425,terrainHeight(-425,-160)+8,-160]);
 } else {
  position=[-600,terrainHeight(-600,350)+400,350];
  aimAt([220,terrainHeight(220,-600),-600]);
 }
 if(renderer) {renderer.volumeDirty=true;renderer.historyValid=false;}
}

export function setCamera(cameraPosition,target) {
 position=[...cameraPosition];aimAt(target);
 if(renderer) {renderer.volumeDirty=true;renderer.historyValid=false;}
}

function createBuffer(data,usage,label) {
 const buffer=device.createBuffer({label,size:Math.max(4,data.byteLength),usage,mappedAtCreation:true});
 new data.constructor(buffer.getMappedRange()).set(data);buffer.unmap();return buffer;
}
function uploadMesh(mesh,label) {
 return { vertex:createBuffer(mesh.vertices,GPUBufferUsage.VERTEX,label+' vertices'), index:createBuffer(mesh.indices,GPUBufferUsage.INDEX,label+' indices'), count:mesh.indices.length };
}
async function shader(code,label) {
 const module=device.createShaderModule({label,code});
 const info=await module.getCompilationInfo();
 const errors=info.messages.filter(message=>message.type==='error');
 if(errors.length) throw new Error(label+'\n'+errors.map(e=>`${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
 return module;
}

export class ForestRenderer {
 async initialize() {
  if(!navigator.gpu) throw new Error('This renderer requires WebGPU. Open it in a current Chrome or Edge browser with graphics acceleration enabled.');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter) throw new Error('WebGPU could not access a graphics adapter. Check that hardware acceleration is enabled.');
  device=await adapter.requestDevice();
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  telemetry.adapter=adapter.info?.description||adapter.info?.device||'WebGPU adapter';
  console.info('Forest WebGPU adapter',telemetry.adapter);
  device.addEventListener('uncapturederror',event=>{
   if(this.retired)return;
   console.error(event.error.message);telemetry.gpuErrors.push(event.error.message);
   if(this.ready)stopRendering(event.error);
   else this.lostReason=event.error.message;
  });
  device.lost.then(info=>{if(this.retired)return;this.lostReason=info.message||'Graphics device lost';if(!this.ready)return;fatal=true;screenshotCapture?.cancel();telemetry.status='device-lost';setError('The graphics device was lost. '+info.message);});
  this.context=canvas.getContext('webgpu');
  this.format=navigator.gpu.getPreferredCanvasFormat();
  this.context.configure({device,format:this.format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  this.uniformBuffer=device.createBuffer({label:'Frame uniforms',size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.uniformData=new Float32Array(96);
  this.uniformLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT|GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
  this.uniformGroup=device.createBindGroup({layout:this.uniformLayout,entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.instanceLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}}]});
  this.lightLayout=device.createBindGroupLayout({entries:[
   {binding:12,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
   {binding:11,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
   {binding:9,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},
   {binding:10,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
   {binding:8,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
   {binding:7,visibility:GPUShaderStage.FRAGMENT,texture:{}},
   {binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},
   {binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'comparison'}},
   {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'3d',sampleType:'float'}},
   {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
   {binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array',sampleType:'float'}},
   {binding:5,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array',sampleType:'float'}},
   {binding:6,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}
  ]});
  this.linearSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});
  this.shadowSampler=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'});
  this.shadowTexture=device.createTexture({label:'Wide sun shadow map',size:[4096,4096],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  this.shadowView=this.shadowTexture.createView();
  this.plantShadowTexture=device.createTexture({label:'Centimetre grass sun shadows',size:[2048,2048],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  this.plantShadowView=this.plantShadowTexture.createView();
  this.plantMatrixBuffer=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.plantShadowUniform=device.createBuffer({size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.plantShadowGroup=device.createBindGroup({layout:this.uniformLayout,entries:[{binding:0,resource:{buffer:this.plantShadowUniform}}]});
  this.occupancyTexture=device.createTexture({label:'Voxel surface and coverage',dimension:'3d',size:[64,64,64],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
  this.radianceTexture=device.createTexture({label:'Voxel radiance hierarchy',dimension:'3d',size:[64,64,64],mipLevelCount:7,format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
  this.materialTextures=await loadMaterialTextures(device);
  this.materialSampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4});
  this.photoCloudMask=await gpuCloudMask(device);
  this.standRelief=await gpuStandRelief(device);
  this.surfaceDFG=gpuSurfaceDFG(device);
  const createLightGroup=standTexture=>device.createBindGroup({layout:this.lightLayout,entries:[
   {binding:12,resource:this.standRelief.createView()},
   {binding:11,resource:this.surfaceDFG.createView()},
   {binding:9,resource:this.plantShadowView},{binding:10,resource:{buffer:this.plantMatrixBuffer}},
   {binding:8,resource:standTexture.createView()},
   {binding:7,resource:this.photoCloudMask.createView()},
   {binding:0,resource:this.shadowView},{binding:1,resource:this.shadowSampler},{binding:2,resource:this.radianceTexture.createView()},{binding:3,resource:this.linearSampler},
   {binding:4,resource:this.materialTextures[0].createView({dimension:"2d-array"})},{binding:5,resource:this.materialTextures[1].createView({dimension:"2d-array"})},{binding:6,resource:this.materialSampler}
  ]});
  setLoading('Compiling the forest renderer…',0.12);await nextFrame();
  const modules=await Promise.all([shader(cullShader,'GPU visibility and detail selection'),shader(geometryShader,'Geometry and voxel lighting'),shader(skyShader,'Atmosphere'),shader(postShader,'Screen-space lighting'),shader(volumeShader,'Voxel radiance injection'),shader(mipShader,'Voxel hierarchy')]);
  const [cull,geometry,sky,post,volume,mip]=modules;
  const vertexBuffers=[{arrayStride:48,attributes:[{shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:12},{shaderLocation:2,format:'float32x3',offset:24},{shaderLocation:3,format:'float32x3',offset:36}]}];
  const renderLayout=device.createPipelineLayout({bindGroupLayouts:[this.uniformLayout,this.instanceLayout,this.lightLayout]});
  this.shadowMaterialLayout=device.createBindGroupLayout({entries:[
   {binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array',sampleType:'float'}},
   {binding:6,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}
  ]});
  this.shadowMaterialGroup=device.createBindGroup({layout:this.shadowMaterialLayout,entries:[
   {binding:4,resource:this.materialTextures[0].createView({dimension:'2d-array'})},{binding:6,resource:this.materialSampler}
  ]});
  const shadowLayout=device.createPipelineLayout({bindGroupLayouts:[this.uniformLayout,this.instanceLayout,this.shadowMaterialLayout]});
  const colorTargets=[{format:'rgba16float'},{format:normalFormat}];
  const geometryDescriptor=entryPoint=>({layout:renderLayout,multisample:vegetationSampling,vertex:{module:geometry,entryPoint,buffers:vertexBuffers},fragment:{module:geometry,entryPoint:'geometryFS',targets:colorTargets},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
  this.terrainPipeline=await device.createRenderPipelineAsync(geometryDescriptor('terrainVS'));
  this.treePipeline=await device.createRenderPipelineAsync(geometryDescriptor('vegetationVS'));
  const shadowDescriptor=entryPoint=>({layout:shadowLayout,vertex:{module:geometry,entryPoint,buffers:vertexBuffers},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:1,depthBiasSlopeScale:1.5}});
  this.shadowPipeline=await device.createRenderPipelineAsync({...shadowDescriptor('shadowVS'),fragment:{module:geometry,entryPoint:'shadowAlpha',targets:[]}});
  const closeShadow=shadowDescriptor('shadowVS');
  this.liveShadowPipeline=await device.createRenderPipelineAsync({...closeShadow,vertex:{...closeShadow.vertex,constants:{liveTreeShadow:1}},fragment:{module:geometry,entryPoint:'shadowAlpha',targets:[]}});
  this.terrainShadowPipeline=await device.createRenderPipelineAsync(shadowDescriptor('terrainShadowVS'));
  const cloudBytes=globalThis.forestMaterialBytes?.cloud||new Uint8Array(await(await fetch(new URL('./assets/cloud.bin',import.meta.url))).arrayBuffer());
  this.cloudTexture=device.createTexture({size:[128,128,128],dimension:'3d',format:'r8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
  device.queue.writeTexture({texture:this.cloudTexture},cloudBytes,{bytesPerRow:128,rowsPerImage:128},[128,128,128]);
  this.cloudLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'3d'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:4,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
  this.skyDetailTexture=await gpuSkyDetail(device);
  const skyBytes=globalThis.forestMaterialBytes?.environment||new Uint8Array(await(await fetch(new URL('./assets/environment.bin',import.meta.url))).arrayBuffer());
  this.skyTexture=device.createTexture({size:[2048,1024],format:'rg11b10ufloat',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
  device.queue.writeTexture({texture:this.skyTexture},skyBytes,{bytesPerRow:8192,rowsPerImage:1024},[2048,1024]);
  this.cloudGroup=device.createBindGroup({layout:this.cloudLayout,entries:[{binding:0,resource:this.cloudTexture.createView()},{binding:1,resource:device.createSampler({addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat',minFilter:'linear',magFilter:'linear'})},{binding:2,resource:this.skyTexture.createView()},
    {binding:3,resource:this.skyDetailTexture.createView()},
    {binding:4,resource:device.createSampler({addressModeU:'repeat',addressModeV:'clamp-to-edge',minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'})}]});
  this.skyPipeline=await device.createRenderPipelineAsync({multisample:{count:sceneSamples},layout:device.createPipelineLayout({bindGroupLayouts:[this.uniformLayout,this.cloudLayout]}),vertex:{module:sky,entryPoint:'vs'},fragment:{module:sky,entryPoint:'fs',targets:colorTargets},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'always'}});
  const depthResolve=await shader(depthResolveShader,'Resolve multisample visibility');
  this.depthResolvePipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:depthResolve,entryPoint:'vs'},fragment:{module:depthResolve,entryPoint:'fs',targets:[{format:motionFormat}]},depthStencil:{format:'depth32float',depthCompare:'always',depthWriteEnabled:true}});
  this.postPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:post,entryPoint:'vs'},fragment:{module:post,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}});
  const aaModule=await shader(fxaaShader,'Foliage antialiasing');
  const temporalModule=await shader(temporalShader,'Temporal foliage resolve');
  this.temporalPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:temporalModule,entryPoint:'vs'},fragment:{module:temporalModule,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
  this.previousUniform=device.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.temporalUniformGroup=device.createBindGroup({layout:this.temporalPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.previousVP=new Float32Array(16);this.frameIndex=0;
  this.aaPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:aaModule,entryPoint:'vs'},fragment:{module:aaModule,entryPoint:'fs',targets:[{format:this.format}]}});
  this.cullTreePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:cull,entryPoint:'trees'}});
  this.cullGrassPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:cull,entryPoint:'grass'}});
  this.cullPlantShadowPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:cull,entryPoint:'closeGrassShadow'}});
  this.cullPlantShadowGroup=device.createBindGroup({layout:this.cullPlantShadowPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.cullCloseGrassPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:cull,entryPoint:'closeGrass'}});
  this.volumePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:volume,entryPoint:'light'}});
  this.mipPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:mip,entryPoint:'main'}});
  this.postUniformGroup=device.createBindGroup({layout:this.postPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.cullTreeUniformGroup=device.createBindGroup({layout:this.cullTreePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.cullCloseGrassUniformGroup=device.createBindGroup({layout:this.cullCloseGrassPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.cullGrassUniformGroup=device.createBindGroup({layout:this.cullGrassPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.volumeUniformGroup=device.createBindGroup({layout:this.volumePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]});
  this.volumeGroup=device.createBindGroup({layout:this.volumePipeline.getBindGroupLayout(1),entries:[{binding:0,resource:this.occupancyTexture.createView()},{binding:1,resource:this.radianceTexture.createView({baseMipLevel:0,mipLevelCount:1})},{binding:2,resource:this.linearSampler},{binding:3,resource:this.photoCloudMask.createView()}]});
  this.mipGroups=[];
  for(let level=1;level<7;level++) this.mipGroups.push(device.createBindGroup({layout:this.mipPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.radianceTexture.createView({baseMipLevel:level-1,mipLevelCount:1})},{binding:1,resource:this.radianceTexture.createView({baseMipLevel:level,mipLevelCount:1})}]}));
  setLoading('Growing trees and building the terrain…',0.40);await nextFrame();
  const hedgerowAssets=prepareHedgerow();
  const vegetation=createVegetation(undefined,{generatedTrees:false});
  Object.assign(vegetation,await loadRealTreeGeometry());
  this.jacarandaGeometry=await loadRealTreeGeometry('jacaranda');
  vegetation.shadow=vegetation.canopy;
  const meadowGeometry=await loadMeadowGeometry();
  this.closeMeadowMesh=uploadMesh(closeMeadow(),'Explicit walking-distance meadow');
  this.meadowMeshes=meadowGeometry.map(mesh=>uploadMesh(mesh,mesh.name));
  this.farMeadowMeshes=meadowGeometry.map(mesh=>uploadMesh(mesh.far,mesh.name+' distant'));
  this.farMeadowIndexCounts=this.farMeadowMeshes.map(mesh=>mesh.count);
  this.meadowIndexCounts=this.meadowMeshes.map(mesh=>mesh.count);
  const terrain=createLandscape();
  this.terrainMinima=createBuffer(buildTerrainVisibility(terrain),GPUBufferUsage.STORAGE,'Conservative terrain minima');
  this.meshes={terrain:uploadMesh(terrain,'Terrain'),near:uploadMesh(vegetation.near,'Detailed oak'),mid:uploadMesh(vegetation.mid,'Medium voxel oak'),far:uploadMesh(vegetation.far,'Distant voxel oak'),grass:this.meadowMeshes[0]};
  this.meshes.voxel=uploadMesh(vegetation.canopy,'Medium distance canopy voxels');
  this.meshes.canopy=uploadMesh(createCanopyProxy(),'Distant forest canopy');
  this.meshes.grassFar=this.farMeadowMeshes[0];
  this.meshes.shadow=uploadMesh(vegetation.shadow||vegetation.far,'Shadow canopy');
  this.jacarandaMeshes=Object.fromEntries(['near','mid','canopy'].map(name=>[name,uploadMesh(this.jacarandaGeometry[name],'Jacaranda '+name)]));
  this.meshStats=Object.fromEntries(Object.entries(this.meshes).map(([name,mesh])=>[name,mesh.count/3]));
  this.hedgerow=createGPUHedgerow(await hedgerowAssets,device,this.instanceLayout,uploadMesh,createBuffer);
  this.grassCenter=[position[0],position[2]];
  this.grassCount=180000;
  this.grassData=createGrassInstances(this.grassCount,position[0],position[2]);
  this.grass=this.createPopulation(this.grassData,this.meadowIndexCounts,this.cullGrassPipeline);
  this.closeGrass=this.createPopulation(this.grassData,[this.closeMeadowMesh.count],this.cullCloseGrassPipeline);
  this.plantShadowGrass=this.createPopulation(this.grassData,[this.closeMeadowMesh.count,...this.meadowIndexCounts],this.cullPlantShadowPipeline);
  this.farGrassCenter=[position[0],position[2]];
  this.farGrass=this.createPopulation(createGrassInstances(65536,...this.farGrassCenter,1.6),this.farMeadowIndexCounts,this.cullGrassPipeline);
  this.rebuildPopulation(settings.density);
  this.lightGroup=createLightGroup(this.standTexture);
  this.meshlets=await createMeshletRenderer(device,{mesh:vegetation.near,uniformBuffer:this.uniformBuffer,uniformLayout:this.uniformLayout,instanceLayout:this.instanceLayout,lightLayout:this.lightLayout,geometryShader,trees:this.trees});
  this.jacarandaMeshlets=await createMeshletRenderer(device,{mesh:this.jacarandaGeometry.near,uniformBuffer:this.uniformBuffer,uniformLayout:this.uniformLayout,instanceLayout:this.instanceLayout,lightLayout:this.lightLayout,geometryShader,trees:this.jacarandas});
  this.impostors=await createTreeImpostors(device,{uniformBuffer:this.uniformBuffer,uniformLayout:this.uniformLayout,instanceLayout:this.instanceLayout,lightLayout:this.lightLayout,species:'oak'});
  this.jacarandaImpostors=await createTreeImpostors(device,{uniformBuffer:this.uniformBuffer,uniformLayout:this.uniformLayout,instanceLayout:this.instanceLayout,lightLayout:this.lightLayout,species:'jacaranda'});
  telemetry.meshlets=this.meshlets.stats;
  this.readback=device.createBuffer({label:'Visibility counters readback',size:432,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  this.volumeOrigin=[0,0,0];this.volumeDirty=true;this.volumeLightingDirty=true;this.lastVolumeTime=0;
  this.resize();
  setLoading('Lighting the voxel volume…',0.82);await nextFrame();
  this.updateVolume(position);
  this.initializeStreaming();
  const allocationFailure=await device.popErrorScope();
  const validationFailure=await device.popErrorScope();
  const startupFailure=allocationFailure||validationFailure;
  if(startupFailure||this.lostReason)throw new Error(startupFailure?.message||this.lostReason);
  this.ready=true;
  telemetry.status='running';telemetry.meshTriangles=this.meshStats;
  console.info('Forest geometry',this.meshStats);
 }
 createPopulation(data,indexCounts,cullPipeline) {
  const total=data.length/8;
  // In a 12 m disk there are fewer than (24/.4 + 2)^2 possible
  // world-grid roots. Every root stays inside its own 40 cm cell.
  const localDisk=cullPipeline===this.cullCloseGrassPipeline||cullPipeline===this.cullPlantShadowPipeline;
  const capacity=Math.ceil(Math.min(total,localDisk?4096:total)/64)*64;
  const instances=createBuffer(data,GPUBufferUsage.STORAGE,'Instance transforms');
  const visible=device.createBuffer({label:'GPU compacted visible instances',size:capacity*4*indexCounts.length,usage:GPUBufferUsage.STORAGE});
  const argumentData=new Uint32Array(indexCounts.length*5);
  indexCounts.forEach((count,index)=>argumentData[index*5]=count);
  const indirect=createBuffer(argumentData,GPUBufferUsage.INDIRECT|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,'Indexed indirect draws');
  const cullBindings=[{binding:0,resource:{buffer:instances}},{binding:1,resource:{buffer:visible}},{binding:2,resource:{buffer:indirect}}];
  let lodState;
  if(cullPipeline===this.cullTreePipeline){
   lodState=device.createBuffer({label:'Previous tree detail level',size:Math.max(4,total*4),usage:GPUBufferUsage.STORAGE});
   cullBindings.push({binding:3,resource:{buffer:this.terrainMinima}},{binding:4,resource:{buffer:lodState}});
  }
  const cullGroup=device.createBindGroup({layout:cullPipeline.getBindGroupLayout(1),entries:cullBindings});
  const groups=indexCounts.map((_,index)=>device.createBindGroup({layout:this.instanceLayout,entries:[{binding:0,resource:{buffer:instances}},{binding:1,resource:{buffer:visible,offset:index*capacity*4,size:capacity*4}}]}));
  return {total,capacity,instances,visible,indirect,argumentData,cullGroup,groups,lodState};
 }
 rebuildPopulation(count) {
  const old=this.trees;
  const oldJacarandas=this.jacarandas;
  this.treeData=createTreeInstances(count);
  this.standTexture=getGPUStandTexture(device);
  const oak=[],jacaranda=[];
  for(let i=0;i<this.treeData.length/8;i++) {
   const destination=i%5<2?jacaranda:oak;
   for(let component=0;component<8;component++)destination.push(this.treeData[i*8+component]);
  }
  this.trees=this.createPopulation(new Float32Array(oak),[this.meshes.near.count,this.meshes.mid.count,6,this.meshes.shadow.count,this.meshes.mid.count,6],this.cullTreePipeline);
  this.jacarandas=this.createPopulation(new Float32Array(jacaranda),[this.jacarandaMeshes.near.count,this.jacarandaMeshes.mid.count,6,this.jacarandaMeshes.canopy.count,this.jacarandaMeshes.mid.count,6],this.cullTreePipeline);
  if(old) device.queue.onSubmittedWorkDone().then(()=>{old.lodState.destroy();old.instances.destroy();old.visible.destroy();old.indirect.destroy();});
  if(oldJacarandas) device.queue.onSubmittedWorkDone().then(()=>{oldJacarandas.lodState.destroy();oldJacarandas.instances.destroy();oldJacarandas.visible.destroy();oldJacarandas.indirect.destroy();});
  this.meshlets?.setPopulation(this.trees);
  this.jacarandaMeshlets?.setPopulation(this.jacarandas);
  this.streamGeneration=(this.streamGeneration||0)+1;
  this.streamWorker?.postMessage({type:'trees',data:this.treeData,generation:this.streamGeneration});
  this.streamPending=false;
  this.shadowKey=null;
  this.volumeDirty=true;telemetry.total=count;
 }
 resize() {
  const ratios={low:0.75,balanced:1,high:Math.min(devicePixelRatio,2)};
  const ratio=ratios[settings.quality];
  const width=Math.max(2,Math.round(innerWidth*ratio)),height=Math.max(2,Math.round(innerHeight*ratio));
  if(canvas.width===width&&canvas.height===height&&this.colorTexture) return;
  canvas.width=width;canvas.height=height;
  for(const name of ['colorTexture','normalTexture','depthTexture','postTexture','sampleColor','sampleNormal','sampleDepth','windMotion']) this[name]?.destroy();
  const usage=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;
  this.colorTexture=device.createTexture({size:[width,height],format:'rgba16float',usage});
  this.normalTexture=device.createTexture({size:[width,height],format:normalFormat,usage});
  const rasterTarget=(format,targetUsage=GPUTextureUsage.RENDER_ATTACHMENT)=>device.createTexture({size:[width,height],sampleCount:sceneSamples,format,usage:targetUsage});
  this.sampleColor=rasterTarget('rgba16float',usage);this.sampleNormal=rasterTarget(normalFormat);
  this.sampleDepth=rasterTarget('depth32float',usage);
  this.sampleColorView=this.sampleColor.createView();this.sampleNormalView=this.sampleNormal.createView();this.sampleDepthView=this.sampleDepth.createView();
  this.windMotion=device.createTexture({label:'Previous foliage pose in pixels',size:[width,height],format:motionFormat,usage});
  this.windMotionView=this.windMotion.createView();
  this.depthResolveGroup=device.createBindGroup({layout:this.depthResolvePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.sampleDepthView},{binding:1,resource:this.sampleColorView}]});
  telemetry.rasterSamples=sceneSamples;
  this.depthTexture=device.createTexture({size:[width,height],format:'depth32float',usage});
  this.postTexture=device.createTexture({size:[width,height],format:'rgba8unorm',usage});
  this.postView=this.postTexture.createView();
  this.aaGroup=device.createBindGroup({layout:this.aaPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.postView},{binding:1,resource:this.linearSampler}]});
  this.historyTextures?.forEach(texture=>texture.destroy());
  this.historyTextures=[0,1].map(()=>device.createTexture({size:[width,height],format:'rgba16float',usage}));
  this.historyViews=this.historyTextures.map(texture=>texture.createView());
  this.temporalGroups=this.historyViews.map(view=>device.createBindGroup({layout:this.temporalPipeline.getBindGroupLayout(1),entries:[{binding:0,resource:this.postView},{binding:1,resource:view},{binding:2,resource:this.depthTexture.createView()},{binding:3,resource:this.windMotionView},{binding:4,resource:{buffer:this.previousUniform}}]}));
  this.temporalAAGroups=this.historyViews.map(view=>device.createBindGroup({layout:this.aaPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:view},{binding:1,resource:this.linearSampler}]}));
  this.historyValid=false;
  this.colorView=this.colorTexture.createView();this.normalView=this.normalTexture.createView();this.depthView=this.depthTexture.createView();
  this.postGroup=device.createBindGroup({layout:this.postPipeline.getBindGroupLayout(1),entries:[{binding:0,resource:this.colorView},{binding:1,resource:this.normalView},{binding:2,resource:this.depthView}]});
  telemetry.resolution=[width,height];
 }
 applyStreaming(result) {
  this.volumeOrigin=result.origin;
  this.volumeDirty=false;this.volumeLightingDirty=true;
  if(result.grass) {
   const old=this.grass;
   const oldClose=this.closeGrass;
   const oldPlantShadow=this.plantShadowGrass;
   this.grassCenter=result.grassCenter;
   this.grassData=result.grass;
   this.grass=this.createPopulation(this.grassData,this.meadowIndexCounts,this.cullGrassPipeline);
   this.closeGrass=this.createPopulation(this.grassData,[this.closeMeadowMesh.count],this.cullCloseGrassPipeline);
  this.plantShadowGrass=this.createPopulation(this.grassData,[this.closeMeadowMesh.count,...this.meadowIndexCounts],this.cullPlantShadowPipeline);
   device.queue.onSubmittedWorkDone().then(()=>{old.instances.destroy();old.visible.destroy();old.indirect.destroy();oldClose.instances.destroy();oldClose.visible.destroy();oldClose.indirect.destroy();oldPlantShadow.instances.destroy();oldPlantShadow.visible.destroy();oldPlantShadow.indirect.destroy();});
  }
  device.queue.writeTexture({texture:this.occupancyTexture},result.voxels,{bytesPerRow:256,rowsPerImage:64},[64,64,64]);
  telemetry.volumeUpdates++;
 }
 initializeStreaming() {
  if(window.FOREST_TEST||typeof Worker==='undefined')return;
  this.streamWorker=new Worker(new URL('./stream-worker.js',import.meta.url),{type:'module'});
  this.streamWorker.postMessage({type:'trees',data:this.treeData,generation:this.streamGeneration});
  this.streamWorker.onmessage=event=>{
   const result=event.data;
   if(result.type==='grass'&&result.kind==='far') {
    this.farGrassPending=false;this.farGrassCenter=result.center;
    const old=this.farGrass;
    this.farGrass=this.createPopulation(result.grass,this.farMeadowIndexCounts,this.cullGrassPipeline);
    device.queue.onSubmittedWorkDone().then(()=>{old.instances.destroy();old.visible.destroy();old.indirect.destroy();});
    return;
   }
   if(result.generation!==this.streamGeneration)return;
   this.streamPending=false;
   if(result.type==='error') {console.warn('Forest streaming',result.message);return;}
   this.applyStreaming(result);
  };
  this.streamWorker.onerror=event=>{console.warn('Forest streaming',event.message);this.streamPending=false;this.streamWorker.terminate();this.streamWorker=null;};
 }
 updateVolume(camera) {
  if(Math.hypot(camera[0]-this.farGrassCenter[0],camera[2]-this.farGrassCenter[1])>20&&!this.farGrassPending) {
   const center=[Math.round(camera[0]/16)*16,Math.round(camera[2]/16)*16];
   if(this.streamWorker) {this.farGrassPending=true;this.streamWorker.postMessage({type:'grass',kind:'far',center,count:65536,spacing:1.6,generation:this.streamGeneration});}
   else {
    const old=this.farGrass;this.farGrassCenter=center;
    this.farGrass=this.createPopulation(createGrassInstances(65536,...center,1.6),this.farMeadowIndexCounts,this.cullGrassPipeline);
    device.queue.onSubmittedWorkDone().then(()=>{old.instances.destroy();old.visible.destroy();old.indirect.destroy();});
   }
  }
  const origin=[Math.floor(camera[0]/64)*64-256,0,Math.floor(camera[2]/64)*64-256];
  const grassMoved=Math.hypot(camera[0]-this.grassCenter[0],camera[2]-this.grassCenter[1])>7;
  if(!this.volumeDirty&&!grassMoved&&origin[0]===this.volumeOrigin[0]&&origin[2]===this.volumeOrigin[2])return;
  if(this.streamPending)return;
  const request={camera:[...camera],grassCenter:this.grassCenter,grassCount:this.grassCount,force:this.volumeDirty};
  if(this.streamWorker) {
   this.streamPending=true;
   this.streamWorker.postMessage({type:'stream',...request,generation:this.streamGeneration});
  } else this.applyStreaming(buildStreamingData({...request,treeData:this.treeData}));
 }
 updateUniforms(time) {
  const direction=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)];
  const vp=multiply(perspective(FIELD_OF_VIEW,canvas.width/canvas.height,0.25,14000),lookAt(position,position.map((p,i)=>p+direction[i])));
  const offsets=[[0,-1/6],[-0.25,1/6],[0.25,-7/18],[-0.375,-1/18],[0.125,5/18],[-0.125,-5/18],[0.375,1/18],[-0.4375,7/18]];
  const jitter=settings.debug==='beauty'?offsets[this.frameIndex%offsets.length]:[0,0];
  for(let column=0;column<4;column++) {
   vp[column*4]+=2*jitter[0]/canvas.width*vp[column*4+3];
   vp[column*4+1]+=2*jitter[1]/canvas.height*vp[column*4+3];
  }
  this.currentVP=vp;
  const elevation=settings.sunElevation*Math.PI/180,azimuth=settings.sunAzimuth*Math.PI/180;
  const sun=[Math.cos(azimuth)*Math.cos(elevation),Math.sin(elevation),Math.sin(azimuth)*Math.cos(elevation)];
  const anchor=[Math.floor(position[0]/48)*48,Math.floor(position[2]/48)*48];
  const key=anchor.join(',')+','+settings.sunElevation+','+settings.sunAzimuth+','+this.trees.total;
  this.redrawShadow=key!==this.shadowKey;
  if(this.redrawShadow) {
   this.shadowKey=key;
   const center=[anchor[0],terrainHeight(...anchor)+35,anchor[1]];
   const lightEye=center.map((p,i)=>p+sun[i]*900);
   this.lightVP=multiply(orthographic(-SHADOW_HALF_WIDTH,SHADOW_HALF_WIDTH,-SHADOW_HALF_WIDTH,SHADOW_HALF_WIDTH,1,2400),lookAt(lightEye,center));
   this.lightVP[12]=Math.round(this.lightVP[12]*2048)/2048;
   this.lightVP[13]=Math.round(this.lightVP[13]*2048)/2048;
  }
  const lightVP=this.lightVP;
  const data=this.uniformData;
  data.set(vp,0);data.set(inverse(vp),16);data.set(lightVP,32);
  data.set([...position,1],48);
  data.set([...sun,this.historyValid?this.lastPoseWind:settings.wind],52);
  data.set(this.historyValid?this.previousVP:vp,76);
  data.set([...(this.historyValid?this.lastPoseEye:position),this.historyValid?this.lastPoseTime:time],92);
  data.set([canvas.width,canvas.height,time,settings.wind],56);
  data.set([['beauty','lod','normal','ao'].indexOf(settings.debug),1.0,settings.sky==='volumetric'?1:0,settings.quality==='high'?1:0],60);
  const detail=settings.quality==='high'?[90,280]:settings.quality==='low'?[25,100]:[65,180];
  data.set([this.trees.total,...detail,settings.quality==='low'?1600:3000],64);
  data.set([...direction,FIELD_OF_VIEW],68);data.set([...this.volumeOrigin,this.trees.capacity],72);
  device.queue.writeBuffer(this.uniformBuffer,0,data);
  const previousData=new Float32Array(20);
  if(this.historyValid) previousData.set(historyTransform(vp,this.previousVP));
  previousData[16]=this.historyValid?1:0;
  const currentJitterUV=[jitter[0]/canvas.width,-jitter[1]/canvas.height];
  const previousJitterUV=this.previousJitterUV||currentJitterUV;
  previousData[17]=currentJitterUV[0]-previousJitterUV[0];
  previousData[18]=currentJitterUV[1]-previousJitterUV[1];
  this.historySamples=this.historyValid?Math.min(20,(this.historySamples||0)+1):0;
  previousData[19]=this.historySamples/(this.historySamples+1);
  this.previousJitterUV=currentJitterUV;
  device.queue.writeBuffer(this.previousUniform,0,previousData);
 }
 encodeVolume(encoder) {
  if(!this.volumeLightingDirty)return;
  this.volumeLightingDirty=false;
  let pass=encoder.beginComputePass({label:'Inject one-bounce voxel radiance'});
  pass.setPipeline(this.volumePipeline);pass.setBindGroup(0,this.volumeUniformGroup);pass.setBindGroup(1,this.volumeGroup);pass.dispatchWorkgroups(16,16,16);pass.end();
  for(let level=1;level<7;level++) {
   pass=encoder.beginComputePass({label:'Filter voxel radiance mip '+level});
   pass.setPipeline(this.mipPipeline);pass.setBindGroup(0,this.mipGroups[level-1]);
   const groups=Math.ceil((64>>level)/4);pass.dispatchWorkgroups(groups,groups,groups);pass.end();
  }
 }
 drawMesh(pass,mesh,group) {
  if(group)pass.setBindGroup(1,group);
  pass.setVertexBuffer(0,mesh.vertex);pass.setIndexBuffer(mesh.index,'uint32');
 }
 render(time) {
  this.resize();
  if(time-this.lastVolumeTime>0.15) {this.updateVolume(position);this.lastVolumeTime=time;}
  this.updateUniforms(time);
  this.hedgerowTriangles=this.hedgerow.update(position,this.uniformData);
  device.queue.writeBuffer(this.trees.indirect,0,this.trees.argumentData);
  device.queue.writeBuffer(this.jacarandas.indirect,0,this.jacarandas.argumentData);
  device.queue.writeBuffer(this.grass.indirect,0,this.grass.argumentData);
  device.queue.writeBuffer(this.closeGrass.indirect,0,this.closeGrass.argumentData);
  device.queue.writeBuffer(this.plantShadowGrass.indirect,0,this.plantShadowGrass.argumentData);
  device.queue.writeBuffer(this.farGrass.indirect,0,this.farGrass.argumentData);
  const encoder=device.createCommandEncoder({label:'Forest frame'});
  this.encodeVolume(encoder);
  let pass=encoder.beginComputePass({label:'GPU visibility and LOD'});
  pass.setPipeline(this.cullTreePipeline);pass.setBindGroup(0,this.cullTreeUniformGroup);pass.setBindGroup(1,this.trees.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.trees.total/128));
  pass.setBindGroup(1,this.jacarandas.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.jacarandas.total/128));
  pass.setPipeline(this.cullGrassPipeline);pass.setBindGroup(0,this.cullGrassUniformGroup);pass.setBindGroup(1,this.grass.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.grass.total/128));
  pass.setBindGroup(1,this.farGrass.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.farGrass.total/128));
  pass.setPipeline(this.cullCloseGrassPipeline);pass.setBindGroup(0,this.cullCloseGrassUniformGroup);pass.setBindGroup(1,this.closeGrass.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.closeGrass.total/128));
  pass.setPipeline(this.cullPlantShadowPipeline);pass.setBindGroup(0,this.cullPlantShadowGroup);pass.setBindGroup(1,this.plantShadowGrass.cullGroup);pass.dispatchWorkgroups(Math.ceil(this.plantShadowGrass.total/128));pass.end();
  this.meshlets.cull(encoder);
  this.jacarandaMeshlets.cull(encoder);
  if(this.redrawShadow) {
  pass=encoder.beginRenderPass({label:'Sun shadows',colorAttachments:[],depthStencilAttachment:{view:this.shadowView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setBindGroup(0,this.uniformGroup);
  pass.setBindGroup(2,this.shadowMaterialGroup);
  pass.setPipeline(this.terrainShadowPipeline);this.drawMesh(pass,this.meshes.terrain,this.trees.groups[0]);pass.drawIndexed(this.meshes.terrain.count);
  pass.setPipeline(this.shadowPipeline);this.drawMesh(pass,this.meshes.shadow,this.trees.groups[3]);pass.drawIndexedIndirect(this.trees.indirect,60);
  this.drawMesh(pass,this.meshes.mid,this.trees.groups[4]);pass.drawIndexedIndirect(this.trees.indirect,80);
  this.drawMesh(pass,this.jacarandaMeshes.canopy,this.jacarandas.groups[3]);pass.drawIndexedIndirect(this.jacarandas.indirect,60);
  this.drawMesh(pass,this.jacarandaMeshes.mid,this.jacarandas.groups[4]);pass.drawIndexedIndirect(this.jacarandas.indirect,80);
  this.hedgerow.draw(pass,'wide');pass.end();
  }
  const center=[position[0],terrainSurfaceHeight(position[0],position[2])+0.4,position[2]];
  const sun=this.uniformData.subarray(52,55);
  const lightEye=center.map((p,i)=>p+sun[i]*50);
  const plantVP=multiply(orthographic(-16,16,-16,16,1,110),lookAt(lightEye,center));
  plantVP[12]=Math.round(plantVP[12]*1024)/1024;plantVP[13]=Math.round(plantVP[13]*1024)/1024;
  const plantData=new Float32Array(this.uniformData);plantData.set(plantVP,32);
  device.queue.writeBuffer(this.plantShadowUniform,0,plantData);device.queue.writeBuffer(this.plantMatrixBuffer,0,plantVP);
  pass=encoder.beginRenderPass({label:'Blade and leaf shadows',colorAttachments:[],depthStencilAttachment:{view:this.plantShadowView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setBindGroup(0,this.plantShadowGroup);pass.setBindGroup(2,this.shadowMaterialGroup);pass.setPipeline(this.liveShadowPipeline);
  this.drawMesh(pass,this.closeMeadowMesh,this.plantShadowGrass.groups[0]);pass.drawIndexedIndirect(this.plantShadowGrass.indirect,0);
  for(let variant=0;variant<this.meadowMeshes.length;variant++){
   const bucket=variant+1;
   this.drawMesh(pass,this.meadowMeshes[variant],this.plantShadowGrass.groups[bucket]);
   pass.drawIndexedIndirect(this.plantShadowGrass.indirect,bucket*20);
  }
  this.hedgerow.draw(pass,'close');pass.end();
  pass=encoder.beginRenderPass({label:'Opaque terrain and vegetation',colorAttachments:[{view:this.sampleColorView,resolveTarget:this.colorView,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'},{view:this.sampleNormalView,resolveTarget:this.normalView,clearValue:[0.5,1,0.5,1],loadOp:'clear',storeOp:'discard'}],depthStencilAttachment:{view:this.sampleDepthView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setBindGroup(0,this.uniformGroup);pass.setPipeline(this.skyPipeline);pass.setBindGroup(1,this.cloudGroup);pass.draw(3);
  pass.setPipeline(this.terrainPipeline);pass.setBindGroup(2,this.lightGroup);this.drawMesh(pass,this.meshes.terrain,this.trees.groups[0]);pass.drawIndexed(this.meshes.terrain.count);
  this.drawMesh(pass,this.meshes.canopy,this.trees.groups[0]);pass.drawIndexed(this.meshes.canopy.count);
  this.meshlets.draw(pass,this.uniformGroup,this.lightGroup);
  this.jacarandaMeshlets.draw(pass,this.uniformGroup,this.lightGroup);
  pass.setPipeline(this.treePipeline);pass.setBindGroup(2,this.lightGroup);
  this.drawMesh(pass,this.meshes.mid,this.trees.groups[1]);pass.drawIndexedIndirect(this.trees.indirect,20);
  this.drawMesh(pass,this.jacarandaMeshes.mid,this.jacarandas.groups[1]);pass.drawIndexedIndirect(this.jacarandas.indirect,20);
  this.hedgerow.draw(pass,'near');this.hedgerow.draw(pass,'far');
  this.impostors.render(pass,this.trees,5,100,this.uniformGroup,this.lightGroup);
  this.impostors.render(pass,this.trees,2,40,this.uniformGroup,this.lightGroup);
  this.jacarandaImpostors.render(pass,this.jacarandas,5,100,this.uniformGroup,this.lightGroup);
  this.jacarandaImpostors.render(pass,this.jacarandas,2,40,this.uniformGroup,this.lightGroup);
  pass.setPipeline(this.treePipeline);pass.setBindGroup(0,this.uniformGroup);pass.setBindGroup(2,this.lightGroup);
  this.drawMesh(pass,this.closeMeadowMesh,this.closeGrass.groups[0]);pass.drawIndexedIndirect(this.closeGrass.indirect,0);
  this.meadowMeshes.forEach((mesh,index)=>{
   this.drawMesh(pass,mesh,this.grass.groups[index]);pass.drawIndexedIndirect(this.grass.indirect,index*20);
   this.drawMesh(pass,this.farMeadowMeshes[index],this.farGrass.groups[index]);pass.drawIndexedIndirect(this.farGrass.indirect,index*20);
  });pass.end();
  pass=encoder.beginRenderPass({label:'Resolve paired depth and foliage motion',colorAttachments:[{view:this.windMotionView,loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}],depthStencilAttachment:{view:this.depthView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setPipeline(this.depthResolvePipeline);pass.setBindGroup(0,this.depthResolveGroup);pass.draw(3);pass.end();
  pass=encoder.beginRenderPass({label:'Screen-space occlusion, bounce and atmosphere',colorAttachments:[{view:this.postView,loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});
  pass.setPipeline(this.postPipeline);pass.setBindGroup(0,this.postUniformGroup);pass.setBindGroup(1,this.postGroup);pass.draw(3);pass.end();
  const historyIndex=this.frameIndex%2;
  pass=encoder.beginRenderPass({label:'Reproject and resolve foliage history',colorAttachments:[{view:this.historyViews[historyIndex],loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}]});
  pass.setPipeline(this.temporalPipeline);pass.setBindGroup(0,this.temporalUniformGroup);pass.setBindGroup(1,this.temporalGroups[1-historyIndex]);pass.draw(3);pass.end();
  pass=encoder.beginRenderPass({label:'Antialias foliage edges',colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}]});
  pass.setPipeline(this.aaPipeline);pass.setBindGroup(0,this.temporalAAGroups[historyIndex]);pass.draw(3);pass.end();
  const sampleCounts=!this.reading&&frames%45===0;
  if(sampleCounts) {
   encoder.copyBufferToBuffer(this.trees.indirect,0,this.readback,0,80);encoder.copyBufferToBuffer(this.grass.indirect,0,this.readback,80,20);
   encoder.copyBufferToBuffer(this.meshlets.counterBuffer,0,this.readback,100,16);encoder.copyBufferToBuffer(this.trees.indirect,100,this.readback,116,20);
   encoder.copyBufferToBuffer(this.farGrass.indirect,0,this.readback,136,20);encoder.copyBufferToBuffer(this.jacarandas.indirect,0,this.readback,156,120);
   encoder.copyBufferToBuffer(this.jacarandaMeshlets.counterBuffer,0,this.readback,276,16);
   encoder.copyBufferToBuffer(this.grass.indirect,20,this.readback,292,60);
   encoder.copyBufferToBuffer(this.farGrass.indirect,20,this.readback,352,60);
   encoder.copyBufferToBuffer(this.closeGrass.indirect,0,this.readback,412,20);
  }
  device.queue.submit([encoder.finish()]);
  this.lastPoseTime=time;this.lastPoseWind=settings.wind;this.lastPoseEye=[...position];
  this.previousVP.set(this.currentVP);this.historyValid=true;this.frameIndex++;
  if(sampleCounts) this.readCounts();
 }
 async readCounts() {
  this.reading=true;
  try {
   await this.readback.mapAsync(GPUMapMode.READ);
   const counters=new Uint32Array(this.readback.getMappedRange());
   telemetry.counts=[counters[1]+counters[40],counters[6]+counters[45],counters[11]+counters[30]+counters[50]+counters[65]];
   telemetry.canopyInstances=counters[30]+counters[65];telemetry.farInstances=counters[11]+counters[50];
   telemetry.jacarandaMid=counters[45];telemetry.jacarandaNear=counters[40];
   telemetry.closeGrass=counters[104];
   telemetry.grassVariants=[counters[21],counters[74],counters[79],counters[84]];
   telemetry.farGrassVariants=[counters[35],counters[89],counters[94],counters[99]];
   telemetry.grass=telemetry.grassVariants.reduce((a,b)=>a+b,0);telemetry.farGrass=telemetry.farGrassVariants.reduce((a,b)=>a+b,0);telemetry.visibleMeshlets=counters[26]+counters[70];telemetry.shadowTrees=counters[16]+counters[55];
   this.readback.unmap();
   this.refreshStats();
  } catch(error) {console.warn('Counter readback',error.message);}
  finally {this.reading=false;}
 }
 refreshStats() {
  const [near,mid,far]=telemetry.counts;
  const jacarandaMid=telemetry.jacarandaMid||0;
  const triangles=(this.hedgerowTriangles||0)+(telemetry.closeGrass||0)*this.closeMeadowMesh.count/3+this.meshStats.terrain+this.meshStats.canopy+(telemetry.visibleMeshlets||0)*64+(mid-jacarandaMid)*this.meshStats.mid+jacarandaMid*this.jacarandaMeshes.mid.count/3+far*2+this.meadowMeshes.reduce((sum,mesh,i)=>sum+((telemetry.grassVariants?.[i]||0)*mesh.count+(telemetry.farGrassVariants?.[i]||0)*this.farMeadowMeshes[i].count)/3,0);
  telemetry.triangles=triangles;
  updateStats({fps:telemetry.fps,trees:near+mid+far,near,mid,far,total:this.trees.total+this.jacarandas.total,triangles});
 }
}

function stopRendering(error) {
 if(fatal)return;
 fatal=true;
 screenshotCapture?.cancel();
 telemetry.status='error';
 console.error(error);
 setError(error);
}

function animate(now) {
 if(fatal)return;
 if((renderer.pendingFrames||0)>=2) {requestAnimationFrame(animate);return;}
 const dt=Math.min((now-lastTime)/1000,0.1);lastTime=now;
 if(tour) {
  tourTime+=dt;
  const x=-140+Math.sin(tourTime*0.06)*270,z=135-Math.sin(tourTime*0.035)*460;
  const height=terrainHeight(x,z)+12+Math.sin(tourTime*0.025)**2*85;
  position=[x,height,z];aimAt([x+130,terrainHeight(x+130,z-250)+35,z-250]);
 } else {
  ({position,yaw,pitch}=controller.update(dt,position,yaw,pitch,terrainSurfaceHeight));
 }
 try {
  renderer.render(now/1000);
  if(device&&telemetry.mode==='WebGPU') {
   renderer.pendingFrames=(renderer.pendingFrames||0)+1;
   device.queue.onSubmittedWorkDone().then(()=>{
    telemetry.completedFrames=(telemetry.completedFrames||0)+1;
   },stopRendering).finally(()=>{renderer.pendingFrames--;});
  }
  frames++;telemetry.frames=frames;telemetry.camera=[...position,yaw,pitch];
  screenshotCapture?.afterDraw();
  if(frames===1) setLoading('Ready to explore',1);
 } catch(error) {stopRendering(error);return;}
 if(now-fpsTime>700) {telemetry.fps=1000*(frames-(telemetry.lastFpsFrame||0))/(now-fpsTime);telemetry.lastFpsFrame=frames;fpsTime=now;renderer.refreshStats();}
 requestAnimationFrame(animate);
}

async function start() {
 renderer=new ForestRenderer();
 try {
  setView('meadow');
  await renderer.initialize();
  telemetry.mode='WebGPU';
  const mode=document.createElement('span');mode.className='renderer-mode';mode.textContent='WebGPU · 16 km²';document.querySelector('.performance').prepend(mode);
 } catch(error) {
  // A successfully acquired canvas context keeps its type for the lifetime
  // of that element. Let WebGL try a fresh canvas on partial GPU startup.
  telemetry.webgpuStartupError=error.message;
  renderer.retired=true;
  renderer.streamWorker?.terminate();
  if(renderer.context) {
   renderer.context.unconfigure();
   const replacement=canvas.cloneNode(false);
   canvas.replaceWith(replacement);
   canvas=replacement;
  }
  device?.destroy();
  device=null;
  const { startFallback }=await import('./fallback.js');
  renderer=await startFallback(canvas,{settings,telemetry,setLoading,setError:stopRendering,getCamera:()=>({position,yaw,pitch})});
  telemetry.mode='WebGL2 compatibility';
 }
 screenshotCapture=setupScreenshot(canvas);
 controller=setupControls(canvas,{
  onView:setView,
  onSetting(key,value) {
   settings[key]=value;
   if(key==='density')renderer.rebuildPopulation(value);
   renderer.historyValid=false;
   if(key==='sunElevation'||key==='sunAzimuth'||key==='sky')renderer.volumeLightingDirty=true;
  },
  onTour(active){tour=active;tourTime=0;},
  onScreenshot(){screenshotCapture.request();}
 });
 controller.setView('meadow');
 lastTime=performance.now();fpsTime=lastTime;
 requestAnimationFrame(animate);
}
async function showCaptures(reason) {
 const {showRenderedViews}=await import('./rendered-views.js');
 telemetry.status='recorded-views';
 showRenderedViews(reason);
}
if(!window.FOREST_TEST) {
 if(new URLSearchParams(location.search).get('view')==='stills') showCaptures('1920 × 1080 · Recorded views').catch(setError);
 else start().catch(error=>{
  if(error.code==='NO_GRAPHICS_CONTEXT') {
   showCaptures('Recorded views · Live graphics unavailable in this browser').catch(setError);
  } else {console.error(error);telemetry.status='error';setError(error);}
 });
}
