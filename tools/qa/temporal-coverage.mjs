// Native WebGPU stress test of the production shader. Checks independently
// alternating leaf/background subpixel coverage and a completely cleared frame.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {create,globals} from 'webgpu';
import {historyTransform,temporalShader} from '../../dist/temporal.js';
import {inverse,lookAt,multiply,perspective} from '../../dist/math.js';

Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan','enable-dawn-features=allow_unsafe_apis']);
const adapter=await gpu.requestAdapter({forceFallbackAdapter:true});
const device=await adapter.requestDevice();
device.pushErrorScope('validation');
const width=48,height=32;
const size=[width,height];
const aaOffsets=[[0,-1/6],[-0.25,1/6],[0.25,-7/18],[-0.375,-1/18],[0.125,5/18],[-0.125,-5/18],[0.375,1/18],[-0.4375,7/18]];
const shaderModule=code=>device.createShaderModule({code});
const sceneModule=shaderModule(`
 @group(0) @binding(0) var<uniform> scene:vec4<f32>;
 @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
  let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
  return vec4<f32>(p[i],0,1);
 }
 struct Result {@location(0) color:vec4<f32>, @builtin(frag_depth) depth:f32};
 @fragment fn fs(@builtin(position) pos:vec4<f32>)->Result{
  let sample=pos.xy+scene.xy*vec2<f32>(-1.0,1.0);
  let leaf=(fract((sample.x+sample.y*0.43)/7.0)<0.27 && scene.z<0.5) || scene.z==2.0;
  var result:Result;
  let skyStripe=select(0.82,0.31,i32(pos.x)%5<2);
  result.color=vec4<f32>(vec3<f32>(select(select(0.82,0.21,leaf),skyStripe,scene.z==3.0)),1.0);
  // Actual 0.25 m / 14 km perspective projection, leaf at 3 m against sky.
  result.depth=select(1.0,(14000.0-0.25*14000.0/3.0)/(14000.0-0.25),leaf);
  return result;
 }`);
const scenePipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:sceneModule,entryPoint:'vs'},
 fragment:{module:sceneModule,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
const frameBuffer=size=>device.createBuffer({size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const sceneBuffer=frameBuffer(16),frameBufferCurrent=frameBuffer(384),previousBuffer=frameBuffer(80);
const group=(pipeline,index,entries)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(index),entries});
const sceneGroup=group(scenePipeline,0,[{binding:0,resource:{buffer:sceneBuffer}}]);
const image=format=>device.createTexture({size,format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const current=image('rgba8unorm'),depth=image('depth32float'),motion=image('rg16float');
const rgba=texture=>({view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]});
const depthAttachment={view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1};
const pitch=Math.ceil(width*8/256)*256;
const readback=device.createBuffer({size:pitch*height,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
const leafSample=(x,y,j)=>(((x+0.5-j[0]+(y+0.5+j[1])*0.43)/7)%1)<0.27;
const edgePixels=[];
for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
 const count=aaOffsets.filter(j=>leafSample(x,y,j)).length;
 if(count>=2 && count<=6)edgePixels.push({index:y*width+x,expect:255*(0.21*count+0.82*(8-count))/8});
}
async function run(shader,oldConvention=false) {
 const module=shaderModule(shader);
 const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
 const history=[image('rgba16float'),image('rgba16float')];
 const init=device.createCommandEncoder();
 for(const texture of history)init.beginRenderPass({colorAttachments:[rgba(texture)]}).end();
 device.queue.submit([init.finish()]);await device.queue.onSubmittedWorkDone();
 const group0=group(pipeline,0,[{binding:0,resource:{buffer:frameBufferCurrent}}]);
 const groups=history.map(h=>group(pipeline,1,[{binding:0,resource:current.createView()},{binding:1,resource:h.createView()},
  {binding:2,resource:depth.createView()},...(shader.includes('var windMotion:')?[{binding:3,resource:motion.createView()}]:[]),{binding:4,resource:{buffer:previousBuffer}}]));
 const projection=perspective(50*Math.PI/180,width/height,0.25,14000);
 const eye=[-170,245,210];

 let oldVP,oldJitter,prior,deltaSum=0,coverageError=0,pairCount=0,largeChanges=0,revealError=0,parallaxError=0,skyTranslationError=0;
 for(let n=0;n<=44;n++){
  const mode=n===40?1:n===41?2:n>=43?3:0;
  const j=n<40?aaOffsets[n%aaOffsets.length]:[0,0];
  const camera=[eye[0]+(n===42?1.2:n===44?600:0),eye[1],eye[2]];
  const view=lookAt(camera,[camera[0]+0.25,camera[1]-0.13,camera[2]-1]);
  const vp=multiply(projection,view);
  for(let k=0;k<16;k+=4){vp[k]+=2*j[0]*vp[k+3]/width;vp[k+1]+=2*j[1]*vp[k+3]/height;}
  const u=new Float32Array(96);u.set(vp);u.set(inverse(vp),16);u.set(camera,48);
  const old=new Float32Array(20);
  old.set(oldConvention?vp:historyTransform(vp,vp));
  if(oldVP && n!==41 && n!==43){
   old.set(oldConvention?oldVP:historyTransform(vp,oldVP));
   old.set([1,(j[0]-oldJitter[0])/width,-(j[1]-oldJitter[1])/height,Math.min(n,20)/(Math.min(n,20)+1)],16);
  }
  oldVP=vp;oldJitter=j;
  device.queue.writeBuffer(sceneBuffer,0,new Float32Array([j[0],j[1],mode,0]));
  device.queue.writeBuffer(frameBufferCurrent,0,u);
  device.queue.writeBuffer(previousBuffer,0,old);
  const encoder=device.createCommandEncoder();
  let pass=encoder.beginRenderPass({colorAttachments:[rgba(current)],depthStencilAttachment:depthAttachment});
  pass.setPipeline(scenePipeline);pass.setBindGroup(0,sceneGroup);pass.draw(3);pass.end();
  pass=encoder.beginRenderPass({colorAttachments:[rgba(history[n%2])]});
  pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,groups[1-n%2]);pass.draw(3);pass.end();
  encoder.copyTextureToBuffer({texture:history[n%2]},{buffer:readback,bytesPerRow:pitch},size);
  device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
  const pixels=new Float32Array(width*height*4);
  const values=new Float16Array(readback.getMappedRange().slice(0));
  for(let k=0;k<pixels.length;k++)pixels[k]=values[Math.floor(k/(width*4))*pitch/2+k%(width*4)]*255;
  readback.unmap();
  if(n===40){
   for(let i=0;i<pixels.length;i+=4)revealError=Math.max(revealError,Math.abs(pixels[i]-Math.round(255*.82)));
  } else if(n===42){
   for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    if(!leafSample(x,y,j))parallaxError=Math.max(parallaxError,Math.abs(pixels[(y*width+x)*4]-Math.round(255*0.82)));
   }
  } else if(n===44){
   for(let k=0;k<pixels.length;k+=4)skyTranslationError=Math.max(skyTranslationError,Math.abs(pixels[k]-prior[k]));
  } else if(n>=16 && n<40){
   for(const {index,expect} of edgePixels){
    const delta=Math.abs(pixels[4*index]-prior[4*index]);
    deltaSum+=delta;largeChanges+=Number(delta>8);
    coverageError+=Math.abs(pixels[index*4]-expect);pairCount++;
   }
  }
  prior=pixels;
 }
 history.forEach(h=>h.destroy());
 return {edgePixels:edgePixels.length,edgeSamples:pairCount,edgeMeanDelta:deltaSum/pairCount,
  edgeLargeChangeRate:largeChanges/pairCount,coverageError:coverageError/pairCount,maxClearError:revealError,maxParallaxRevealError:parallaxError,maxSkyTranslationDelta:skyTranslationError};
}

const baselineDirectory=process.argv[2];
if(baselineDirectory){
 const url=pathToFileURL(resolve(baselineDirectory,'temporal.js'));
 const baseline=await import(url);
 console.log('baseline',JSON.stringify(await run(baseline.temporalShader,!baseline.historyTransform)));
}
const result=await run(temporalShader);
console.log('production',JSON.stringify(result));
assert.ok(result.edgeMeanDelta<10,'Unstable accumulated foliage coverage');
assert.ok(result.coverageError<13,'Coverage diverged from eight-phase geometric ground truth');
assert.ok(result.maxClearError<0.5,'A removed foreground object left a visible trail');
assert.ok(result.maxParallaxRevealError<0.5,'Foreground mixed into the revealed sky under parallax');
assert.ok(result.maxSkyTranslationDelta<0.5,'An infinitely distant sky moved under pure translation');
const error=await device.popErrorScope();assert.equal(error,null,error?.message);
device.destroy();
