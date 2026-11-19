import { crownSurfaceWGSL, crownSurfaceGLSL } from './crown-light.js';
import { surfaceLightWGSL, surfaceLightGLSL } from './surface-light.js';
import { getGLStandTexture, standLightingWGSL, standLightingGLSL } from './stand-envelope.js';
import { uniforms, skyIrradianceWGSL, skyIrradianceGLSL } from './shaders.js';

/** Sixteen orthographic views baked from the actual leaf and branch meshes.
 * Color remains linear, normals remain in model space, and the normal atlas
 * alpha stores upward canopy visibility integrated through leaf area density.
 */
// Decode our own RGBA8 PNGs to raw bytes. Normal-atlas alpha is data rather
// than opacity; passing it through a premultiplied canvas would lose precision
// in dark canopy texels and create a browser/native lighting discrepancy.
export async function decodeRGBA8PNG(buffer){
 const bytes=new Uint8Array(buffer),view=new DataView(buffer);const width=view.getUint32(16),height=view.getUint32(20);
 if(view.getUint32(0)!==0x89504e47||bytes[24]!==8||bytes[25]!==6||bytes[28]!==0)throw new Error('Unsupported tree atlas PNG encoding.');
 const chunks=[];let length=0;for(let offset=8;offset<bytes.length;){const size=view.getUint32(offset);const type=view.getUint32(offset+4);if(type===0x49444154){chunks.push(bytes.subarray(offset+8,offset+8+size));length+=size;}offset+=size+12;}
 const compressed=new Uint8Array(length);let offset=0;for(const chunk of chunks){compressed.set(chunk,offset);offset+=chunk.length;}
 const raw=new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
 const stride=width*4,pixels=new Uint8Array(stride*height);let source=0;
 function paeth(a,b,c){const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;}
 for(let y=0;y<height;y++){const filter=raw[source++],base=y*stride;for(let x=0;x<stride;x++){const left=x>=4?pixels[base+x-4]:0,up=y?pixels[base+x-stride]:0,upperLeft=y&&x>=4?pixels[base+x-stride-4]:0;let predict=0;if(filter===1)predict=left;else if(filter===2)predict=up;else if(filter===3)predict=(left+up)>>1;else if(filter===4)predict=paeth(left,up,upperLeft);else if(filter!==0)throw new Error('Unsupported tree atlas PNG filter.');pixels[base+x]=(raw[source++]+predict)&255;}}
 return {bytes:pixels,width,height};
}
async function loadAtlas(species, part) {
 const name=species+'-'+part;
 const supplied=globalThis.forestImpostorBytes?.[name];
 if(supplied)return {bytes:new Uint8Array(supplied),width:2048,height:512};
 const response=await fetch(new URL('./assets/impostors/'+name+'.png',import.meta.url));
 if(!response.ok)throw new Error('Could not load the '+species+' tree impostor.');
 if(typeof DecompressionStream!=='undefined')return decodeRGBA8PNG(await response.arrayBuffer());
 const bitmap=await createImageBitmap(await response.blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
 return {bitmap,width:bitmap.width,height:bitmap.height};
}
async function loadMetadata(species) {
 if(globalThis.forestImpostorMetadata?.[species])return globalThis.forestImpostorMetadata[species];
 return (await fetch(new URL('./assets/impostors/'+species+'.json',import.meta.url))).json();
}
async function loadDensity(species) {
 const [metadataResponse,volumeResponse]=await Promise.all([
  fetch(new URL('./assets/impostors/'+species+'-density.json',import.meta.url)),
  fetch(new URL('./assets/impostors/'+species+'-density.bin',import.meta.url))
 ]);
 if(!metadataResponse.ok||!volumeResponse.ok)throw new Error('Could not load '+species+' source foliage density.');
 const metadata=await metadataResponse.json(),bytes=new Uint8Array(await volumeResponse.arrayBuffer());
 if(bytes.byteLength!==metadata.size**3)throw new Error('Invalid source foliage density volume.');
 return {metadata,bytes};
}
// Density is linear leaf area per volume. Filter its arithmetic mean before
// Beer-Lambert attenuation; do not average already exponentiated visibility.
export function densityMipChain(bytes,size) {
 const levels=[{bytes,size}];let values=Float32Array.from(bytes);
 while(size>1) {
  const nextSize=Math.max(1,size>>1),next=new Float32Array(nextSize**3);
  for(let z=0;z<nextSize;z++)for(let y=0;y<nextSize;y++)for(let x=0;x<nextSize;x++) {
   let sum=0,count=0;
   for(let iz=Math.floor(z*size/nextSize);iz<Math.floor((z+1)*size/nextSize);iz++)
   for(let iy=Math.floor(y*size/nextSize);iy<Math.floor((y+1)*size/nextSize);iy++)
   for(let ix=Math.floor(x*size/nextSize);ix<Math.floor((x+1)*size/nextSize);ix++) {sum+=values[(iz*size+iy)*size+ix];count++;}
   next[(z*nextSize+y)*nextSize+x]=sum/count;
  }
  levels.push({size:nextSize,bytes:Uint8Array.from(next,value=>Math.round(value))});values=next;size=nextSize;
 }
 return levels;
}
/** Extend surface fields under transparent texels without changing coverage.
 * Linear texture filtering must never pull a source point toward the model
 * minimum, or a normal toward (-1,-1,-1), at the edge of a leaf cluster.
 */
export function extendAtlasSurfaceFields(data,width,height,radius=3) {
 const pixels=width*height;
 const origin=new Int32Array(pixels).fill(-1);
 const distance=new Uint8Array(pixels);
 const queue=new Uint32Array(pixels);
 const neighbors=[-1,1,-width,width];
 let head=0,tail=0;
 for(let i=0;i<pixels;i++) {
  if(data[0][i*4+3]>0) {origin[i]=i;queue[tail++]=i;}
 }
 while(head<tail) {
  const i=queue[head++];
  if(distance[i]>=radius)continue;
  const x=i%width,y=Math.floor(i/width);
  for(const offset of neighbors) {
   const j=i+offset;
   if(j<0||j>=pixels||origin[j]>=0)continue;
   const nx=j%width,ny=Math.floor(j/width);
   if(Math.abs(nx-x)+Math.abs(ny-y)!==1||Math.floor(nx/256)!==Math.floor(x/256)||Math.floor(ny/256)!==Math.floor(y/256))continue;
   origin[j]=origin[i];distance[j]=distance[i]+1;queue[tail++]=j;
  }
 }
 for(let i=0;i<pixels;i++) {
  const from=origin[i];if(from<0||from===i)continue;
  for(let part=0;part<3;part++) {
   const channels=part===0?3:4;
   for(let channel=0;channel<channels;channel++)data[part][i*4+channel]=data[part][from*4+channel];
  }
 }
 return data;
}
const mipCode=/* wgsl */`
@group(0) @binding(0) var colorSource:texture_2d<f32>;
@group(0) @binding(1) var normalSource:texture_2d<f32>;
@group(0) @binding(2) var positionSource:texture_2d<f32>;
@group(0) @binding(3) var colorDestination:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(4) var normalDestination:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(5) var positionDestination:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) p:vec3<u32>) {
 let size=textureDimensions(colorDestination);if(any(p.xy>=size)){return;}
 let q=vec2<i32>(p.xy*2u);var rawColor=vec3<f32>(0);var rawNormal=vec4<f32>(0);var rawPosition=vec4<f32>(0);var total=0.0;var color=vec3<f32>(0);var normal=vec4<f32>(0);var position=vec4<f32>(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let uv=q+vec2<i32>(x,y);let a=textureLoad(colorSource,uv,0);let n=textureLoad(normalSource,uv,0);
  rawColor+=a.rgb;rawNormal+=n;rawPosition+=textureLoad(positionSource,uv,0);
  total+=a.a;color+=a.rgb*a.a;normal+=vec4<f32>(n.rgb*2.0-1.0,n.a)*a.a;
  position+=textureLoad(positionSource,uv,0)*a.a;
 }}
 if(total<0.0001) {
  textureStore(colorDestination,vec2<i32>(p.xy),vec4<f32>(rawColor*.25,0.0));
  textureStore(normalDestination,vec2<i32>(p.xy),rawNormal*.25);
  textureStore(positionDestination,vec2<i32>(p.xy),rawPosition*.25);return;
 }
 let coverage=min(1.0,total*.25);let weight=max(.0001,total);
 textureStore(colorDestination,vec2<i32>(p.xy),vec4<f32>(color/weight,coverage));
 // The remaining normal length is unresolved variance, not lost precision.
 textureStore(normalDestination,vec2<i32>(p.xy),vec4<f32>(normal.rgb/weight*.5+.5,normal.a/weight));
 textureStore(positionDestination,vec2<i32>(p.xy),position/weight);
}`;
async function webgpuAtlases(device, data, mipPipeline) {
 const textures=data.map((entry,index)=>{
  const texture=device.createTexture({label:'Tree '+['albedo and coverage','normal and sky visibility','model position and leaf fraction'][index]+' atlas',size:[entry.width,entry.height],format:'rgba8unorm',mipLevelCount:8,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.STORAGE_BINDING});
  if(entry.bytes)device.queue.writeTexture({texture},entry.bytes,{bytesPerRow:entry.width*4,rowsPerImage:entry.height},[entry.width,entry.height]);
  else {device.queue.copyExternalImageToTexture({source:entry.bitmap},{texture},[entry.width,entry.height]);entry.bitmap.close();}return texture;
 });
 const encoder=device.createCommandEncoder({label:'Coverage weighted tree position and normal mipmaps'});
 for(let level=1;level<8;level++){
  const group=device.createBindGroup({layout:mipPipeline.getBindGroupLayout(0),entries:[
   ...textures.map((texture,binding)=>({binding,resource:texture.createView({baseMipLevel:level-1,mipLevelCount:1})})),
   ...textures.map((texture,index)=>({binding:index+3,resource:texture.createView({baseMipLevel:level,mipLevelCount:1})}))]});
  const pass=encoder.beginComputePass();pass.setPipeline(mipPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil((data[0].width>>level)/8),Math.ceil((data[0].height>>level)/8));pass.end();
 }
 device.queue.submit([encoder.finish()]);return textures;
}
function modelConstants(meta) {
 const bounds=meta.sourceBounds,leaf=meta.leafBounds||bounds;
 return {minimum:bounds[0],extent:bounds[1].map((x,i)=>x-bounds[0][i]),center:leaf[0].map((x,i)=>(x+leaf[1][i])*0.5),radius:leaf[0].map((x,i)=>Math.max(.01,(leaf[1][i]-x)*0.5))};
}
function shaderConstants(meta) {
 const model=modelConstants(meta),v=value=>value.map(x=>Number(x).toFixed(8)).join(',');
 const density=meta.density||{minimum:model.minimum,extent:model.extent,decodeScale:0};
 return `const PROJECTION_SIZE=vec2<f32>(${v(meta.projectionSize)});\nconst MODEL_CENTER=vec3<f32>(${v(meta.center)});\nconst BOUNDS_MIN=vec3<f32>(${v(model.minimum)});\nconst BOUNDS_EXTENT=vec3<f32>(${v(model.extent)});\nconst CROWN_CENTER=vec3<f32>(${v(model.center)});\nconst CROWN_RADIUS=vec3<f32>(${v(model.radius)});\nconst DENSITY_MIN=vec3<f32>(${v(density.minimum)});\nconst DENSITY_EXTENT=vec3<f32>(${v(density.extent)});\nconst DENSITY_SCALE=${Number(density.decodeScale).toFixed(8)};\nconst DENSITY_SIZE=${Number(density.size||96).toFixed(1)};\n`;
}
import { cloudLightWGSL, cloudLightGLSL, aerialGLSL } from './weather-light.js';
export function treeImpostorWGSL(meta) {
 return uniforms+coveragePatternWGSL+crownSurfaceWGSL+surfaceLightWGSL+standLightingWGSL.replaceAll('standSampler','atlasSampler')+cloudLightWGSL.replace('CLOUD_SAMPLER','atlasSampler')+skyIrradianceWGSL+shaderConstants(meta)+/* wgsl */`
struct Instance {position:vec4<f32>,variation:vec4<f32>};
@group(1) @binding(0) var<storage,read> instances:array<Instance>;
@group(1) @binding(1) var<storage,read> visible:array<u32>;
@group(2) @binding(6) var materialSampler:sampler;
@group(2) @binding(0) var shadowMap:texture_depth_2d;
@group(2) @binding(1) var shadowSampler:sampler_comparison;
@group(2) @binding(8) var standEnvelope:texture_2d<f32>;
@group(3) @binding(0) var albedoAtlas:texture_2d<f32>;
@group(3) @binding(1) var normalAtlas:texture_2d<f32>;
@group(3) @binding(2) var atlasSampler:sampler;
@group(3) @binding(3) var positionAtlas:texture_2d<f32>;
@group(3) @binding(4) var leafDensity:texture_3d<f32>;
struct Output {@builtin(position) clip:vec4<f32>,@location(0) world:vec3<f32>,@location(1) uv:vec2<f32>,@location(2) @interpolate(flat) cell:vec2<f32>,@location(3) @interpolate(flat) yaw:f32,@location(4) @interpolate(flat) tint:f32,@location(5) @interpolate(flat) rootScale:vec4<f32>,@location(6) @interpolate(flat) width:f32};
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instanceId:u32)->Output {
 let tree=instances[visible[instanceId]];let yaw=tree.variation.x;
 let center=tree.position.xyz+MODEL_CENTER*tree.position.w;
 let view=normalize(u.camera.xyz-center);let azimuth=atan2(view.x,view.z);
 let right=vec3<f32>(cos(azimuth),0.0,-sin(azimuth));let up=cross(view,right);
 let corner=vec2<f32>(f32(vertex&1u),f32(vertex>>1u));
 let width=0.78+tree.variation.z*0.48;
 let offset=(corner-0.5)*PROJECTION_SIZE*tree.position.w*vec2<f32>(width,1.0);
 let world=center+right*offset.x+up*offset.y;
 let angle=azimuth-yaw;
 let column=floor(fract(angle/6.28318530718+1.0625)*8.0);
 let elevation=asin(clamp(view.y,-1.0,1.0));let row=select(1.0,0.0,elevation>0.2181661565);
 var out:Output;out.clip=u.vp*vec4<f32>(world,1);out.world=world;
 out.uv=vec2<f32>(corner.x,1.0-corner.y);out.cell=vec2<f32>(column,row);out.yaw=yaw;out.tint=tree.variation.y;out.rootScale=tree.position;out.width=width;return out;
}
fn castShadow(p:vec3<f32>)->f32 {
 let projected=u.lightVP*vec4<f32>(p,1);let uv=projected.xy*vec2<f32>(.5,-.5)+.5;
 if(any(uv<vec2<f32>(.001))||any(uv>vec2<f32>(.999))||projected.z<0.0||projected.z>1.0){return 1.0;}
 var result=0.0;for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){result+=textureSampleCompareLevel(shadowMap,shadowSampler,uv+vec2<f32>(f32(x),f32(y))/vec2<f32>(textureDimensions(shadowMap)),projected.z-0.000055);}}return result/9.0;
}
fn crownExit(local:vec3<f32>,direction:vec3<f32>)->f32 {
 let p=(local-CROWN_CENTER)/CROWN_RADIUS;let d=direction/CROWN_RADIUS;
 let a=dot(d,d);let b=dot(p,d);let discriminant=b*b-a*(dot(p,p)-1.0);
 if(discriminant<0.0){return 0.0;}let root=sqrt(discriminant);
 return max(0.0,(-b+root)/a-max(0.0,(-b-root)/a));
}
// Integrate physical alpha-weighted leaf area density along the real local
// sun ray. Density clumps and gaps come from the unreduced source geometry.
fn foliageSunVisibility(position:vec3<f32>,direction:vec3<f32>,densityLod:f32)->f32 {
 let safeDirection=select(vec3<f32>(0.00001),direction,abs(direction)>vec3<f32>(0.00001));
 let low=(DENSITY_MIN-position)/safeDirection;
 let high=(DENSITY_MIN+DENSITY_EXTENT-position)/safeDirection;
 let far=max(low,high);let distance=max(0.0,min(far.x,min(far.y,far.z))-0.18);
 // Filtered density varies smoothly across a coarser pixel footprint.
 let taps=select(24,12,densityLod>1.25);
 let interval=distance/f32(taps);var opticalDepth=0.0;
 for(var sampleIndex=0;sampleIndex<taps;sampleIndex++) {
  let p=position+direction*(0.18+(f32(sampleIndex)+0.5)*interval);
  let uv=(p-DENSITY_MIN)/DENSITY_EXTENT;
  let density=textureSampleLevel(leafDensity,atlasSampler,uv,densityLod).r*DENSITY_SCALE;
  opticalDepth+=density*interval*0.5;
 }
 return exp(-min(opticalDepth,10.0));
}
// Neighbor captures are reprojected with the stored source surface depth.
// This keeps the capture texture attached to its 3D leaf cluster while the
// viewing direction changes between the sixteen source camera positions.
struct AtlasSurface { color:vec4<f32>, normal:vec4<f32>, source:vec4<f32> };
fn captureSurface(card:vec3<f32>,ray:vec3<f32>,column:f32,row:f32,dx:vec3<f32>,dy:vec3<f32>)->AtlasSurface {
 let azimuth=column*0.7853981634;
 let elevation=(1.0-row)*0.436332313;
 let right=vec3<f32>(cos(azimuth),0.0,-sin(azimuth));
 let view=vec3<f32>(sin(azimuth)*cos(elevation),sin(elevation),cos(azimuth)*cos(elevation));
 let up=cross(view,right);
 let gradientX=vec2<f32>(dot(dx,right),-dot(dx,up))/PROJECTION_SIZE/vec2<f32>(8.0,2.0);
 let gradientY=vec2<f32>(dot(dy,right),-dot(dy,up))/PROJECTION_SIZE/vec2<f32>(8.0,2.0);
 var point=card;
 var uv=vec2<f32>(0.0);
 for(var iteration=0;iteration<2;iteration++) {
  let plane=point-MODEL_CENTER;
  let localUV=vec2<f32>(dot(plane,right)/PROJECTION_SIZE.x+0.5,0.5-dot(plane,up)/PROJECTION_SIZE.y);
  uv=(vec2<f32>(column,row)+clamp(localUV,vec2<f32>(0.5/256.0),vec2<f32>(1.0-0.5/256.0)))/vec2<f32>(8.0,2.0);
  let depth=BOUNDS_MIN+textureSampleGrad(positionAtlas,atlasSampler,uv,gradientX,gradientY).rgb*BOUNDS_EXTENT;
  point=card+ray*(dot(depth-card,view)/max(0.3,dot(ray,view)));
 }
 let plane=point-MODEL_CENTER;
 let localUV=vec2<f32>(dot(plane,right)/PROJECTION_SIZE.x+0.5,0.5-dot(plane,up)/PROJECTION_SIZE.y);
 uv=(vec2<f32>(column,row)+clamp(localUV,vec2<f32>(0.5/256.0),vec2<f32>(1.0-0.5/256.0)))/vec2<f32>(8.0,2.0);
 var result:AtlasSurface;
 result.color=textureSampleGrad(albedoAtlas,atlasSampler,uv,gradientX,gradientY);
 if(any(localUV<vec2<f32>(0.0))||any(localUV>vec2<f32>(1.0))) {result.color.a=0.0;}
 result.normal=textureSampleGrad(normalAtlas,atlasSampler,uv,gradientX,gradientY);
 result.source=textureSampleGrad(positionAtlas,atlasSampler,uv,gradientX,gradientY);
 return result;
}
struct Fragment {@location(0) color:vec4<f32>,@location(1) normal:vec4<f32>,@builtin(frag_depth) depth:f32,@builtin(sample_mask) mask:u32};
@fragment fn fs(v:Output)->Fragment {
 let cs=cos(v.yaw);let sn=sin(v.yaw);
 let delta=(v.world-v.rootScale.xyz)/v.rootScale.w;
 let card=vec3<f32>((delta.x*cs-delta.z*sn)/v.width,delta.y,(delta.x*sn+delta.z*cs)/v.width);
 let eyeDelta=(u.camera.xyz-v.rootScale.xyz)/v.rootScale.w;
 let eye=vec3<f32>((eyeDelta.x*cs-eyeDelta.z*sn)/v.width,eyeDelta.y,(eyeDelta.x*sn+eyeDelta.z*cs)/v.width);
 let ray=normalize(eye-card);
 let captureView=normalize(eye-MODEL_CENTER);
 let angle=fract(atan2(captureView.x,captureView.z)/6.28318530718+1.0)*8.0;
 let column=floor(angle);let azimuthBlend=fract(angle);
 let elevationBlend=clamp(asin(clamp(captureView.y,-1.0,1.0))/0.436332313,0.0,1.0);
 let dx=dpdx(card);let dy=dpdy(card);
 var color=vec4<f32>(0.0);var surface=vec4<f32>(0.0);var sourcePoint=vec4<f32>(0.0);var coverage=0.0;
 for(var row=0;row<2;row++) {for(var neighbor=0;neighbor<2;neighbor++) {
  let angularWeight=select(1.0-elevationBlend,elevationBlend,row==0)*select(1.0-azimuthBlend,azimuthBlend,neighbor==1);
  if(angularWeight<0.0001) {continue;}
  let sample=captureSurface(card,ray,(column+f32(neighbor))%8.0,f32(row),dx,dy);
  let weight=angularWeight*sample.color.a;
  color+=vec4<f32>(sample.color.rgb,1.0)*weight;
  surface+=sample.normal*weight;sourcePoint+=sample.source*weight;coverage+=weight;
 }}
 color=vec4<f32>(color.rgb/max(0.0001,coverage),coverage);
 surface/=max(0.0001,coverage);sourcePoint/=max(0.0001,coverage);
 let modelPosition=BOUNDS_MIN+sourcePoint.rgb*BOUNDS_EXTENT;
 // Evaluate derivatives before alpha discard. The source point footprint
 // includes true depth variation; the card footprint prevents undersampling
 // flat/averaged position texels at long range.
 let sourceFootprint=max(length(dpdx(modelPosition)),length(dpdy(modelPosition)));
 let cardFootprint=max(length(dpdx(v.world)),length(dpdy(v.world)))/max(0.001,v.rootScale.w*min(v.width,1.0));
 let voxelSize=min(DENSITY_EXTENT.x,min(DENSITY_EXTENT.y,DENSITY_EXTENT.z))/DENSITY_SIZE;
 let densityLod=clamp(log2(max(max(sourceFootprint,cardFootprint),voxelSize)/voxelSize),0.0,3.5);
 if(color.a<=0.0){discard;}
 let meanNormal=surface.rgb*2.0-1.0;let normalLength=clamp(length(meanNormal),0.0,1.0);let local=normalize(meanNormal+vec3<f32>(0.0,0.0001,0.0));
 var n=normalize(vec3<f32>(local.x*cs+local.z*sn,local.y*v.width,-local.x*sn+local.z*cs));
 let sun=normalize(u.sun.xyz);
 let localSun=normalize(vec3<f32>((sun.x*cs-sun.z*sn)/v.width,sun.y,(sun.x*sn+sun.z*cs)/v.width));
 let sunVisibility=foliageSunVisibility(modelPosition,localSun,densityLod);
 let skyVisibility=clamp(surface.a,0.,1.);

 let scaled=modelPosition*v.rootScale.w*vec3<f32>(v.width,1.0,v.width);
 let sourceWorld=v.rootScale.xyz+vec3<f32>(scaled.x*cs+scaled.z*sn,scaled.y,-scaled.x*sn+scaled.z*cs);
 let viewDirection=normalize(u.camera.xyz-sourceWorld);
 if(dot(n,viewDirection)<0.0) {n=-n;}
 let isotropicSky=vec3<f32>(.201254991,.242362245,.334454446);
 let standOpen=standSkyVisibility(sourceWorld);
 let shelter=crownSkylight(skyVisibility)*standOpen;
 var frontSky=mix(isotropicSky,skyIrradiance(n),normalLength)*shelter;
 var backSky=mix(isotropicSky,skyIrradiance(-n),normalLength)*shelter;
 let clip=u.lightVP*vec4<f32>(sourceWorld,1);
 let edge=0.5-0.5*max(abs(clip.x),abs(clip.y));
 let fineWeight=select(0.,(1.-smoothstep(260.,340.,distance(sourceWorld.xz,u.camera.xz)))*smoothstep(0.,.05,edge),clip.z>0.&&clip.z<1.);
 var direct=sunVisibility;
 if(fineWeight<1.0) {
  // Start just outside the receiver crown. The leaf-density ray has
  // already integrated attenuation inside this particular tree.
  let skip=crownExit(modelPosition,localSun)*length(localSun*vec3<f32>(v.width,1.,v.width))*v.rootScale.w;
  direct*=standSunVisibility(sourceWorld,sun,skip);
 }
 if(fineWeight>0.0){direct=mix(direct,min(castShadow(sourceWorld),sunVisibility),fineWeight);}
 let cloud=cloudSunVisibility(sourceWorld,sun);
 let shadow=direct*cloud;
 let solar=sunlightOverPi(sun)*cloud;
 frontSky+=crownSolarBounce(n.y*normalLength,skyVisibility,sunVisibility,solar,sun.y,standOpen);
 backSky+=crownSolarBounce(-n.y*normalLength,skyVisibility,sunVisibility,solar,sun.y,standOpen);
 let leafFraction=clamp(sourcePoint.a,0.0,1.0);
 // The raster sample mask already integrates the uncovered background.
 let phenotype=treeLeafPigment(v.tint,${meta.name==='jacaranda'});
 let albedo=color.rgb*.85*mix(vec3<f32>(1.0),phenotype,leafFraction);
 let transmission=.32*leafFraction;
 let surfaceRoughness=clamp(sqrt(.66*.66+(1.0-normalLength)*.45),.42,1.0);
 let reflectedSky=mix(isotropicSky,skyIrradiance(reflect(-viewDirection,n)),normalLength)*shelter;
 let diffuse=surfaceDiffuse(albedo,frontSky,backSky,transmission,max(0.0,dot(n,viewDirection)),surfaceRoughness);
 var lit=(diffuse+surfaceEnvironment(reflectedSky,max(0.0,dot(n,viewDirection)),surfaceRoughness))+surfaceDirect(albedo,n,viewDirection,sun,.66,transmission,normalLength)*shadow;
 if(u.settings.x>.5&&u.settings.x<1.5){lit=vec3<f32>(.20,.43,1.0);}
 let surfaceClip=u.vp*vec4<f32>(sourceWorld,1.0);
 var out:Fragment;out.color=vec4<f32>(lit,0.);out.mask=coverageMask(color.a,fract(v.tint*173.123+v.rootScale.w*17.13));out.normal=vec4<f32>(n*.5+.5,.5);
 out.depth=clamp(surfaceClip.z/surfaceClip.w,0.0,1.0);return out;
}`;
}
/** Draws use the existing compacted tree ID buffers. The selected indirect
 * bucket must have indexCount=6. Shadow rendering continues to use geometry.
 */
import { normalFormat, vegetationSampling, coveragePatternWGSL, layeredCoverageGLSL } from './sample-coverage.js';

export async function createTreeImpostors(device,{uniformLayout,instanceLayout,lightLayout,species='oak'}) {
 const [meta,albedoData,normalData,positionData,densityData]=await Promise.all([loadMetadata(species),loadAtlas(species,'albedo'),loadAtlas(species,'normal'),loadAtlas(species,'position'),loadDensity(species)]);
 meta.density=densityData.metadata;
 if(albedoData.bytes&&normalData.bytes&&positionData.bytes) {
  extendAtlasSurfaceFields([albedoData.bytes,normalData.bytes,positionData.bytes],albedoData.width,albedoData.height);
 }
 const mipModule=device.createShaderModule({code:mipCode});const mipPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:mipModule,entryPoint:'main'}});
 const [albedo,normal,position]=await webgpuAtlases(device,[albedoData,normalData,positionData],mipPipeline);
 const densityLevels=densityMipChain(densityData.bytes,meta.density.size);
 const densityTexture=device.createTexture({label:species+' filtered source leaf area density',dimension:'3d',size:[meta.density.size,meta.density.size,meta.density.size],mipLevelCount:densityLevels.length,format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
 densityLevels.forEach((level,mipLevel)=>device.queue.writeTexture({texture:densityTexture,mipLevel},level.bytes,{bytesPerRow:level.size,rowsPerImage:level.size},[level.size,level.size,level.size]));
 const atlasLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},{binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'3d'}}]});
 const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
 const group=device.createBindGroup({layout:atlasLayout,entries:[{binding:0,resource:albedo.createView()},{binding:1,resource:normal.createView()},{binding:2,resource:sampler},{binding:3,resource:position.createView()},{binding:4,resource:densityTexture.createView()}]});
 const module=device.createShaderModule({label:species+' relit geometric tree impostors',code:treeImpostorWGSL(meta)});const info=await module.getCompilationInfo();const errors=info.messages.filter(x=>x.type==='error');if(errors.length)throw new Error(errors.map(x=>x.message).join('\n'));
 const pipeline=await device.createRenderPipelineAsync({multisample:vegetationSampling,layout:device.createPipelineLayout({bindGroupLayouts:[uniformLayout,instanceLayout,lightLayout,atlasLayout]}),vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'},{format:normalFormat}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
 const indices=device.createBuffer({size:24,usage:GPUBufferUsage.INDEX,mappedAtCreation:true});new Uint32Array(indices.getMappedRange()).set([0,1,2,2,1,3]);indices.unmap();
 return {metadata:meta,render(pass,population,bucket,byteOffset=bucket*20,uniformGroup,lightGroup){pass.setPipeline(pipeline);if(uniformGroup)pass.setBindGroup(0,uniformGroup);if(lightGroup)pass.setBindGroup(2,lightGroup);pass.setBindGroup(1,population.groups[bucket]);pass.setBindGroup(3,group);pass.setIndexBuffer(indices,'uint32');pass.drawIndexedIndirect(population.indirect,byteOffset);},destroy(){albedo.destroy();normal.destroy();position.destroy();densityTexture.destroy();indices.destroy();}};
}

export function treeImpostorGLSL(meta, multisampled=false) {
 const v=value=>value.map(x=>Number(x).toFixed(8)).join(',');
 const projection=v(meta.projectionSize),center=v(meta.center),model=modelConstants(meta);
 const density=meta.density||{minimum:model.minimum,extent:model.extent,decodeScale:0};
 return {
 vertex:`#version 300 es
precision highp float;
layout(location=0)in vec4 aPosition;layout(location=1)in vec4 aVariation;
uniform mat4 uViewProjection;uniform vec3 uCamera;
out vec3 vWorld;out vec2 vUV;flat out vec2 vCell;flat out float vYaw,vTint,vWidth;flat out vec4 vRootScale;
void main(){
 vec3 center=aPosition.xyz+vec3(${center})*aPosition.w;vec3 view=normalize(uCamera-center);float azimuth=atan(view.x,view.z);vec3 right=vec3(cos(azimuth),0.,-sin(azimuth));vec3 up=cross(view,right);
 vec2 corner=vec2(float(gl_VertexID&1),float(gl_VertexID>>1));float width=.78+aVariation.z*.48;vec2 offset=(corner-.5)*vec2(${projection})*aPosition.w*vec2(width,1.);
 vWorld=center+right*offset.x+up*offset.y;gl_Position=uViewProjection*vec4(vWorld,1.);vUV=vec2(corner.x,1.-corner.y);
 float column=floor(fract((azimuth-aVariation.x)/6.28318530718+1.0625)*8.);float row=asin(clamp(view.y,-1.,1.))>.2181661565?0.:1.;vCell=vec2(column,row);vYaw=aVariation.x;vTint=aVariation.y;vRootScale=aPosition;vWidth=width;
}`,
 fragment:`#version 300 es
precision highp float;
in vec3 vWorld;in vec2 vUV;flat in vec2 vCell;flat in float vYaw,vTint,vWidth;flat in vec4 vRootScale;
uniform sampler2D uAlbedo,uNormal,uPosition;uniform highp sampler2DShadow uShadow;uniform highp sampler2D standEnvelope;uniform highp sampler3D uDensity;uniform mat4 uLightProjection,uViewProjection;uniform vec3 uCamera,uSun;uniform int uDebug;
out vec4 outColor;
${skyIrradianceGLSL}
${surfaceLightGLSL}
${crownSurfaceGLSL}
${standLightingGLSL}
${cloudLightGLSL}
${aerialGLSL}
${layeredCoverageGLSL}
float castShadow(vec3 world){vec4 p=uLightProjection*vec4(world,1.);vec3 q=p.xyz/p.w*.5+.5;if(any(lessThan(q,vec3(.001)))||any(greaterThan(q,vec3(.999))))return 1.;float result=0.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){result+=texture(uShadow,vec3(q.xy+vec2(x,y)/vec2(textureSize(uShadow,0)),q.z-.000055));}return result/9.;}
float crownExit(vec3 local,vec3 direction){vec3 p=(local-vec3(${v(model.center)}))/vec3(${v(model.radius)}),d=direction/vec3(${v(model.radius)});float a=dot(d,d),b=dot(p,d),discriminant=b*b-a*(dot(p,p)-1.);if(discriminant<0.)return 0.;float root=sqrt(discriminant);return max(0.,(-b+root)/a-max(0.,(-b-root)/a));}
float foliageSunVisibility(vec3 position,vec3 direction,float densityLod){
 vec3 minimum=vec3(${v(density.minimum)}),extent=vec3(${v(density.extent)});
 vec3 safeDirection=mix(vec3(.00001),direction,greaterThan(abs(direction),vec3(.00001)));
 vec3 far=max((minimum-position)/safeDirection,(minimum+extent-position)/safeDirection);
 int taps=densityLod>1.25?12:24;float distance=max(0.,min(far.x,min(far.y,far.z))-.18),interval=distance/float(taps),opticalDepth=0.;
 for(int i=0;i<taps;i++){vec3 p=position+direction*(.18+(float(i)+.5)*interval);opticalDepth+=textureLod(uDensity,(p-minimum)/extent,densityLod).r*${Number(density.decodeScale).toFixed(8)}*interval*.5;}
 return exp(-min(opticalDepth,10.));
}
vec3 tonemap(vec3 x){x=max(vec3(0.),x);return pow(clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.),vec3(1./2.2));}
struct AtlasSurface {vec4 color;vec4 normal;vec4 source;};
AtlasSurface captureSurface(vec3 card,vec3 ray,float column,float row,vec3 dx,vec3 dy){
 float azimuth=column*.7853981634,elevation=(1.-row)*.436332313;
 vec3 right=vec3(cos(azimuth),0.,-sin(azimuth));
 vec3 view=vec3(sin(azimuth)*cos(elevation),sin(elevation),cos(azimuth)*cos(elevation)),up=cross(view,right);
 vec2 gx=vec2(dot(dx,right),-dot(dx,up))/vec2(${projection})/vec2(8.,2.);
 vec2 gy=vec2(dot(dy,right),-dot(dy,up))/vec2(${projection})/vec2(8.,2.);
 vec3 point=card;
 vec2 uv;
 for(int iteration=0;iteration<2;iteration++){
  vec3 plane=point-vec3(${center});
  vec2 localUV=vec2(dot(plane,right)/${Number(meta.projectionSize[0]).toFixed(8)}+.5,.5-dot(plane,up)/${Number(meta.projectionSize[1]).toFixed(8)});
  uv=(vec2(column,row)+clamp(localUV,vec2(.5/256.),vec2(1.-.5/256.)))/vec2(8.,2.);
  vec3 depth=vec3(${v(model.minimum)})+textureGrad(uPosition,uv,gx,gy).rgb*vec3(${v(model.extent)});
  point=card+ray*(dot(depth-card,view)/max(.3,dot(ray,view)));
 }
 vec3 plane=point-vec3(${center});
 vec2 localUV=vec2(dot(plane,right)/${Number(meta.projectionSize[0]).toFixed(8)}+.5,.5-dot(plane,up)/${Number(meta.projectionSize[1]).toFixed(8)});
 uv=(vec2(column,row)+clamp(localUV,vec2(.5/256.),vec2(1.-.5/256.)))/vec2(8.,2.);
 AtlasSurface result;
 result.color=textureGrad(uAlbedo,uv,gx,gy);
 if(any(lessThan(localUV,vec2(0.)))||any(greaterThan(localUV,vec2(1.))))result.color.a=0.;
 result.normal=textureGrad(uNormal,uv,gx,gy);result.source=textureGrad(uPosition,uv,gx,gy);return result;
}
void main(){
 float cs=cos(vYaw),sn=sin(vYaw);
 vec3 delta=(vWorld-vRootScale.xyz)/vRootScale.w;
 vec3 card=vec3((delta.x*cs-delta.z*sn)/vWidth,delta.y,(delta.x*sn+delta.z*cs)/vWidth);
 vec3 eyeDelta=(uCamera-vRootScale.xyz)/vRootScale.w;
 vec3 eye=vec3((eyeDelta.x*cs-eyeDelta.z*sn)/vWidth,eyeDelta.y,(eyeDelta.x*sn+eyeDelta.z*cs)/vWidth);
 vec3 ray=normalize(eye-card),captureView=normalize(eye-vec3(${center}));
 float angle=fract(atan(captureView.x,captureView.z)/6.28318530718+1.)*8.,column=floor(angle),azimuthBlend=fract(angle);
 float elevationBlend=clamp(asin(clamp(captureView.y,-1.,1.))/.436332313,0.,1.);
 vec3 dx=dFdx(card),dy=dFdy(card);
 vec4 color=vec4(0.),surface=vec4(0.),sourcePoint=vec4(0.);float coverage=0.;
 for(int row=0;row<2;row++)for(int neighbor=0;neighbor<2;neighbor++){
  float angularWeight=(row==0?elevationBlend:1.-elevationBlend)*(neighbor==0?1.-azimuthBlend:azimuthBlend);
  if(angularWeight<.0001)continue;
  AtlasSurface sampled=captureSurface(card,ray,mod(column+float(neighbor),8.),float(row),dx,dy);
  float weight=angularWeight*sampled.color.a;
  color+=vec4(sampled.color.rgb,1.)*weight;surface+=sampled.normal*weight;sourcePoint+=sampled.source*weight;coverage+=weight;
 }
 color=vec4(color.rgb/max(.0001,coverage),coverage);surface/=max(.0001,coverage);sourcePoint/=max(.0001,coverage);
 vec3 modelPosition=vec3(${v(model.minimum)})+sourcePoint.rgb*vec3(${v(model.extent)});
 float sourceFootprint=max(length(dFdx(modelPosition)),length(dFdy(modelPosition)));
 float cardFootprint=max(length(dFdx(vWorld)),length(dFdy(vWorld)))/max(.001,vRootScale.w*min(vWidth,1.));
 float voxelSize=${Math.min(...density.extent).toFixed(8)}/${Number(density.size||96).toFixed(1)};
 float densityLod=clamp(log2(max(max(sourceFootprint,cardFootprint),voxelSize)/voxelSize),0.,3.5);
 float sampleCoverage=${multisampled?'layeredCoverage(color.a,fract(vTint*173.123+vRootScale.w*17.13),mix(1.,.30,smoothstep(.12,.7,cardFootprint)))':'1.'};
 if(${multisampled?'sampleCoverage<=0.':'color.a<.20'})discard;
 vec3 meanNormal=surface.rgb*2.-1.;float normalLength=clamp(length(meanNormal),0.,1.);vec3 local=normalize(meanNormal+vec3(0.,.0001,0.));vec3 n=normalize(vec3(local.x*cs+local.z*sn,local.y*vWidth,-local.x*sn+local.z*cs));
 vec3 sun=normalize(uSun),localSun=normalize(vec3((sun.x*cs-sun.z*sn)/vWidth,sun.y,(sun.x*sn+sun.z*cs)/vWidth));float sunVisibility=foliageSunVisibility(modelPosition,localSun,densityLod),skyVisibility=clamp(surface.a,0.,1.);
 vec3 scaled=modelPosition*vRootScale.w*vec3(vWidth,1.,vWidth),sourceWorld=vRootScale.xyz+vec3(scaled.x*cs+scaled.z*sn,scaled.y,-scaled.x*sn+scaled.z*cs);
 vec3 viewDirection=normalize(uCamera-sourceWorld);if(dot(n,viewDirection)<0.)n=-n;
 vec3 isotropicSky=vec3(.201254991,.242362245,.334454446);
 float standOpen=standSkyVisibility(sourceWorld);
 vec3 shelter=crownSkylight(skyVisibility)*standOpen;
 vec3 frontSky=mix(isotropicSky,skyIrradiance(n),normalLength)*shelter;
 vec3 backSky=mix(isotropicSky,skyIrradiance(-n),normalLength)*shelter;
 vec4 clip=uLightProjection*vec4(sourceWorld,1.);float edge=.5-.5*max(abs(clip.x),abs(clip.y));
 float fineWeight=abs(clip.z)<1.?(1.-smoothstep(260.,340.,distance(sourceWorld.xz,uCamera.xz)))*smoothstep(0.,.05,edge):0.;
 float direct=sunVisibility;
 if(fineWeight<1.){
  float skip=crownExit(modelPosition,localSun)*length(localSun*vec3(vWidth,1.,vWidth))*vRootScale.w;
  direct*=standSunVisibility(sourceWorld,sun,skip);
 }
 if(fineWeight>0.)direct=mix(direct,min(castShadow(sourceWorld),sunVisibility),fineWeight);
 float cloud=cloudSunVisibility(sourceWorld,sun);
 float shadow=direct*cloud;
 vec3 solar=sunlightOverPi(sun)*cloud;
 frontSky+=crownSolarBounce(n.y*normalLength,skyVisibility,sunVisibility,solar,sun.y,standOpen);
 backSky+=crownSolarBounce(-n.y*normalLength,skyVisibility,sunVisibility,solar,sun.y,standOpen);
 float leafFraction=clamp(sourcePoint.a,0.,1.);
 float subpixel=smoothstep(.18,.85,cardFootprint)*smoothstep(1.,11.,readStand(sourceWorld.xz).y);
 float fill=${multisampled?'1.':'mix(1.,clamp(color.a,0.,1.),subpixel*leafFraction)'};
 vec3 phenotype=treeLeafPigment(vTint,${meta.name==='jacaranda'});
 vec3 albedo=color.rgb*.85*mix(vec3(1.),phenotype,leafFraction);
 float transmission=.32*leafFraction;
 float surfaceRoughness=clamp(sqrt(.66*.66+(1.-normalLength)*.45),.42,1.);
 vec3 reflectedSky=mix(isotropicSky,skyIrradiance(reflect(-viewDirection,n)),normalLength)*shelter;
 vec3 lit=(surfaceDiffuse(albedo,frontSky,backSky,transmission,max(0.,dot(n,viewDirection)),surfaceRoughness)
   +surfaceEnvironment(reflectedSky,max(0.,dot(n,viewDirection)),surfaceRoughness))*mix(.53,1.,fill)
   +surfaceDirect(albedo,n,viewDirection,sun,.66,transmission,normalLength)*shadow*mix(.06,1.,fill);
 vec4 surfaceClip=uViewProjection*vec4(sourceWorld,1.);gl_FragDepth=clamp(surfaceClip.z/surfaceClip.w*.5+.5,0.,1.);
 lit=aerialPerspective(lit,sourceWorld,uCamera,sun);
 if(uDebug==1)lit=vec3(.13,.36,.9);if(uDebug==2){outColor=vec4(n*.5+.5,sampleCoverage);return;}if(uDebug==3){outColor=vec4(vec3(skyVisibility*shadow),sampleCoverage);return;}outColor=vec4(tonemap(lit),sampleCoverage);
}`};
}
/** WebGL compatibility uses the same atlas and relighting. Call upload after
 * CPU visibility selection, then draw after the opaque geometry pass. */
export async function createGLTreeImpostors(gl,{species='oak',multisampled=false}={}) {
 const [metadata,albedoData,normalData,positionData,densityData]=await Promise.all([loadMetadata(species),loadAtlas(species,'albedo'),loadAtlas(species,'normal'),loadAtlas(species,'position'),loadDensity(species)]);
 metadata.density=densityData.metadata;
 const sources=treeImpostorGLSL(metadata,multisampled);
 const program=gl.createProgram();for(const [type,source]of[[gl.VERTEX_SHADER,sources.vertex],[gl.FRAGMENT_SHADER,sources.fragment]]){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader);gl.deleteShader(shader);}gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
 const atlasData=[albedoData,normalData,positionData].map(data=>{
  if(data.bytes)return new Uint8Array(data.bytes);
  const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(data.width,data.height):document.createElement('canvas');canvas.width=data.width;canvas.height=data.height;
  const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(data.bitmap,0,0);const bytes=new Uint8Array(context.getImageData(0,0,data.width,data.height).data);data.bitmap.close();return bytes;
 });
 extendAtlasSurfaceFields(atlasData,albedoData.width,albedoData.height);
 const textures=atlasData.map(()=>gl.createTexture());let levelData=atlasData,width=albedoData.width,height=albedoData.height;
 for(let level=0;level<8;level++){
  for(let part=0;part<3;part++){gl.bindTexture(gl.TEXTURE_2D,textures[part]);gl.texImage2D(gl.TEXTURE_2D,level,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,levelData[part]);}
  if(level===7)break;
  const nextWidth=width>>1,nextHeight=height>>1;const filtered=[new Uint8Array(nextWidth*nextHeight*4),new Uint8Array(nextWidth*nextHeight*4),new Uint8Array(nextWidth*nextHeight*4)];
  const raw=[new Float32Array(4),new Float32Array(4),new Float32Array(4)];
  const color=new Float32Array(3),normal=new Float32Array(4),position=new Float32Array(4);
  for(let y=0;y<nextHeight;y++)for(let x=0;x<nextWidth;x++){
   let weight=0;for(const part of raw)part.fill(0);color.fill(0);normal.fill(0);position.fill(0);
   for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
    const index=((y*2+dy)*width+x*2+dx)*4;const coverage=levelData[0][index+3]/255;weight+=coverage;
    for(let part=0;part<3;part++)for(let channel=0;channel<4;channel++)raw[part][channel]+=levelData[part][index+channel]*.25;
    for(let channel=0;channel<3;channel++){color[channel]+=levelData[0][index+channel]*coverage;normal[channel]+=(levelData[1][index+channel]/255*2-1)*coverage;}
    normal[3]+=levelData[1][index+3]*coverage;
    for(let channel=0;channel<4;channel++)position[channel]+=levelData[2][index+channel]*coverage;
   }
   const target=(y*nextWidth+x)*4,divisor=Math.max(.0001,weight);
   if(weight<.0001){for(let part=0;part<3;part++)for(let channel=0;channel<4;channel++)filtered[part][target+channel]=Math.round(raw[part][channel]);continue;}
   for(let channel=0;channel<3;channel++){filtered[0][target+channel]=Math.round(color[channel]/divisor);filtered[1][target+channel]=Math.round((normal[channel]/divisor*.5+.5)*255);}
   filtered[0][target+3]=Math.round(Math.min(1,weight*.25)*255);filtered[1][target+3]=Math.round(normal[3]/divisor);
   for(let channel=0;channel<4;channel++)filtered[2][target+channel]=Math.round(position[channel]/divisor);
  }
  levelData=filtered;width=nextWidth;height=nextHeight;
 }
 for(const texture of textures){gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,7);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}

 const densityTexture=gl.createTexture();gl.bindTexture(0x806F,densityTexture);
 const densityLevels=densityMipChain(densityData.bytes,metadata.density.size);
 densityLevels.forEach((level,mipLevel)=>{
  // WebGL's default UNPACK_ALIGNMENT is four, even for a one-channel map.
  // Pad rows at the 6/3/1 voxel levels instead of changing shared GL state.
  const stride=(level.size+3)&~3;let bytes=level.bytes;
  if(stride!==level.size){bytes=new Uint8Array(stride*level.size*level.size);for(let row=0;row<level.size*level.size;row++)bytes.set(level.bytes.subarray(row*level.size,(row+1)*level.size),row*stride);}
  gl.texImage3D(0x806F,mipLevel,gl.R8,level.size,level.size,level.size,0,gl.RED,gl.UNSIGNED_BYTE,bytes);
 });
 gl.texParameteri(0x806F,gl.TEXTURE_MAX_LEVEL,densityLevels.length-1);
 gl.texParameteri(0x806F,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(0x806F,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
 gl.texParameteri(0x806F,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(0x806F,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(0x806F,0x8072,gl.CLAMP_TO_EDGE);
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);const instanceBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);gl.bufferData(gl.ARRAY_BUFFER,32,gl.DYNAMIC_DRAW);for(let i=0;i<2;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,32,i*16);gl.vertexAttribDivisor(i,1);}const indexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,2,1,3]),gl.STATIC_DRAW);gl.bindVertexArray(null);
 const locations=Object.fromEntries(['uViewProjection','uLightProjection','uCamera','uSun','uDebug','uAlbedo','uNormal','uPosition','uShadow','uDensity','standEnvelope','uCloudCover','uUsePhotoCloud','uSurfaceDFG'].map(name=>[name,gl.getUniformLocation(program,name)]));let capacity=32,count=0;
 return {metadata,upload(data,nextCount=data.length/8){count=nextCount;if(!count)return;gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);if(count*32>capacity){capacity=2**Math.ceil(Math.log2(count*32));gl.bufferData(gl.ARRAY_BUFFER,capacity,gl.DYNAMIC_DRAW);}gl.bufferSubData(gl.ARRAY_BUFFER,0,data,0,count*8);},draw({viewProjection,lightProjection,camera,sun,shadowTexture,photoCloud=true,debug=0}){if(!count)return;gl.useProgram(program);gl.bindVertexArray(vao);gl.uniformMatrix4fv(locations.uViewProjection,false,viewProjection);gl.uniformMatrix4fv(locations.uLightProjection,false,lightProjection);gl.uniform3fv(locations.uCamera,camera);gl.uniform3fv(locations.uSun,sun);gl.uniform1i(locations.uDebug,debug);gl.uniform1i(locations.uSurfaceDFG,14);for(const[unit,texture]of[[5,textures[0]],[6,textures[1]],[7,shadowTexture],[8,textures[2]]]){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);}gl.uniform1i(locations.uAlbedo,5);gl.uniform1i(locations.uNormal,6);gl.uniform1i(locations.uShadow,7);gl.uniform1i(locations.uCloudCover,10);gl.uniform1i(locations.uUsePhotoCloud,+photoCloud);gl.uniform1i(locations.uPosition,8);gl.activeTexture(gl.TEXTURE0+9);gl.bindTexture(0x806F,densityTexture);gl.uniform1i(locations.uDensity,9);gl.activeTexture(gl.TEXTURE0+11);getGLStandTexture(gl);gl.uniform1i(locations.standEnvelope,11);gl.drawElementsInstanced(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0,count);},destroy(){textures.forEach(x=>gl.deleteTexture(x));gl.deleteTexture(densityTexture);gl.deleteBuffer(instanceBuffer);gl.deleteBuffer(indexBuffer);gl.deleteVertexArray(vao);gl.deleteProgram(program);}};
}
