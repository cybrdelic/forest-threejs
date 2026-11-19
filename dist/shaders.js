import { reliefWGSL } from './stand-relief.js';
import {foliageWindWGSL, motionPackingWGSL} from './foliage-motion.js';
import { treeLodWGSL } from './tree-lod.js';
import { outerLightWGSL } from './aggregate-canopy.js';
import { coveragePatternWGSL } from './sample-coverage.js';
import { solarIrradianceWGSL, surfaceLightWGSL } from './surface-light.js';
import {terrainSurfaceWGSL} from './terrain-surface.js';
import { terrainCullWGSL } from './terrain-visibility.js';
import { crownSurfaceWGSL, crownTransferWGSL } from './crown-light.js';
import { standLightingWGSL } from './stand-envelope.js';
import { receiverLightingWGSL, SHADOW_CASTER_DISTANCE, LEAF_CASTER_DISTANCE } from './forest-shadow.js';
import { cloudLightWGSL, aerialWGSL } from './weather-light.js';
export const uniforms = /* wgsl */`
struct Uniforms {
 vp:mat4x4<f32>, invVP:mat4x4<f32>, lightVP:mat4x4<f32>,
 camera:vec4<f32>, sun:vec4<f32>, resolution:vec4<f32>, settings:vec4<f32>,
 limits:vec4<f32>, viewDir:vec4<f32>, volumeOrigin:vec4<f32>, previousVP:mat4x4<f32>, previousEyeTime:vec4<f32>
};
@group(0) @binding(0) var<uniform> u:Uniforms;
`;
export const skyIrradianceWGSL = /* wgsl */`
// Diffuse irradiance / pi from the actual photographic environment.
// Nine real SH coefficients use Lambert convolution (1,2/3,1/4).
// Direct solar outliers were excluded to avoid counting the sun twice.
fn skyIrradiance(normal:vec3<f32>)->vec3<f32> {
 let sun=normalize(u.sun.xyz);
 let yaw=atan2(0.376731,0.554562)-atan2(sun.z,sun.x);
 let n=normalize(vec3<f32>(normal.x*cos(yaw)-normal.z*sin(yaw),normal.y,normal.x*sin(yaw)+normal.z*cos(yaw)));
 return max(vec3<f32>(0.001),
  vec3<f32>(0.713444550,0.859165958,1.185655634)*(0.282094792)
 +vec3<f32>(0.369586967,0.419638238,0.663911574)*(0.488602512*n.y)
 +vec3<f32>(0.101090582,0.121634141,0.169236832)*(0.488602512*n.z)
 +vec3<f32>(0.155977186,0.193847656,0.281589709)*(0.488602512*n.x)
 +vec3<f32>(0.062577879,0.076230505,0.112202581)*(1.092548431*n.x*n.y)
 +vec3<f32>(0.041736068,0.048346705,0.067249809)*(1.092548431*n.y*n.z)
 +vec3<f32>(-0.012710686,-0.014984557,-0.023997670)*(0.315391565*(3.0*n.z*n.z-1.0))
 +vec3<f32>(0.034547790,0.039977740,0.055649094)*(1.092548431*n.x*n.z)
 +vec3<f32>(-0.017840595,-0.014064861,-0.012430041)*(0.546274215*(n.x*n.x-n.y*n.y))
);
}
`;
export const skyIrradianceGLSL = /* glsl */`
vec3 skyIrradiance(vec3 normal) {
 vec3 sun=normalize(uSun);float yaw=atan(0.376731,0.554562)-atan(sun.z,sun.x);
 vec3 n=normalize(vec3(normal.x*cos(yaw)-normal.z*sin(yaw),normal.y,normal.x*sin(yaw)+normal.z*cos(yaw)));
 return max(vec3(0.001),
  vec3(0.713444550,0.859165958,1.185655634)*(0.282094792)
 +vec3(0.369586967,0.419638238,0.663911574)*(0.488602512*n.y)
 +vec3(0.101090582,0.121634141,0.169236832)*(0.488602512*n.z)
 +vec3(0.155977186,0.193847656,0.281589709)*(0.488602512*n.x)
 +vec3(0.062577879,0.076230505,0.112202581)*(1.092548431*n.x*n.y)
 +vec3(0.041736068,0.048346705,0.067249809)*(1.092548431*n.y*n.z)
 +vec3(-0.012710686,-0.014984557,-0.023997670)*(0.315391565*(3.0*n.z*n.z-1.0))
 +vec3(0.034547790,0.039977740,0.055649094)*(1.092548431*n.x*n.z)
 +vec3(-0.017840595,-0.014064861,-0.012430041)*(0.546274215*(n.x*n.x-n.y*n.y))
);
}
`;
export const cullShader = uniforms + /* wgsl */`
struct Instance { position:vec4<f32>, variation:vec4<f32> };
struct Draw { indexCount:u32, instanceCount:atomic<u32>, firstIndex:u32, baseVertex:u32, firstInstance:u32 };
@group(1) @binding(0) var<storage,read> instances:array<Instance>;
@group(1) @binding(1) var<storage,read_write> visible:array<u32>;
@group(1) @binding(2) var<storage,read_write> draws:array<Draw>;
${terrainCullWGSL}
${treeLodWGSL}
@group(1) @binding(4) var<storage,read_write> treeLevels:array<u32>;
@compute @workgroup_size(128)
fn trees(@builtin(global_invocation_id) id:vec3<u32>) {
 let i=id.x;
 if(i>=arrayLength(&instances)) { return; }
 let tree=instances[i];
 let center=tree.position.xyz+vec3<f32>(0.0,9.0*tree.position.w,0.0);
 let radius=15.0*tree.position.w;
 let distance=length(center-u.camera.xyz);
 let capacity=arrayLength(&visible)/6u;
 if(distance<${SHADOW_CASTER_DISTANCE}.0 && distance>=${LEAF_CASTER_DISTANCE}.0) {
  let index=atomicAdd(&draws[3].instanceCount,1u);
  visible[capacity*3u+index]=i;
 }
 if(distance<${LEAF_CASTER_DISTANCE}.0) {let slot=atomicAdd(&draws[4].instanceCount,1u);visible[capacity*4u+slot]=i;}
 if(distance>u.limits.w) { return; }
 let clip=u.vp*vec4<f32>(center,1.0);
 let margin=radius*(max(abs(u.vp[0][0]),abs(u.vp[1][1]))+1.0);
 if(clip.w < -radius || abs(clip.x)>clip.w+margin || abs(clip.y)>clip.w+margin || clip.z < -radius) { return; }
 if(treeBehindTerrain(tree.position,tree.variation.z)) {return;}
 // The first eight authored specimens split four per species.
 let level=treeDetailLevel(distance,tree.position.w,tree.variation.z,i<4u,u.limits.y,u.limits.z,treeLevels[i]);
 treeLevels[i]=level;
 let lod=array<u32,4>(0u,1u,5u,2u)[level-1u];
 let index=atomicAdd(&draws[lod].instanceCount,1u);
 visible[capacity*lod+index]=i;
}
@compute @workgroup_size(128)
fn grass(@builtin(global_invocation_id) id:vec3<u32>) {
 let i=id.x;
 if(i>=arrayLength(&instances)) { return; }
 if(instances[i].position.w<=0.0) {return;}
 let p=instances[i].position.xyz;
 let distance=length(p-u.camera.xyz);
 let farPatch=instances[i].variation.z>1.5;
 if(distance>select(70.0,170.0,farPatch)||(farPatch&&distance<40.0)) {return;}
 let clip=u.vp*vec4<f32>(p+vec3<f32>(0,0.5,0),1);
 if(clip.w<0.0 || abs(clip.x)>clip.w+3.0 || abs(clip.y)>clip.w+3.0) {return;}
 let variant=min(3u,u32(instances[i].variation.w*4.0));
 let capacity=arrayLength(&visible)/4u;
 let index=atomicAdd(&draws[variant].instanceCount,1u);
 visible[capacity*variant+index]=i;
}
@compute @workgroup_size(128)
fn closeGrass(@builtin(global_invocation_id) id:vec3<u32>) {
 let i=id.x;
 if(i>=arrayLength(&instances)) { return; }
 if(instances[i].position.w<=0.0) {return;}
 let p=instances[i].position.xyz;
 if(length(p-u.camera.xyz)>12.0) { return; }
 let clip=u.vp*vec4<f32>(p+vec3<f32>(0.0,0.35,0.0),1.0);
 if(clip.w<0.0 || abs(clip.x)>clip.w+1.0 || abs(clip.y)>clip.w+1.0) { return; }
 let slot=atomicAdd(&draws[0].instanceCount,1u);
 visible[slot]=i;
}@compute @workgroup_size(128)
fn closeGrassShadow(@builtin(global_invocation_id) id:vec3<u32>) {
 let i=id.x;
 if(i>=arrayLength(&instances)) { return; }
 if(instances[i].position.w<=0.0) {return;}
 let p=instances[i].position.xyz;
 if(length(p-u.camera.xyz)>12.0) { return; }
 let slot=atomicAdd(&draws[0].instanceCount,1u);
 visible[slot]=i;
 let community=1u+min(3u,u32(instances[i].variation.w*4.0));
 let capacity=arrayLength(&visible)/5u;
 let plantSlot=atomicAdd(&draws[community].instanceCount,1u);
 visible[capacity*community+plantSlot]=i;
}
`;
import { plantShadowWGSL } from './plant-shadow.js';
export const geometryShader = uniforms + foliageWindWGSL + motionPackingWGSL + coveragePatternWGSL + surfaceLightWGSL + plantShadowWGSL + cloudLightWGSL.replace('CLOUD_SAMPLER','materialSampler') + skyIrradianceWGSL + /* wgsl */`
struct Instance { position:vec4<f32>, variation:vec4<f32> };
@group(1) @binding(0) var<storage,read> instances:array<Instance>;
@group(1) @binding(1) var<storage,read> visible:array<u32>;
override nearTreePass:bool=false;
@group(2) @binding(0) var shadowMap:texture_depth_2d;
@group(2) @binding(1) var shadowSampler:sampler_comparison;
@group(2) @binding(2) var radiance:texture_3d<f32>;
@group(2) @binding(3) var volumeSampler:sampler;
@group(2) @binding(4) var surfaceAlbedo:texture_2d_array<f32>;
@group(2) @binding(5) var surfaceNormal:texture_2d_array<f32>;
@group(2) @binding(6) var materialSampler:sampler;
@group(2) @binding(8) var standEnvelope:texture_2d<f32>;
${standLightingWGSL.replaceAll("standSampler","volumeSampler")}
${receiverLightingWGSL}
${outerLightWGSL}
${reliefWGSL}
struct VertexIn { @location(0) position:vec3<f32>, @location(1) normal:vec3<f32>, @location(2) color:vec3<f32>, @location(3) extra:vec3<f32> };
struct VertexOut { @builtin(position) clip:vec4<f32>, @location(0) world:vec3<f32>, @location(1) normal:vec3<f32>, @location(2) color:vec3<f32>, @location(3) extra:vec3<f32>, @location(4) crownLight:vec2<f32>, @location(5) @interpolate(flat) coveragePhase:f32, @location(6) windMotion:vec2<f32> };
// Homogeneous crown extinction is evaluated in tree coordinates. The
// directional path varies with each leaf's position, rather than distance to
// the camera; this keeps inner foliage shaded after switching LODs.
fn crownExitBounds(local:vec3<f32>,direction:vec3<f32>,center:vec3<f32>,radius:vec3<f32>)->f32 {
 let p=(local-center)/radius;
 let d=direction/radius;
 let a=dot(d,d);let b=dot(p,d);let c=dot(p,p)-1.0;
 let discriminant=b*b-a*c;
 if(discriminant<0.0) {return 0.0;}
 let root=sqrt(discriminant);
 return max(0.0,(-b+root)/a-max(0.0,(-b-root)/a));
}
${crownTransferWGSL}
${crownSurfaceWGSL}
fn crownVisibilityForMaterial(local:vec3<f32>,yaw:f32,material:f32)->vec2<f32> {
 let sun=normalize(u.sun.xyz);
 let cs=cos(yaw);let sn=sin(yaw);
 let localSun=vec3<f32>(sun.x*cs-sun.z*sn,sun.y,sun.x*sn+sun.z*cs);
 let oak=material>4.5&&material<5.5;
 // Exact grounded source leaf bounds, rather than one oversized crown for
 // both species. Ray lengths are measured in each unscaled model's metres.
 let center=select(vec3<f32>(-0.711726,10.859104,-0.376526),vec3<f32>(0.522748,10.568585,2.672641),oak);
 let radius=select(vec3<f32>(12.208525,8.609772,9.577288),vec3<f32>(5.104225,5.380008,7.511835),oak);
 let skyPath=crownExitBounds(local,vec3<f32>(0.0,1.0,0.0),center,radius);
 let sunPath=crownExitBounds(local,localSun,center,radius);
 return vec2<f32>(exp(-skyPath*0.105),exp(-sunPath*0.145));
}
fn crownVisibility(local:vec3<f32>,yaw:f32)->vec2<f32> {return crownVisibilityForMaterial(local,yaw,6.0);}
fn meadowHeightFade(material:f32,far:bool,distance:f32)->f32 {
 let overlap=smoothstep(40.0,70.0,distance);
 let layer=select(1.-overlap,overlap*(1.-smoothstep(120.,170.,distance)),far);
 if(fract(material)>.05){return layer*(1.-smoothstep(8.,12.,distance));}
 if(material>6.5&&material<8.5){return layer*smoothstep(7.,11.,distance);}
 return layer;
}
fn transformed(v:VertexIn, id:u32, windStrength:f32)->VertexOut {
 let instance=instances[visible[id]];
 let plant=(v.extra.x>2.5&&v.extra.x<4.5)||v.extra.x>6.5;
 let step=select(0.0,floor(instance.variation.x*.125),plant);
 let lodging=step/15.;
 let yaw=instance.variation.x-8.*step;
 let cs=cos(yaw); let sn=sin(yaw);
 var local=v.position*instance.position.w;
 var priorHeight=local.y;
 if(!plant) {local.x*=0.78+instance.variation.z*0.48;local.z*=0.78+instance.variation.z*0.48;}
 if(plant) {
  let far=instance.variation.z>1.5;
  if(far) {local.xz*=2.8;}
  if(fract(v.extra.x)>0.05) {
   let phenotype=fract(sin(dot(instance.position.xz,vec2<f32>(17.13,41.71)))*9173.17);
   if(v.extra.x<4.15) {
    let leafSeed=fract(sin(dot(v.extra.yz+instance.position.xz,vec2<f32>(63.31,17.93)))*7163.29);
    let turn=(leafSeed-0.5)*1.3;
    let anchor=v.extra.yz*instance.position.w;
    let delta=local.xz-anchor;
    local.xz=anchor+vec2<f32>(delta.x*cos(turn)+delta.y*sin(turn),-delta.x*sin(turn)+delta.y*cos(turn));
    local.y*=0.76+leafSeed*0.45;
   }
   local.xz*=vec2<f32>(0.82+phenotype*0.39,1.21-phenotype*0.38);
  }
  priorHeight=local.y*meadowHeightFade(v.extra.x,far,distance(instance.position.xyz,u.previousEyeTime.xyz));
  local.y*=meadowHeightFade(v.extra.x,far,distance(instance.position.xyz,u.camera.xyz));
 }
 let bladeHeight=clamp(local.y/0.55,0.0,1.5);
 let wind=select(select(v.extra.y,0.5+local.y*0.02,v.extra.x>4.5),bladeHeight*bladeHeight*0.75,plant);
 let presentBend=windOffset(instance.position.xyz,local.y,wind,u.resolution.z,windStrength);
 let oldBlade=clamp(priorHeight/.55,0.,1.5);
 let priorWind=select(wind,oldBlade*oldBlade*.75,plant);
 let priorBend=windOffset(instance.position.xyz,priorHeight,priorWind,u.previousEyeTime.w,u.sun.w);
 local.xz+=presentBend;
 let bendDelta=priorBend-presentBend;
 let horizontalBend=vec2<f32>(bendDelta.x*cs+bendDelta.y*sn,-bendDelta.x*sn+bendDelta.y*cs);
 // Lodging rotates the upper sward toward the prevailing lay without
 // moving the root. Apply the matching inverse transpose to leaf normals.
 let lay=vec2<f32>(cs,-sn);
 let shear=.82*lodging;
 let upright=1.-.66*lodging;
 let heightDelta=priorHeight-local.y;
 let worldBend=horizontalBend+lay*shear*heightDelta;
 var rotated=vec3<f32>(local.x*cs+local.z*sn,local.y*upright,-local.x*sn+local.z*cs);
 rotated=vec3<f32>(rotated.x+lay.x*shear*local.y,rotated.y,rotated.z+lay.y*shear*local.y);
 var world=rotated+instance.position.xyz;
 let gradient=vec2<f32>(instance.variation.y,instance.variation.z-select(0.0,4.0,instance.variation.z>1.5));
 if(plant) {world.y+=dot(gradient,rotated.xz);}
 let horizontalScale=select(0.78+instance.variation.z*0.48,select(1.0,2.8,instance.variation.z>1.5),plant);
 var normal=normalize(vec3<f32>(v.normal.x*cs+v.normal.z*sn,v.normal.y*horizontalScale,-v.normal.x*sn+v.normal.z*cs));
 if(plant) {
  if(fract(v.extra.x)>0.05) {
   let phenotype=fract(sin(dot(instance.position.xz,vec2<f32>(17.13,41.71)))*9173.17);
   let shape=vec2<f32>(0.82+phenotype*0.39,1.21-phenotype*0.38);
   var sourceNormal=v.normal;
   if(v.extra.x<4.15) {
    let leafSeed=fract(sin(dot(v.extra.yz+instance.position.xz,vec2<f32>(63.31,17.93)))*7163.29);
    let turn=(leafSeed-0.5)*1.3;
    sourceNormal=vec3<f32>(v.normal.x*cos(turn)+v.normal.z*sin(turn),v.normal.y/(0.76+leafSeed*0.45),-v.normal.x*sin(turn)+v.normal.z*cos(turn));
   }
   let corrected=normalize(vec3<f32>(sourceNormal.x/shape.x,sourceNormal.y,sourceNormal.z/shape.y));
   normal=normalize(vec3<f32>(corrected.x*cs+corrected.z*sn,corrected.y,-corrected.x*sn+corrected.z*cs));
  }
  normal.y=(normal.y-shear*dot(lay,normal.xz))/upright;
  normal=normalize(vec3<f32>(normal.x-gradient.x*normal.y,normal.y,normal.z-gradient.y*normal.y));
 }
 var out:VertexOut;
 out.windMotion=projectedWindDelta(world,vec3<f32>(worldBend.x,heightDelta*upright+select(0.0,dot(gradient,worldBend),plant),worldBend.y));
 out.world=world;
 out.clip=u.vp*vec4<f32>(world,1);
 out.normal=normal;
 out.color=v.color*mix(vec3<f32>(0.80,0.88,0.72),vec3<f32>(1.12,1.07,0.91),instance.variation.y);
 if(plant) {
  let vigor=smoothstep(0.19,0.84,fract(instance.variation.w*4.0));
  out.color=v.color*mix(vec3<f32>(0.83,0.78,0.68),vec3<f32>(1.04,1.09,1.03),vigor);
  if(v.extra.x>8.5) {out.color=v.color;}
 }
 out.extra=v.extra;
 out.coveragePhase=shootPhase(instance.variation.w,v.position,v.extra.yz);
 out.crownLight=select(crownVisibilityForMaterial(v.position,yaw,v.extra.x),vec2<f32>(1.0),plant);
 if(v.color.z>16000000.0) {
  out.crownLight=measuredCrownVisibility(v.color,u.sun.xyz,yaw,0.78+instance.variation.z*0.48);
  out.color=vec3<f32>(1.0);
 }
 if(v.extra.x>4.5&&v.extra.x<6.5) {out.color=treeLeafPigment(instance.variation.y,v.extra.x>5.5);}
 if((v.extra.x>6.5&&v.extra.x<8.5)||(v.extra.x>3.5&&v.extra.x<4.5)) {
  // Homogeneous meadow extinction from source LAI~2.3 and k=0.5.
  let opticalDepth=1.15*clamp(1.0-v.position.y/0.34,0.0,1.0);
  out.crownLight=vec2<f32>(exp(-opticalDepth),exp(-opticalDepth/max(u.sun.y,0.18)));
 }
 return out;
}
@vertex fn vegetationVS(v:VertexIn,@builtin(instance_index) id:u32)->VertexOut { return transformed(v,id,u.resolution.w); }
@vertex fn terrainVS(v:VertexIn)->VertexOut {
 var out:VertexOut;
 var world=v.position;
 if(v.extra.x==2.0&&v.extra.y== -2.0) {
  let blend=smoothstep(210.0,425.0,distance(world.xz,u.camera.xz));
  world.y-=(v.extra.z+0.25)*(1.0-blend);
 }
 out.world=world; out.clip=u.vp*vec4<f32>(world,1); out.normal=v.normal; out.color=v.color; out.extra=v.extra;
 // An aggregate crown represents unresolved leaf layers, rather than a
 // completely exposed solid surface. Preserve average canopy extinction.
 out.crownLight=select(vec2<f32>(0.32,0.20),vec2<f32>(1.0),v.extra.x<1.5);
 if(v.extra.x==2.0&&v.extra.y>=0.0) {out.crownLight=outerCanopyLight(v.extra.yz,u.sun.xyz);}
 return out;
}
override liveTreeShadow:bool=false;
struct ShadowOut { @builtin(position) clip:vec4<f32>, @location(0) extra:vec3<f32> };
@vertex fn shadowVS(v:VertexIn,@builtin(instance_index) id:u32)->ShadowOut {
 // The wide forest map is cached across camera cells. Bake its mean crown
 // pose so rebuilding that cache cannot change the phase of every leaf shadow.
 // Nearby meadow shadows are updated with the current wind every frame.
 let plant=(v.extra.x>2.5&&v.extra.x<4.5)||v.extra.x>6.5;
 let transformedVertex=transformed(v,id,select(0.0,u.resolution.w,plant||liveTreeShadow));
 var out:ShadowOut;out.clip=u.lightVP*vec4<f32>(transformedVertex.world,1);out.extra=v.extra;return out;
}
@fragment fn shadowAlpha(v:ShadowOut) {
 let dx=dpdx(v.extra.yz);let dy=dpdy(v.extra.yz);
 if(v.extra.x>4.5) {
  let layer=i32(round(v.extra.x))-2;
  let coverage=textureSampleGrad(surfaceAlbedo,materialSampler,v.extra.yz,layer,dx,dy).a;
  if(coverage<0.5) {discard;}
 }
}
@vertex fn terrainShadowVS(v:VertexIn)->@builtin(position) vec4<f32> { return u.lightVP*vec4<f32>(v.position,1); }
fn hash(p:vec3<f32>)->f32 { return fract(sin(dot(p,vec3<f32>(12.9898,78.233,37.719)))*43758.5453); }
fn shadowAt(p:vec3<f32>,normal:vec3<f32>)->f32 {
 let offset=p.xz-u.camera.xz;
 if(dot(offset,offset)>340.0*340.0) {return 1.0;}
 let projected=u.lightVP*vec4<f32>(p+normal*select(-0.045,0.045,dot(normal,u.sun.xyz)>=0.0),1);
 let uv=projected.xy*vec2<f32>(0.5,-0.5)+0.5;
 if(any(uv<vec2<f32>(0.002))||any(uv>vec2<f32>(0.998))||projected.z>1.0||projected.z<0.0) {return 1.0;}
 var shadow=0.0;
 for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
 shadow+=textureSampleCompareLevel(shadowMap,shadowSampler,uv+vec2<f32>(f32(x),f32(y))*1.6/4096.0,projected.z-0.000055);
 }}
 return shadow/9.0;
}
${terrainSurfaceWGSL}
fn coneTrace(position:vec3<f32>,direction:vec3<f32>)->vec4<f32> {
 var result=vec4<f32>(0);
 var distance=10.0;
 for(var step=0;step<5;step++) {
  let uv=(position+direction*distance-u.volumeOrigin.xyz)/512.0;
  if(any(uv<vec3<f32>(0))||any(uv>vec3<f32>(1))) { break; }
  let sample=textureSampleLevel(radiance,volumeSampler,uv,log2(max(1.0,distance*0.48/8.0)));
  result+=sample*(1.0-result.a);
  distance*=1.85;
 }
 return result;
}
struct FragmentOut { @location(0) color:vec4<f32>, @location(1) normal:vec4<f32>, @builtin(sample_mask) mask:u32 };
@fragment fn geometryFS(v:VertexOut,@builtin(front_facing) front:bool)->FragmentOut {
 var n=normalize(v.normal);
 let material=v.extra.x;
 let grass=(material>2.5&&material<4.5)||material>6.5;
 if(!front && material>2.5) { n=-n; }
 let gradientX=dpdx(v.world);
 let gradientY=dpdy(v.world);
 let leafGradientX=dpdx(v.extra.yz);
 let leafGradientY=dpdy(v.extra.yz);
 var ground:GroundSurface;
 var albedo=v.color*0.85;
 var standAperture=1.;
 if(material==2.0) {
  let relief=crownRelief(n,v.world.xz,gradientX.xz,gradientY.xz,select(1./256.,1./141.,v.extra.y<0.));
  n=relief.xyz;standAperture=relief.w;
 }
 var coverage=1.0;
 var unresolvedSlope=0.;
 if(material<0.5) {
  ground=pastureSurface(v.world,n,gradientX,gradientY,clamp(v.extra.z,0.0,1.0),v.color);
  albedo=ground.albedo;
  n=ground.normal;
 } else if(material<1.5) {
  let uv=vec2<f32>(v.world.x+v.world.z,v.world.y)*vec2<f32>(1.5,0.65);
  let dx=vec2<f32>(gradientX.x+gradientX.z,gradientX.y)*vec2<f32>(1.5,0.65);
  let dy=vec2<f32>(gradientY.x+gradientY.z,gradientY.y)*vec2<f32>(1.5,0.65);
  albedo=textureSampleGrad(surfaceAlbedo,materialSampler,uv,2,dx,dy).rgb*0.9;
  let bump=textureSampleGrad(surfaceNormal,materialSampler,uv,2,dx,dy).xyz*2.0-1.0;
  let tangent=normalize(cross(vec3<f32>(0.001,1,0),n));
  let bitangent=cross(n,tangent);
  n=normalize(n*bump.z+tangent*bump.x+bitangent*bump.y);
 }
 if(material>4.5) {
  let uv=v.extra.yz;
  let leafLayer=i32(round(material))-2;
  let photographed=textureSampleGrad(surfaceAlbedo,materialSampler,uv,leafLayer,leafGradientX,leafGradientY);
  let normalMask=textureSampleGrad(surfaceNormal,materialSampler,uv,leafLayer,leafGradientX,leafGradientY);
  coverage=normalMask.a;
  if(coverage<=0.0) {discard;}
  // Filter color weighted by the photographed area before recovering reflectance.
  let leafColor=photographed.rgb/max(normalMask.a,1.0/255.0);
  albedo=leafColor*v.color*select(0.85,1.0,grass);
  if(material>8.5 && v.color.r<0.99) {
   // Flower photos have bright sunlit yellows. A paler broad component in
   // the petal surface avoids applying that captured illumination twice.
   let neutral=dot(leafColor,vec3<f32>(0.2126,0.7152,0.0722));
   albedo=mix(leafColor,vec3<f32>(neutral),0.17)*v.color;
  }
  let bump=(normalMask.xyz*2.-1.-vec3<f32>(0.,0.,1.-normalMask.a))/max(normalMask.a,1./255.);
  unresolvedSlope=.65*.65*max(0.,2.*(1.-min(1.,length(bump))));
  // Build a cotangent frame from source UVs. Photographic leaf and grass
  // normal maps then retain their veins and folded surface at close range.
  let perpendicularY=cross(gradientY,n);
  let perpendicularX=cross(n,gradientX);
  let tangent=perpendicularY*leafGradientX.x+perpendicularX*leafGradientY.x;
  let bitangent=perpendicularY*leafGradientX.y+perpendicularX*leafGradientY.y;
  let frameScale=inverseSqrt(max(max(dot(tangent,tangent),dot(bitangent,bitangent)),0.000001));
  n=normalize(n*max(0.15,bump.z)+(tangent*bump.x+bitangent*bump.y)*frameScale*0.65);
 }
 let toSun=normalize(u.sun.xyz);
 let view=normalize(u.camera.xyz-v.world);
 if(material>2.5&&dot(n,view)<0.0) {n=-n;}
 let forest=select(0.0,clamp(v.extra.y,0.0,1.0),material<0.5);
 let treeSurface=(material>0.5&&material<1.5)||(material>4.5&&material<6.5);
 let grassCrown=select(1.0,mix(0.20,1.0,v.crownLight.y),material>6.5&&material<8.5);
 let receiverCrown=select(v.crownLight.y,grassCrown,grass);
 var shadow=receiverSun(v.world,toSun,shadowAt(v.world,n),receiverCrown,forest,treeSurface);
 shadow=min(shadow,nearPlantSun(v.world,n));
 let cloudLight=cloudSunVisibility(v.world,toSun);
 shadow*=cloudLight;
 let sky=skyIrradiance(n);
 var cone=vec4<f32>(0);
 if(material<1.5) {cone=coneTrace(v.world+n*6.0,normalize(n+vec3<f32>(0,1.01,0)));}
 else if(grass) {
  // Terrain occupies an entire 8 m voxel. A blade-height lookup is inside
  // that opaque slab and falsely shades the whole meadow. The cone's
  // first sample is 10 m upward, above the slab but within tree crowns.
  cone=coneTrace(v.world,vec3<f32>(0.0,1.0,0.0));
 } else {
  let volumeUV=(v.world+n*5.0-u.volumeOrigin.xyz)/512.0;
  if(all(volumeUV>vec3<f32>(0))&&all(volumeUV<vec3<f32>(1))) {cone=textureSampleLevel(radiance,volumeSampler,volumeUV,1.8);}
 }
 var shelter=1.0-cone.a*0.67;
 let domain=standDomainWeight(v.world);
 if(material<0.5||treeSurface) {
  if(domain>0.0) {shelter=min(shelter,mix(1.0,standSkyVisibility(v.world),domain));}
 }
 var ambient=sky*shelter+cone.rgb*0.40;
 var ambientBack=skyIrradiance(-n)*shelter+cone.rgb*0.40;
 let groundExposure=mix(mix(1.0,0.28,forest),1.0,domain);
 let skyShelter=select(mix(0.26,1.0,v.crownLight.x),groundExposure,material<0.5);
 let internalSky=select(vec3<f32>(skyShelter),crownSkylight(v.crownLight.x),treeSurface);
 ambient*=internalSky*standAperture;ambientBack*=internalSky*standAperture;
 if(grass) {
  let backSky=skyIrradiance(-n);
  // A thin blade reflects skylight from its visible side and transmits a
  // smaller fraction from the other side. It is not an opaque crown shell.
  ambient=sky*(1.0-cone.a*0.52)+cone.rgb*0.20;
  ambientBack=backSky*(1.0-cone.a*0.52)+cone.rgb*0.20;
  if((material>6.5&&material<8.5)||(material>3.5&&material<4.5)) {let bladeShelter=mix(0.25,1.0,v.crownLight.x);ambient*=bladeShelter;ambientBack*=bladeShelter;}
 }
 if(material<0.5) {
  let sideA=coneTrace(v.world+n*7.0,normalize(n+vec3<f32>(0.8,0.35,0.3)));
  ambient=ambient*(1.0-sideA.a*0.20)+sideA.rgb*0.16;
 }
 let diffuseTransmission=select(0.0,select(0.32,0.50,grass),material>1.5);
 let roughness=select(select(0.85,min(1.,sqrt(sqrt(.18974736+unresolvedSlope))),material>1.5),0.91,material<0.5);
 let reflection=reflect(-view,n);
 var reflectedSky=skyIrradiance(reflection)*shelter*internalSky;
 if(material<.5 && v.extra.z>.01) {
  // Voxels resolve trees but a whole tuft fits below their first vertical
  // sample. Through a bare patch the sky stays visible; in the root zone
  // diffuse and grazing reflected rays encounter the explicit shoots.
  let section=ground.occupied*smoothstep(.01,.75,v.extra.z)*(1.-smoothstep(105.,170.,length(v.world-u.camera.xyz)));
  let skyPass=mix(1.,exp(-.86*ground.lai),section);
  let bounce=ground.leaf*(.5*(ambient+ambientBack)+sunlightOverPi(toSun)*shadow*.25);
  ambient=mix(bounce,ambient,skyPass);ambientBack=mix(bounce,ambientBack,skyPass);
  let elevation=dot(reflection,normalize(v.normal));
  let specPass=mix(1.,exp(-.5*ground.lai/max(.28,elevation)),section);
  reflectedSky=mix(bounce,reflectedSky,specPass);
 }
 if(grass) {
  // A ray reflected sideways at the base of a tuft crosses the surrounding
  // blades before it reaches the sky. Use the local blade radiance for that
  // part of the rough reflection. The two sward captures supply the pigment.
  let coneWidth=roughness*roughness;
  let skyFraction=smoothstep(-coneWidth,coneWidth,reflection.y);
  let opening=pow(clamp(v.crownLight.x,0.005,1.0),1.0/max(coneWidth*0.5,reflection.y));
  let neighbor=vec3<f32>(0.136,0.231,0.027)*(0.5*(ambient+ambientBack)+sunlightOverPi(toSun)*shadow*0.25);
  reflectedSky=mix(neighbor,reflectedSky,skyFraction*opening);
 }
 let outerAperture=select(-1.,standAperture,material>1.9 && material<2.1 && v.extra.y>=0.);
 var color=surfaceDiffuse(albedo,ambient,ambientBack,diffuseTransmission,dot(n,view),roughness)
  +surfaceEnvironment(reflectedSky,dot(n,view),roughness)
  +surfaceDirectFiltered(albedo,n,view,toSun,roughness,diffuseTransmission,1.0,outerAperture)*shadow;
 if(material<0.5 && v.extra.z>0.01) {
  let footprintBlend=smoothstep(105.,170.,length(v.world-u.camera.xyz))*smoothstep(0.01,0.75,v.extra.z);
  if(footprintBlend>0.) {
   let blades=pastureCanopy(ground,normalize(v.normal),view,toSun,shadow,shelter*skyShelter,color);
   color=mix(color,blades,footprintBlend);
  }
 }
 if(u.settings.x>0.5 && u.settings.x<1.5) {
  let distance=length(v.world-u.camera.xyz);
  color=select(select(vec3<f32>(0.20,0.43,1.0),vec3<f32>(1.0,0.53,0.12),distance<u.limits.z),vec3<f32>(0.15,0.90,0.38),distance<u.limits.y);
  if(treeSurface) {color=select(vec3<f32>(1.0,0.53,0.12),vec3<f32>(0.15,0.90,0.38),nearTreePass);}
  if(material<0.5) {color=vec3<f32>(0.18);}
 }
 var out:FragmentOut;
 out.color=vec4<f32>(color,packFoliageMotion(v.windMotion));out.mask=coverageMask(coverage,v.coveragePhase);
 out.normal=vec4<f32>(n*0.5+0.5,select(material/4.0,0.75,grass));
 return out;
}
`;
export const skyShader=uniforms+/* wgsl */`
@group(1) @binding(0) var cloudNoise:texture_3d<f32>;
@group(1) @binding(1) var cloudSampler:sampler;
@group(1) @binding(2) var photographicSky:texture_2d<f32>;
@group(1) @binding(3) var photographicCloudDetail:texture_2d<f32>;
@group(1) @binding(4) var skySampler:sampler;
fn cloudDensity(p:vec3<f32>)->f32 {
 let height=(p.y-1100.0)/700.0;
 let profile=smoothstep(0.0,0.16,height)*(1.0-smoothstep(0.55,1.0,height));
 let advected=p+vec3<f32>(u.resolution.z*1.5,0,u.resolution.z*0.3);
 let coverage=textureSampleLevel(cloudNoise,cloudSampler,vec3<f32>(advected.x*0.00007,0.25,advected.z*0.00007),0).r;
 let base=textureSampleLevel(cloudNoise,cloudSampler,advected*vec3<f32>(0.00055,0.0010,0.00055),0).r;
 let detail=textureSampleLevel(cloudNoise,cloudSampler,advected*0.0031,0).r;
 return max(0.0,base+coverage*0.40-detail*0.13-0.73)*profile*7.0;
}

struct Out { @builtin(position) clip:vec4<f32>,@location(0) uv:vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {
 let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
 var out:Out; out.clip=vec4<f32>(p[i],0.999999,1);out.uv=p[i]*vec2<f32>(0.5,-0.5)+0.5;return out;
}
fn hash(p:vec2<f32>)->f32 {return fract(sin(dot(p,vec2<f32>(127.1,311.7)))*43758.5453);}
fn noise(p:vec2<f32>)->f32 {
 let i=floor(p);var f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2<f32>(1,0)),f.x),mix(hash(i+vec2<f32>(0,1)),hash(i+vec2<f32>(1,1)),f.x),f.y);
}
fn fbm(p:vec2<f32>)->f32 {
 var q=p;var value=0.0;var weight=0.52;
 for(var i=0;i<5;i++) {value+=noise(q)*weight;q=q*2.03+vec2<f32>(37.0,17.0);weight*=0.48;}
 return value;
}
struct FragmentOut { @location(0) color:vec4<f32>, @location(1) normal:vec4<f32> };
@fragment fn fs(v:Out)->FragmentOut {
 let h=u.invVP*vec4<f32>(v.uv*vec2<f32>(2,-2)+vec2<f32>(-1,1),1,1);
 let direction=normalize(h.xyz/h.w-u.camera.xyz);
 if(u.settings.z<0.5) {
  let sourceSun=vec3<f32>(0.554562,0.741980,0.376731);
  let currentSun=normalize(u.sun.xyz);
  let yaw=atan2(sourceSun.z,sourceSun.x)-atan2(currentSun.z,currentSun.x);
  var lookup=vec3<f32>(direction.x*cos(yaw)-direction.z*sin(yaw),direction.y,direction.x*sin(yaw)+direction.z*cos(yaw));
  lookup=normalize(vec3<f32>(lookup.x,max(0.012,lookup.y),lookup.z));
  let uv=vec2<f32>(atan2(lookup.z,lookup.x)/6.2831853+0.5,acos(clamp(lookup.y,-1.0,1.0))/3.14159265);
  let base=textureSampleLevel(photographicSky,skySampler,uv,0).rgb;
  // Explicit longitude derivatives prevent the equirectangular seam from selecting
  // the coarsest mip while looking across it. V covers only the upper hemisphere.
  let detailUV=uv*vec2<f32>(1,2);
  var dx=dpdx(detailUV); var dy=dpdy(detailUV);
  dx.x=dx.x-round(dx.x); dy.x=dy.x-round(dy.x);
  let gain=textureSampleGrad(photographicCloudDetail,skySampler,detailUV,dx,dy).r;
  let radiance=base*exp2((gain*255.0-128.0)/48.0);
  var out:FragmentOut;out.color=vec4<f32>(radiance*1.25,0);out.normal=vec4<f32>(0.5,1,0.5,1);return out;
 }
 let elevation=max(direction.y,0.0);
 let sunDir=normalize(u.sun.xyz);
 let warm=1.0-smoothstep(0.08,0.5,sunDir.y);
 var color=mix(vec3<f32>(0.50,0.68,0.87),vec3<f32>(0.035,0.19,0.46),pow(elevation,0.42));
 color=mix(color,color*vec3<f32>(1.4,0.83,0.65),warm*pow(1.0-elevation,3.0));
 let sunDot=max(0.0,dot(direction,sunDir));
 color+=vec3<f32>(1.0,0.78,0.48)*pow(sunDot,14.0)*0.18;
 color+=vec3<f32>(12.0,10.0,7.0)*smoothstep(0.99990,0.99996,sunDot);
 if(direction.y>0.04) {
  let start=max(0.0,(1100.0-u.camera.y)/direction.y);
  let finish=min(25000.0,(1800.0-u.camera.y)/direction.y);
  let step=max(0.0,finish-start)/32.0;
  var transmittance=1.0;var scattered=vec3<f32>(0);
  for(var i=0;i<32;i++) {
   let p=u.camera.xyz+direction*(start+(f32(i)+0.5)*step);
   let density=cloudDensity(p);
   let opacity=1.0-exp(-density*step*0.009);
   let blocked=cloudDensity(p+sunDir*110.0);
   let sunVisibility=exp(-blocked*3.0);
   let phase=0.20+0.35*pow(sunDot,12.0);
   let light=vec3<f32>(0.30,0.37,0.46)+vec3<f32>(1.5,1.42,1.28)*(sunVisibility*0.70+phase);
   scattered+=transmittance*opacity*light;
   transmittance*=1.0-opacity;
  }
  color=color*transmittance+scattered;
 }
 var out:FragmentOut;out.color=vec4<f32>(color,0);out.normal=vec4<f32>(0.5,1,0.5,1);return out;
}
`;
export const postShader=uniforms+aerialWGSL+/* wgsl */`
@group(1) @binding(0) var colorMap:texture_2d<f32>;
@group(1) @binding(1) var normalMap:texture_2d<f32>;
@group(1) @binding(2) var depthMap:texture_depth_2d;
@group(1) @binding(3) var screenSampler:sampler;
struct Out { @builtin(position) clip:vec4<f32>,@location(0) uv:vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {
 let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
 var out:Out;out.clip=vec4<f32>(p[i],0,1);out.uv=p[i]*vec2<f32>(0.5,-0.5)+0.5;return out;
}
fn worldAt(pixel:vec2<i32>)->vec3<f32> {
 let dimensions=vec2<i32>(textureDimensions(depthMap));
 let coord=clamp(pixel,vec2<i32>(0),dimensions-1);
 let depth=textureLoad(depthMap,coord,0);
 let uv=(vec2<f32>(coord)+0.5)/vec2<f32>(dimensions);
 let p=u.invVP*vec4<f32>(uv*vec2<f32>(2,-2)+vec2<f32>(-1,1),depth,1);
 return p.xyz/p.w;
}
fn aces(color:vec3<f32>)->vec3<f32> { return clamp((color*(2.51*color+0.03))/(color*(2.43*color+0.59)+0.14),vec3<f32>(0),vec3<f32>(1)); }
@fragment fn fs(v:Out)->@location(0) vec4<f32> {
 let dimensions=vec2<i32>(textureDimensions(depthMap));
 let pixel=clamp(vec2<i32>(v.uv*vec2<f32>(dimensions)),vec2<i32>(0),dimensions-1);
 let depth=textureLoad(depthMap,pixel,0);
 var color=textureLoad(colorMap,pixel,0).rgb;
 let normalData=textureLoad(normalMap,pixel,0);
 let n=normalize(normalData.xyz*2.0-1.0);
 var ao=1.0;
 if(depth<0.999998) {
  let position=worldAt(pixel);
  let distance=length(position-u.camera.xyz);
  let radius=clamp(520.0/max(distance,2.0),2.0,24.0);
  let offsets=array<vec2<f32>,8>(vec2<f32>(1,0),vec2<f32>(0.7,0.7),vec2<f32>(0,1),vec2<f32>(-0.7,0.7),vec2<f32>(-1,0),vec2<f32>(-0.7,-0.7),vec2<f32>(0,-1),vec2<f32>(0.7,-0.7));
  var occlusion=0.0;var bounce=vec3<f32>(0);
  for(var i=0;i<8;i++) {
   let samplePixel=clamp(pixel+vec2<i32>(offsets[i]*radius),vec2<i32>(0),dimensions-1);
   let delta=worldAt(samplePixel)-position;
   let sampleDistance=length(delta);
   let weight=smoothstep(0.08,0.65,dot(n,normalize(delta+vec3<f32>(0.0001))))*(1.0-smoothstep(0.5,7.0,sampleDistance));
   occlusion+=weight;
   bounce+=textureLoad(colorMap,samplePixel,0).rgb*weight;
  }
  // Subpixel blades are mutually adjacent, not solid walls. Full solid
  // surface SSAO over-darkens a dense sward and creates a near-LOD band.
  let grassPixel=normalData.a>0.70&&normalData.a<0.80;
  ao=clamp(1.0-occlusion*select(0.16,0.045,grassPixel),select(0.35,0.73,grassPixel),1.0);
  color=color*ao+bounce*0.014;
  color=aerialPerspective(color,position,u.camera.xyz,u.sun.xyz);
 }
 if(u.settings.x>1.5 && u.settings.x<2.5) {return vec4<f32>(normalData.xyz,1);}
 if(u.settings.x>2.5) {return vec4<f32>(vec3<f32>(ao),1);}
 color=aces(color*u.settings.y);
 color=pow(color,vec3<f32>(1.0/2.2));
 let vignette=1.0-0.13*dot(v.uv-0.5,v.uv-0.5);
 let dither=(fract(sin(dot(vec2<f32>(pixel),vec2<f32>(12.9898,78.233)))*43758.5453)-0.5)/255.0;
 return vec4<f32>(color*vignette+dither,1);
}
`;
const voxelCloudLight=cloudLightWGSL.replace('@group(2) @binding(7)','@group(1) @binding(3)').replace('CLOUD_SAMPLER','linearSampler');
export const volumeShader=uniforms+solarIrradianceWGSL+skyIrradianceWGSL+voxelCloudLight+/* wgsl */`
@group(1) @binding(0) var occupancy:texture_3d<f32>;
@group(1) @binding(1) var outputVolume:texture_storage_3d<rgba16float,write>;
@group(1) @binding(2) var linearSampler:sampler;
@compute @workgroup_size(4,4,4)
fn light(@builtin(global_invocation_id) id:vec3<u32>) {
 if(any(id>=vec3<u32>(64))) {return;}
 let voxel=textureLoad(occupancy,vec3<i32>(id),0);
 // Fully solid subsoil still blocks cones. It has no exposed scattering face.
 if(voxel.a<0.01 || voxel.a>.99) {textureStore(outputVolume,vec3<i32>(id),vec4<f32>(0.,0.,0.,voxel.a));return;}
 var transmission=1.0;
 let uv=(vec3<f32>(id)+0.5)/64.0;
 for(var i=1;i<=10;i++) {
  let sampleUV=uv+u.sun.xyz*f32(i)*1.5/64.0;
  if(any(sampleUV<vec3<f32>(0))||any(sampleUV>vec3<f32>(1))) {break;}
  let blocked=textureSampleLevel(occupancy,linearSampler,sampleUV,0).a;
  transmission*=1.0-blocked*0.72;
 }
 let world=u.volumeOrigin.xyz+uv*512.;
 let solar=sunlightOverPi(u.sun.xyz)*cloudSunVisibility(world,u.sun.xyz)*transmission;
 // A short upward column estimates sky visibility at the coarser voxel scale.
 var skyVisibility=1.;
 for(var i=1;i<=3;i++) {
  let above=vec3<i32>(id)+vec3<i32>(0,i,0);
  if(above.y>=64){break;}
  skyVisibility*=1.-textureLoad(occupancy,above,0).a;
 }
 var radiance:vec3<f32>;
 if(voxel.a>.85) {
  let xz=voxel.rg*2.-1.;
  let normal=normalize(vec3<f32>(xz.x,sqrt(max(.0001,1.-dot(xz,xz))),xz.y));
  // Mean diffuse ground terms from the litter and grass material sources.
  let reflectance=mix(vec3<f32>(.1497,.1062,.0617),vec3<f32>(.1341,.2341,.0260),voxel.b);
  radiance=reflectance*(skyIrradiance(normal)*skyVisibility+solar*max(0.,dot(normal,u.sun.xyz)));
 } else {
  // Isotropic two-sided foliage: average max(n·sun,0) is 1/4. The mean
  // diffuse sky term is precisely the constant (l=0) term of the sky SH.
  let skyMean=vec3<f32>(.713444550,.859165958,1.185655634)*.282094792;
  radiance=voxel.rgb*(1.+.32)*(skyMean*skyVisibility+solar*.25);
 }
 textureStore(outputVolume,vec3<i32>(id),vec4<f32>(radiance*voxel.a,voxel.a));
}
`;
export const mipShader=/* wgsl */`
@group(0) @binding(0) var source:texture_3d<f32>;
@group(0) @binding(1) var destination:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
 let dimensions=textureDimensions(destination);
 if(any(id>=dimensions)) {return;}
 var value=vec4<f32>(0);
 for(var z=0;z<2;z++) {for(var y=0;y<2;y++) {for(var x=0;x<2;x++) {
 value+=textureLoad(source,vec3<i32>(id)*2+vec3<i32>(x,y,z),0);
 }}}
 textureStore(destination,vec3<i32>(id),value*0.125);
}
`;
