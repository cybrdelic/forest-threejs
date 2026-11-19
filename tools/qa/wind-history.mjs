// Native WebGPU, matched scene and time. Exercise the actual foreground mesh,
// production vertex wind, majority-sample depth/motion and temporal shader.
// A two-tone material isolates coverage and geometric ghosting from lighting.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {create,globals} from 'webgpu';
import {closeMeadow} from '../../dist/meadow-botany.js';
import {geometryShader} from '../../dist/shaders.js';
import {depthResolveShader} from '../../dist/sample-coverage.js';
import {temporalShader,historyTransform} from '../../dist/temporal.js';
import {inverse,multiply,perspective,lookAt} from '../../dist/math.js';

Object.assign(globalThis,globals);
const api=create(['backend=vulkan']);
// The native WebGPU binding tears down Vulkan worker threads when its GPU
// handle is collected, even if render resources still exist.
globalThis.forestWindGPU=api;
const adapter=await api.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();
globalThis.forestWindAdapter=adapter;
device.pushErrorScope('validation');
const width=112,height=80, supersample=Number(process.env.WIND_QA_SCALE||8), frames=Number(process.env.WIND_QA_FRAMES||32), warmup=Math.min(8,Math.floor(frames/3));
assert(Number.isInteger(frames)&&frames>=4 && Number.isInteger(supersample)&&supersample>=1 && supersample<=16);
const offsets=[[0,-1/6],[-.25,1/6],[.25,-7/18],[-.375,-1/18],[.125,5/18],[-.125,-5/18],[.375,1/18],[-.4375,7/18]];
const output=process.env.WIND_QA_OUTPUT;
if(output)mkdirSync(output,{recursive:true});
const buf=(size,usage)=>device.createBuffer({size,usage});
function uploaded(array,usage){
 const b=buf(array.byteLength,usage|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(b,0,array);return b;
}
const uniform=length=>buf(length*4,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
const group=(pipeline,i,resources)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(i),entries:resources.map((resource,binding)=>({binding,resource}))});
const image=(format,scale=1,samples=1)=>device.createTexture({size:[width*scale,height*scale],format,sampleCount:samples,
 usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|(samples===1?GPUTextureUsage.COPY_SRC:0)});
const attachment=(texture,clearValue=[0,0,0,0])=>({view:texture.createView(),loadOp:'clear',clearValue,storeOp:'store'});
const depthAttachment=texture=>({view:texture.createView(),depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'store'});
const module=code=>device.createShaderModule({code});
const geometry=module(geometryShader+`
 @fragment fn silhouette(v:VertexOut)->@location(0) vec4<f32>{
  return vec4<f32>(0.19,0.19,0.19,packFoliageMotion(v.windMotion));
 }`);
const verts=[{arrayStride:48,attributes:Array.from({length:4},(_,i)=>({shaderLocation:i,format:'float32x3',offset:i*12}))}];
const plant=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:geometry,entryPoint:'vegetationVS',buffers:verts},
 fragment:{module:geometry,entryPoint:'silhouette',targets:[{format:'rgba16float'}]},multisample:{count:4},
 depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
const resolve=module(depthResolveShader);
const surfacePipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:resolve,entryPoint:'vs'},fragment:{module:resolve,entryPoint:'fs',targets:[{format:'rg16float'}]},
 depthStencil:{format:'depth32float',depthCompare:'always',depthWriteEnabled:true}});
async function temporalPipeline(source) {
 const moduleGPU=module(source);
 return device.createRenderPipelineAsync({layout:'auto',vertex:{module:moduleGPU,entryPoint:'vs'},fragment:{module:moduleGPU,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
}
const historyPipeline=await temporalPipeline(temporalShader);
const baselineSource=process.env.WIND_QA_BASELINE;
const archived=baselineSource?(await import(pathToFileURL(baselineSource))).temporalShader:null;
const baselinePipeline=archived?await temporalPipeline(archived):historyPipeline;
const mesh=closeMeadow();
const vb=uploaded(mesh.vertices,GPUBufferUsage.VERTEX),ib=uploaded(mesh.indices,GPUBufferUsage.INDEX);
// Repeat the same authored planting cell at independent orientations/ground roots.
const roots=new Float32Array([-.21,0,-.05,1.15,.37,0,0,.35, .18,0,-.23,1.24,2.3,0,0,.36]);
const gb=uploaded(roots,GPUBufferUsage.STORAGE),visible=uploaded(new Uint32Array([0,1]),GPUBufferUsage.STORAGE);
const instanceGroup=group(plant,1,[{buffer:gb},{buffer:visible}]);
function scene(scale){
 const frame=uniform(96),color=image('rgba16float',scale,4),resolved=image('rgba16float',scale),depth=image('depth32float',scale,4);
 return {scale,frame,color,resolved,depth,group:group(plant,0,[{buffer:frame}])};
}
const native=scene(1),reference=scene(supersample);
const resolvedDepth=image('depth32float'),motion=image('rg16float'),zeroMotion=image('rg16float'),previous=uniform(20);
const surfaceGroup=group(surfacePipeline,0,[native.depth.createView(),native.color.createView()]);
const cases=[zeroMotion,motion].map((field,i)=>{
 const historical=i===0 && Boolean(archived);
 const pipeline=historical?baselinePipeline:historyPipeline;
 const frameGroup=group(pipeline,0,[{buffer:native.frame}]);
 const targets=[image('rgba16float'),image('rgba16float')];
 const groups=targets.map(t=>{
  const resources=[native.resolved.createView(),t.createView(),resolvedDepth.createView(),field.createView(),{buffer:previous}];
  const entries=resources.map((resource,binding)=>({binding,resource})).filter(b=>!(historical&&b.binding===3));
  return device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries});
 });
 return {pipeline,frameGroup,targets,groups,abs:0,squared:0,gradient:0,flicker:0,edgePixels:0,detailSamples:0};
});
const pitch=(bytes)=>Math.ceil(bytes/256)*256;
const pitchNative=pitch(width*8),pitchRef=pitch(width*supersample*8);
const readback=buf(2*pitchNative*height+pitchRef*height*supersample,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
let priorVP,priorJitter=[0,0],priorRef,priorEye,previousTime;
function recordScene(encoder,scene,u){
 device.queue.writeBuffer(scene.frame,0,u);
 const target=attachment(scene.color,[.81,.81,.81,0]);
 target.resolveTarget=scene.resolved.createView();
 const pass=encoder.beginRenderPass({colorAttachments:[target],depthStencilAttachment:depthAttachment(scene.depth)});
 pass.setPipeline(plant);pass.setBindGroup(0,scene.group);pass.setBindGroup(1,instanceGroup);
 pass.setVertexBuffer(0,vb);pass.setIndexBuffer(ib,'uint32');pass.drawIndexed(mesh.indices.length,2);pass.end();
}
const cameraStep=Number(process.env.WIND_QA_CAMERA_STEP||0);
const nativeCrop=process.env.WIND_QA_NATIVE_CROP==='1';
const fullWidth=nativeCrop?1920:width,fullHeight=nativeCrop?1080:height;
const projection=perspective((nativeCrop?50:44)*Math.PI/180,fullWidth/fullHeight,.1,100);
projection[0]*=fullWidth/width;projection[5]*=fullHeight/height;
for(let i=0;i<frames;i++){
 if(process.env.WIND_QA_PROGRESS==='1')console.log('wind frame',i);
 const time=i/(nativeCrop?30:15), j=offsets[i%8];
 const camera=nativeCrop?[i*cameraStep-.16,1.58,1.85]:[i*cameraStep,.27,.76];
 const target=[camera[0],nativeCrop?.14:.19,nativeCrop?.0:-.10];
 const steady=multiply(projection,lookAt(camera,target));
 const vp=new Float32Array(steady);
 for(let k=0;k<16;k+=4){vp[k]+=2*j[0]/width*vp[k+3];vp[k+1]+=2*j[1]/height*vp[k+3];}
 const u=new Float32Array(96);
 u.set(vp);u.set(inverse(vp),16);u.set([...camera,1],48);
 // A strong constant wind exercises the silhouette under rapid sampling.
 u.set([.3,.8,.4,1.8],52);u.set([width,height,time,1.8],56);u.set(priorVP??vp,76);u.set([...(priorEye||camera),previousTime??time],92);
 const refU=new Float32Array(u);
 refU.set(steady);refU.set(inverse(steady),16);refU[56]*=supersample;refU[57]*=supersample;refU.set(steady,76);
 const p=new Float32Array(20);
 p.set(historyTransform(vp,priorVP??vp));p.set([i?1:0,(j[0]-priorJitter[0])/width,-(j[1]-priorJitter[1])/height,Math.min(i,20)/(Math.min(i,20)+1)],16);
 device.queue.writeBuffer(previous,0,p);priorVP=vp;priorJitter=j;priorEye=camera;previousTime=time;
 const encoder=device.createCommandEncoder();
 recordScene(encoder,native,u);recordScene(encoder,reference,refU);
 let pass=encoder.beginRenderPass({colorAttachments:[attachment(motion)],depthStencilAttachment:depthAttachment(resolvedDepth)});
 pass.setPipeline(surfacePipeline);pass.setBindGroup(0,surfaceGroup);pass.draw(3);pass.end();
 for(const [c,test] of cases.entries()){
  const out=test.targets[i%2];
  pass=encoder.beginRenderPass({colorAttachments:[attachment(out)]});
  pass.setPipeline(test.pipeline);pass.setBindGroup(0,test.frameGroup);pass.setBindGroup(1,test.groups[1-i%2]);pass.draw(3);pass.end();
  encoder.copyTextureToBuffer({texture:out},{buffer:readback,offset:c*pitchNative*height,bytesPerRow:pitchNative},[width,height]);
 }
 encoder.copyTextureToBuffer({texture:reference.resolved},{buffer:readback,offset:2*pitchNative*height,bytesPerRow:pitchRef},[width*supersample,height*supersample]);
 device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();await readback.mapAsync(GPUMapMode.READ);
 const mapped=new Float16Array(readback.getMappedRange().slice(0));
 readback.unmap();
 const gt=new Float32Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let sum=0;
  for(let yy=0;yy<supersample;yy++)for(let xx=0;xx<supersample;xx++)
   sum+=mapped[pitchNative*height+(y*supersample+yy)*pitchRef/2+(x*supersample+xx)*4];
  gt[y*width+x]=sum/(supersample*supersample)*255;
 }
 for(const [c,test] of cases.entries()){
  const result=Float32Array.from(gt,(_,i)=>mapped[c*pitchNative*height/2+Math.floor(i/width)*pitchNative/2+(i%width)*4]*255);
  if(i>=warmup)for(let k=width+1;k<gt.length-width-1;k++){
   if(k%width===width-1||k%width===0)continue;
   const around=[gt[k],gt[k-1],gt[k+1],gt[k-width],gt[k+width]];
   if(Math.max(...around)-Math.min(...around)<6 && Math.abs(gt[k]-priorRef[k])<3)continue;
   const error=result[k]-gt[k];test.abs+=Math.abs(error);test.squared+=error*error;
   test.flicker+=Math.abs((result[k]-test.prior[k])-(gt[k]-priorRef[k]));test.edgePixels++;
   for(const neighbor of [k+1,k+width]){
    test.gradient+=Math.abs((result[neighbor]-result[k])-(gt[neighbor]-gt[k]));test.detailSamples++;
   }
  }
  if(output&&i===frames-1){
   const name=c?'tracked':'camera-only';
   writeFileSync(output+'/'+name+'.pgm',Buffer.concat([Buffer.from('P5\n'+width+' '+height+'\n255\n'),Buffer.from(Uint8Array.from(result,Math.round))]));
  }
  test.prior=result;
 }
 if(output&&i===frames-1)writeFileSync(output+'/reference.pgm',Buffer.concat([Buffer.from('P5\n'+width+' '+height+'\n255\n'),Buffer.from(Uint8Array.from(gt,Math.round))]));
 priorRef=gt;
}
const describe=t=>({edgePixels:t.edgePixels,meanAbsLumaError:t.abs/t.edgePixels,rmse:Math.sqrt(t.squared/t.edgePixels),
 gradientError:t.gradient/t.detailSamples,motionChangeError:t.flicker/t.edgePixels});
const [cameraOnly,tracked]=cases.map(describe);
const report={width,height,projectionExtent:[fullWidth,fullHeight],frameIntervalSeconds:1/(nativeCrop?30:15),frames,measuredFrames:frames-warmup,meshTriangles:mesh.indices.length/3,instances:2,
 supersample,subsamplesPerReferencePixel:4*supersample*supersample,isolatedSilhouette:true,baselineTemporal:archived?"archived":"same shader with zero wind vectors",wind:1.8,cameraStepMetres:cameraStep,cameraOnly,tracked};
console.log(JSON.stringify(report));
if(output)writeFileSync(output+'/wind-fixture.json',JSON.stringify(report,null,2));
assert(tracked.meanAbsLumaError<cameraOnly.meanAbsLumaError,'Wind reprojection should follow the source silhouette');
assert(tracked.gradientError<cameraOnly.gradientError,'Wind reprojection should retain measurable blade edges');
assert.equal(await device.popErrorScope(),null);device.destroy();delete globalThis.forestWindGPU;delete globalThis.forestWindAdapter;
