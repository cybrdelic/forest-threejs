import {create,globals} from 'webgpu';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

Object.assign(globalThis,globals);
const SITE_DIRECTORY=process.env.FOREST_SITE_DIRECTORY||fileURLToPath(new URL('../../dist/',import.meta.url));
const OUTPUT_DIRECTORY=process.env.FOREST_QA_OUTPUT||fileURLToPath(new URL('../../qa-output/webgpu/',import.meta.url));
await fs.mkdir(OUTPUT_DIRECTORY,{recursive:true});
const width=Number(process.env.TEST_WIDTH||960);
const height=Number(process.env.TEST_HEIGHT||540);
const frameCount=Number(process.env.TEST_FRAMES||1);
const sceneFrameCounts=new Map((process.env.TEST_SCENE_FRAMES||'').split(',').filter(Boolean).map(entry=>{const[name,count]=entry.split(':');return[name,Number(count)];}));
const motion=process.env.TEST_MOTION==='1';
const deltaTime=Number(process.env.TEST_DELTA_TIME||(motion?0.25:1/60));
const panStep=Number(process.env.TEST_PAN_STEP_DEGREES||0)*Math.PI/180;
const motionFrames=[];
const sceneNames=(process.env.TEST_SCENES||process.argv[2]||'meadow').split(',').map(name=>name.trim()).filter(Boolean);
const label=process.env.TEST_LABEL||'v5';
const nativeGpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
let device,output;
const errors=[];
const context={
 configure(options){
  device=options.device;
  output=device.createTexture({label:'Native offscreen canvas',size:[width,height],format:options.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
 },
 getCurrentTexture(){return output;}
};
const nodes=new Map();
function node(id){
 if(!nodes.has(id))nodes.set(id,{id,style:{},classList:{add(){},remove(){},toggle(){}},hidden:false,textContent:'',width:0,height:0,addEventListener(){},setAttribute(){},getContext(){return context;}});
 return nodes.get(id);
}
Object.defineProperty(globalThis,'navigator',{value:{gpu:{
 requestAdapter:async()=>{
  const adapter=await nativeGpu.requestAdapter({forceFallbackAdapter:true});
  if(!adapter)throw new Error('Native WebGPU adapter unavailable');
  return {info:adapter.info,requestDevice:async()=>{
   device=await adapter.requestDevice();
   device.addEventListener('uncapturederror',event=>{errors.push(event.error.message);console.error('UNCAPTURED',event.error.message);});
   device.pushErrorScope('validation');
   return device;
  }};
 },
 getPreferredCanvasFormat:()=> 'rgba8unorm'
}},configurable:true});
globalThis.window={FOREST_TEST:true};
globalThis.document={getElementById:node};
globalThis.innerWidth=width;globalThis.innerHeight=height;globalThis.devicePixelRatio=1;
globalThis.requestAnimationFrame=callback=>setImmediate(()=>callback(performance.now()));

// New raw binary assets can be exercised without requiring browser fetch.
// This also supports future Jacaranda mesh and impostor asset file names.
const nativeFetch=globalThis.fetch;
const fetchedAssets={};
globalThis.fetch=async(input,options)=>{
 const supplied=input instanceof URL?input:new URL(typeof input==='string'?input:input.url,pathToFileURL(SITE_DIRECTORY+'/'));
 if(supplied.protocol==='file:'){
  const filename=fileURLToPath(supplied);
  const relative=path.relative(SITE_DIRECTORY,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Native fixture fetch is outside the Site directory');
  try{
   const bytes=await fs.readFile(filename);
   fetchedAssets[relative]=createHash('sha256').update(bytes).digest('hex');
   return new Response(bytes,{status:200,headers:{'content-type':filename.endsWith('.json')?'application/json':'application/octet-stream'}});
  }catch(error){
   if(error.code==='ENOENT')return new Response('Missing native fixture asset',{status:404});
   throw error;
  }
 }
 return nativeFetch(input,options);
};

async function collectAssets(directory,prefix=''){
 const entries=await fs.readdir(directory,{withFileTypes:true});
 const assets=[];
 for(const entry of entries){
  const filename=path.join(directory,entry.name),relative=prefix+entry.name;
  if(entry.isDirectory())assets.push(...await collectAssets(filename,relative+'/'));
  else if(entry.isFile()&&entry.name.endsWith('.bin'))assets.push({relative,bytes:new Uint8Array(await fs.readFile(filename))});
 }
 return assets;
}
async function hashAssets(directory,prefix=''){
 const output={};
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const filename=path.join(directory,entry.name),relative=prefix+entry.name;
  if(entry.isDirectory())Object.assign(output,await hashAssets(filename,relative+'/'));
  else if(entry.isFile()&&/\.(bin|png|json|js)$/.test(entry.name))output['assets/'+relative]=createHash('sha256').update(await fs.readFile(filename)).digest('hex');
 }
 return output;
}
const assets=await collectAssets(path.join(SITE_DIRECTORY,'assets'));
globalThis.forestMaterialBytes={};
globalThis.forestGeometryBytes={};
globalThis.forestImpostorBytes={};
const geometryDirectory=(process.env.TEST_GEOMETRY_DIRECTORY||'trees').replace(/\/$/,'');
for(const {relative,bytes} of assets){
 const filename=path.basename(relative);
 if(relative.startsWith('impostors/'))globalThis.forestImpostorBytes[filename.slice(0,-4)]=bytes;
 globalThis.forestMaterialBytes[relative.slice(0,-4)]=bytes;
 globalThis.forestGeometryBytes[relative]=bytes;
 if(relative.startsWith(geometryDirectory+'/'))globalThis.forestGeometryBytes[filename]=bytes;
 if(!relative.includes('/'))globalThis.forestMaterialBytes[filename.slice(0,-4)]=bytes;
}
console.log('NATIVE_ASSETS',assets.map(asset=>({name:asset.relative,bytes:asset.bytes.byteLength})));

const sourceHashes={};
for(const entry of await fs.readdir(SITE_DIRECTORY)){if(entry.endsWith('.js'))sourceHashes[entry]=createHash('sha256').update(await fs.readFile(path.join(SITE_DIRECTORY,entry))).digest('hex');}
Object.assign(sourceHashes,await hashAssets(path.join(SITE_DIRECTORY,'assets')));

const application=await import(pathToFileURL(path.join(SITE_DIRECTORY,'main.js')).href);
const {ForestRenderer,setView,setCamera,settings}=application;
if(process.env.TEST_QUALITY)settings.quality=process.env.TEST_QUALITY;
if(process.env.TEST_WIND !== undefined)settings.wind=Number(process.env.TEST_WIND);
if(process.env.TEST_DENSITY)settings.density=Number(process.env.TEST_DENSITY);
if(process.env.TEST_DEBUG)settings.debug=process.env.TEST_DEBUG;
if(process.env.TEST_SUN!==undefined)settings.sunElevation=Number(process.env.TEST_SUN);
if(process.env.TEST_SUN_AZIMUTH!==undefined)settings.sunAzimuth=Number(process.env.TEST_SUN_AZIMUTH);
function chooseScene(name){
 if(name==='edge')return import(pathToFileURL(path.join(SITE_DIRECTORY,'landscape.js')).href).then(({terrainHeight,CAMERA_START})=>setCamera([-245,terrainHeight(-245,172)+1.7,172],CAMERA_START.target));
 setView(name);
}
await chooseScene(sceneNames[0]);
const renderer=new ForestRenderer();
const initStart=performance.now();
await renderer.initialize();
const initializationMilliseconds=performance.now()-initStart;
console.log('INITIALIZATION_MS',initializationMilliseconds);
function savePNG(pixels,width,height,pitch,filename) {
 const script=[
  'from PIL import Image',
  'import sys',
  "image=Image.frombytes('RGBA',(int(sys.argv[1]),int(sys.argv[2])),sys.stdin.buffer.read(),'raw','RGBA',int(sys.argv[3]))",
  "assert image.getchannel('A').getextrema()==(255,255),'Incomplete alpha in native scene capture'",
  "assert max(high-low for low,high in image.getextrema()[:3])>16,'Flat native scene capture'",
  'image.save(sys.argv[4])'
 ].join('\n');
 const result=spawnSync('python',['-c',script,String(width),String(height),String(pitch),filename],{input:pixels});
 if(result.status!==0)throw Error('PNG readback failed: '+result.stderr);
}
async function captureProgressFrame(scene,frame) {
 const pitch=Math.ceil(width*4/256)*256;
 const buffer=device.createBuffer({size:pitch*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const encoder=device.createCommandEncoder();
 encoder.copyTextureToBuffer({texture:output},{buffer,bytesPerRow:pitch,rowsPerImage:height},[width,height]);
 device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
 const filename=path.join(OUTPUT_DIRECTORY,label+'-'+scene+'-frame-'+String(frame).padStart(3,'0')+'.png');
 savePNG(new Uint8Array(buffer.getMappedRange()),width,height,pitch,filename);
 buffer.unmap();buffer.destroy();
}
const captures=[];
for(const scene of sceneNames){
 await chooseScene(scene);
 renderer.historyValid=false;
 renderer.volumeDirty=true;
 renderer.lastVolumeTime=-Infinity;
 const renderTimes=[];
 const frameCameras=[];
 const framesForScene=sceneFrameCounts.get(scene)||frameCount;
 for(let frame=0;frame<framesForScene;frame++){
  const start=performance.now();
  if((motion||panStep)&&frame>0){
   const camera=Array.from(renderer.uniformData.slice(48,51));
   const direction=Array.from(renderer.uniformData.slice(68,71));
   if(motion) {
    const horizontalLength=Math.hypot(direction[0],direction[2]);
    const {terrainSurfaceHeight}=await import(pathToFileURL(path.join(SITE_DIRECTORY,'landscape.js')).href);
    const clearance=camera[1]-terrainSurfaceHeight(camera[0],camera[2]);
    camera[0]+=-direction[2]/horizontalLength*deltaTime;
    camera[2]+=direction[0]/horizontalLength*deltaTime;
    camera[1]=terrainSurfaceHeight(camera[0],camera[2])+clearance;
   }
   if(panStep) {
    const [x,,z]=direction;
    direction[0]=x*Math.cos(panStep)-z*Math.sin(panStep);
    direction[2]=x*Math.sin(panStep)+z*Math.cos(panStep);
   }
   // setCamera is normally a teleport API. A continuous camera fixture must
   // preserve history and let ordinary distance checks update streaming.
   const historyWasValid=renderer.historyValid, volumeWasDirty=renderer.volumeDirty;
   setCamera(camera,camera.map((value,index)=>value+direction[index]*100));
   renderer.historyValid=historyWasValid;
   renderer.volumeDirty=volumeWasDirty;
  }
  renderer.render(1+frame*deltaTime);
  await device.queue.onSubmittedWorkDone();
  frameCameras.push({position:Array.from(renderer.uniformData.slice(48,51)),forward:Array.from(renderer.uniformData.slice(68,71)),verticalFov:renderer.uniformData[71]});
  renderTimes.push(performance.now()-start);
  console.log('FRAME',scene,frame,'milliseconds',renderTimes.at(-1),'historyValid',renderer.historyValid,'frameIndex',renderer.frameIndex);
  if(process.env.TEST_PROGRESS_PNG==='1')await captureProgressFrame(scene,frame);
  if(motion){
   const rowPitch=Math.ceil(width*4/256)*256;
   const motionBuffer=device.createBuffer({size:rowPitch*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const copy=device.createCommandEncoder();
   copy.copyTextureToBuffer({texture:output},{buffer:motionBuffer,bytesPerRow:rowPitch,rowsPerImage:height},[width,height]);
   device.queue.submit([copy.finish()]);await motionBuffer.mapAsync(GPUMapMode.READ);
   const motionBase=path.join(OUTPUT_DIRECTORY,label+'-'+scene+'-frame-'+String(frame).padStart(3,'0'));
   await fs.writeFile(motionBase+'.rgba',new Uint8Array(motionBuffer.getMappedRange()));
   motionBuffer.unmap();motionBuffer.destroy();
   motionFrames.push({scene,frame,time:1+frame*deltaTime,filename:motionBase+'.rgba',camera:Array.from(renderer.uniformData.slice(48,51)),historyValid:renderer.historyValid});
  }
 }
 const bytesPerRow=Math.ceil(width*4/256)*256;
 const readback=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const encoder=device.createCommandEncoder();
 encoder.copyTextureToBuffer({texture:output},{buffer:readback,bytesPerRow,rowsPerImage:height},[width,height]);
 device.queue.submit([encoder.finish()]);
 await readback.mapAsync(GPUMapMode.READ);
 const raw=new Uint8Array(readback.getMappedRange());
 const outputBase=path.join(OUTPUT_DIRECTORY,label+'-'+scene);
 await fs.writeFile(outputBase+'.rgba',raw);
 const telemetry=structuredClone(window.forestDiagnostics);
 const indirectCounters={};
 for(const name of ['grass','farGrass','trees','jacarandas']){
  const population=renderer[name];if(!population?.indirect||!population.argumentData)continue;
  const size=population.argumentData.byteLength;
  const buffer=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const copy=device.createCommandEncoder();copy.copyBufferToBuffer(population.indirect,0,buffer,0,size);device.queue.submit([copy.finish()]);await buffer.mapAsync(GPUMapMode.READ);
  const raw=new Uint32Array(buffer.getMappedRange());
  indirectCounters[name]={total:population.total,capacity:population.capacity,draws:Array.from({length:raw.length/5},(_,index)=>({indexCount:raw[index*5],instanceCount:raw[index*5+1]}))};buffer.unmap();buffer.destroy();
 }
 const metadata={scene,width,height,bytesPerRow,frameCount:framesForScene,deltaTime,panStepRadians:panStep,frameCameras,sunAzimuth:settings.sunAzimuth,sunElevation:settings.sunElevation,wind:settings.wind,quality:settings.quality,density:settings.density,errors:[...errors],initializationMilliseconds,renderTimes,sourceHashes,fetchedAssets:{...fetchedAssets},indirectCounters,telemetry,motion:motion?{deltaTime,horizontalSpeedMetresPerSecond:1,frames:motionFrames.filter(frame=>frame.scene===scene),note:"Sparse offline camera samples. Render times are software timings, not playback frame rate."}:null};
 await fs.writeFile(outputBase+'.json',JSON.stringify(metadata,null,2));
 savePNG(raw,width,height,bytesPerRow,outputBase+'.png');
 console.log('PNG',outputBase+'.png');
 readback.unmap();readback.destroy();
 captures.push({scene,outputBase,metadata});
 console.log('CAPTURE',JSON.stringify({scene,outputBase,telemetry}));
}
const scoped=await device.popErrorScope();
if(scoped){errors.push(scoped.message);console.error('VALIDATION',scoped.message);}
for(const capture of captures){capture.metadata.errors=[...errors];await fs.writeFile(capture.outputBase+'.json',JSON.stringify(capture.metadata,null,2));}
console.log('QUALIFICATION',JSON.stringify({errors,captures:captures.map(({scene,outputBase})=>({scene,outputBase}))}));
device.destroy();
process.exit(errors.length?1:0);
