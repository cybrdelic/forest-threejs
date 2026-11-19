import {motionPackingWGSL} from './foliage-motion.js';
// Four independent depth samples let silhouettes reveal real leaf layers
// behind them. WebGPU sets the sample mask; WebGL uses alpha-to-coverage.
export const sceneSamples = 4;
export const normalFormat = 'rgba8unorm';
export const vegetationSampling = { count:sceneSamples };

// Keep the order and rounding phase attached to a source patch. Multiple
// partially visible leaves in the same pixel can cover different samples;
// no frame index, screen-space noise, or draw order enters the pattern.
export const coveragePatternWGSL = /* wgsl */`
fn shootPhase(seed:f32,local:vec3<f32>,uv:vec2<f32>)->f32 {
 return fract(seed*173.123+dot(floor(local*2.0+0.5),vec3<f32>(.1031,.3972,.771))
   +dot(floor(clamp(uv,vec2<f32>(0.),vec2<f32>(.999))*4.),vec2<f32>(.718217,.415)));
}
fn coverageMask(area:f32,phase:f32)->u32 {
 let bits=u32(fract(phase)*65536.);
 let rotation=bits&3u;
 let count=u32(clamp(floor(area*4.+f32((bits>>2u)&255u)/256.),0.,4.));
 let base=(1u<<count)-1u;
 return ((base<<rotation)|(base>>(4u-rotation)))&15u;
}`;

export const shootPhaseGLSL = /* glsl */`
float shootPhase(float seed,vec3 local,vec2 uv){
 return fract(seed*173.123+dot(floor(local*2.+.5),vec3(.1031,.3972,.771))
   +dot(floor(clamp(uv,vec2(0.),vec2(.999))*4.),vec2(.718217,.415)));
}`;

// GLES does not expose a writable sample mask in WebGL2. Integrate a
// circular interval of width w against a leaf's opaque fraction. Its mean
// over independent source phases is exactly area, including at 0 and 1.
export const layeredCoverageGLSL = /* glsl */`
float layeredCoverage(float area,float phase,float w){
 return (clamp(area-phase,0.,w)+clamp(min(phase+w-1.,area),0.,w))/w;
}`;

export const depthResolveShader = motionPackingWGSL + /* wgsl */`
@group(0) @binding(0) var source:texture_depth_multisampled_2d;
@group(0) @binding(1) var hdr:texture_multisampled_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4<f32> {
 let triangle=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));
 return vec4<f32>(triangle[index],0.,1.);
}
struct ResolvedSurface { @builtin(frag_depth) depth:f32, @location(0) motion:vec2<f32> };
@fragment fn fs(@builtin(position) p:vec4<f32>)->ResolvedSurface {
 let xy=vec2<i32>(p.xy);
 let a=textureLoad(source,xy,0); let b=textureLoad(source,xy,1);
 let c=textureLoad(source,xy,2); let d=textureLoad(source,xy,3);
 // Use actual surface depth, favoring the front surface at a two-sample tie.
 // A single stray grass sample cannot send all four samples' history to it.
 let depth=min(min(max(a,b),max(c,d)),max(min(a,b),min(c,d)));
 let sample=select(select(select(3,2,c==depth),1,b==depth),0,a==depth);
 return ResolvedSurface(depth,unpackFoliageMotion(textureLoad(hdr,xy,sample).a));
}`;
