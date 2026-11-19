import { inverse } from './math.js';
import { uniforms } from './shaders.js';

// Compose in double precision before uploading. Reconstructing far-away world
// coordinates per pixel and multiplying them back loses subpixel motion.
export function historyTransform(currentVP, previousVP) {
 const currentInverse = inverse(currentVP, Float64Array);
 const transform = new Float32Array(16);
 for (let column = 0; column < 4; column++) {
  for (let row = 0; row < 4; row++) {
   let value = 0;
   for (let k = 0; k < 4; k++) value += previousVP[k*4+row] * currentInverse[column*4+k];
   transform[column*4+row] = value;
  }
 }
 return transform;
}

export const temporalShader = uniforms + /* wgsl */`
struct PreviousFrame {
 clipFromCurrent: mat4x4<f32>,
 // x: history valid; yz: change in UV jitter; w: startup retention limit.
 parameters: vec4<f32>
};
@group(1) @binding(0) var currentImage:texture_2d<f32>;
@group(1) @binding(1) var historyImage:texture_2d<f32>;
@group(1) @binding(2) var depthImage:texture_depth_2d;
@group(1) @binding(3) var windMotion:texture_2d<f32>;
@group(1) @binding(4) var<uniform> previous:PreviousFrame;

struct Vertex {
 @builtin(position) clip:vec4<f32>,
 @location(0) uv:vec2<f32>
};
@vertex fn vs(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
 var v:Vertex;
 v.clip=vec4<f32>(p[index],0,1);
 v.uv=p[index]*vec2<f32>(0.5,-0.5)+0.5;
 return v;
}

// xy: history UV, z: expected history depth, w: current depth. The sky's
// world homogeneous W is zero, so camera translation cannot drag the clouds.
fn historySurface(ndc:vec2<f32>, depth:f32)->vec4<f32> {
 var clip=vec4<f32>(ndc,depth,1.0);
 let inverseW=dot(clip,vec4<f32>(u.invVP[0].w,u.invVP[1].w,u.invVP[2].w,u.invVP[3].w));
 let sky=depth>=1.0;
 if(sky && abs(u.invVP[2].w)>0.00001) { clip.z-=inverseW/u.invVP[2].w; }
 let old=previous.clipFromCurrent*clip;
 let currentDepth=1.0/max(inverseW,0.0000001);
 let oldDepth=select(old.w*currentDepth,62000.0,sky);
 let oldUV=old.xy/max(old.w,0.000001)*vec2<f32>(0.5,-0.5)+0.5+previous.parameters.yz;
 return vec4<f32>(oldUV,select(-1.0,oldDepth,old.w>0.0),select(currentDepth,62000.0,sky));
}

fn depthMatch(stored:f32,expected:f32)->f32 {
 let tolerance=max(0.10,abs(expected)*0.011);
 return 1.0-smoothstep(tolerance,tolerance*2.0,abs(stored-expected));
}

@fragment fn fs(v:Vertex)->@location(0) vec4<f32> {
 let dimensions=vec2<i32>(textureDimensions(currentImage));
 let extent=vec2<f32>(dimensions);
 let pixel=clamp(vec2<i32>(v.uv*extent),vec2<i32>(0),dimensions-1);
 let depth=textureLoad(depthImage,pixel,0);
 let ndc=v.uv*vec2<f32>(2,-2)+vec2<f32>(-1,1);
 var surface=historySurface(ndc,depth);
 let windPixels=textureLoad(windMotion,pixel,0).xy;
 surface.xy+=windPixels/extent;
 let current=textureLoad(currentImage,pixel,0).rgb;
 if(previous.parameters.x<0.5 || u.settings.x>0.5 || surface.z<=0.0 ||
    any(surface.xy<vec2<f32>(0.0)) || any(surface.xy>vec2<f32>(1.0))) {
  return vec4<f32>(current,surface.w);
 }
 let coordinate=surface.xy*extent-0.5;
 let base=vec2<i32>(floor(coordinate));
 let f=fract(coordinate);
 var taps:array<vec4<f32>,4>;
 var weights:array<f32,4>;
 var areas:array<f32,4>;
 var confidence=0.0;
 for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
  let i=x+2*y;
  taps[i]=textureLoad(historyImage,clamp(base+vec2<i32>(x,y),vec2<i32>(0),dimensions-1),0);
  areas[i]=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
  weights[i]=depthMatch(taps[i].a,surface.z);
  confidence+=weights[i]*areas[i];
 }}

 // An edge pixel stores the accumulated coverage of several surfaces but
 // only one depth. A leaf and the gap beside it frequently alternate under
 // subpixel sampling. Retain the mixed color only if the former depth is
 // still visible beside this pixel AND both depths have nearly the same
 // projected motion. Large parallax and freshly revealed backgrounds reset.
 let motion=length((surface.xy-v.uv)*extent);
 let previousColor=mix(mix(taps[0].rgb,taps[1].rgb,f.x),mix(taps[2].rgb,taps[3].rgb,f.x),f.y);
 var coverageEdge=0.0;
 var motionSpread=0.0;
 if((confidence<0.995 || length(previousColor-current)>0.035) && motion<3.0) {
  let offsets=array<vec2<i32>,4>(vec2<i32>(-1,0),vec2<i32>(1,0),vec2<i32>(0,-1),vec2<i32>(0,1));
  for(var k=0;k<4;k++) {
   let adjacent=clamp(pixel+offsets[k],vec2<i32>(0),dimensions-1);
   let otherDepth=textureLoad(depthImage,adjacent,0);
   var other=historySurface(ndc,otherDepth);
   other.xy+=textureLoad(windMotion,adjacent,0).xy/extent;
   let separation=length((other.xy-surface.xy)*extent);
   motionSpread=max(motionSpread,separation);
   let support=(1.0-smoothstep(0.18,0.9,separation))*(1.0-smoothstep(0.75,3.0,motion));
   coverageEdge=max(coverageEdge,support*(1.0-depthMatch(other.z,surface.z)));
   for(var i=0;i<4;i++){
    let supported=select(0.0,support*depthMatch(taps[i].a,other.z),other.z>0.0);
    weights[i]=max(weights[i],supported);
   }
  }
 }
 var history=vec3<f32>(0);
 confidence=0.0;
 for(var i=0;i<4;i++){
  let weight=areas[i]*weights[i];
  history+=taps[i].rgb*weight;
  confidence+=weight;
 }
 if(confidence<0.015) { return vec4<f32>(current,surface.w); }
 history/=confidence;
 // Plain bilinear reprojection repeatedly smooths a translating texture.
 // Recover the missing curvature of a cubic interpolation on each axis.
 // At disocclusions or mixed depths use the accepted linear reconstruction.
 let contrast=dot(abs(taps[0].rgb-taps[3].rgb)+abs(taps[1].rgb-taps[2].rgb),vec3<f32>(.2126,.7152,.0722));
 let phase=f*(1.0-f);
 if(confidence>0.999 && motion>0.025 && contrast>0.006 && max(phase.x,phase.y)>0.012) {
  let nearest=vec2<i32>(round(f));
  let row=nearest.y*2;
  let col=nearest.x;
  let extra=array<vec2<i32>,4>(vec2<i32>(-1,nearest.y),vec2<i32>(2,nearest.y),vec2<i32>(nearest.x,-1),vec2<i32>(nearest.x,2));
  var outer:array<vec3<f32>,4>;
  var support=1.0;
  var lo=taps[0].rgb;var hi=taps[0].rgb;
  for(var i=0;i<4;i++){
   let tap=textureLoad(historyImage,clamp(base+extra[i],vec2<i32>(0),dimensions-1),0);
   outer[i]=tap.rgb;
   support=min(support,min(depthMatch(tap.a,surface.z),depthMatch(taps[i].a,surface.z)));
   lo=min(lo,taps[i].rgb);hi=max(hi,taps[i].rgb);
  }
  let sx=mix(2.0*taps[row].rgb-outer[0]-taps[row+1].rgb,2.0*taps[row+1].rgb-taps[row].rgb-outer[1],f.x);
  let sy=mix(2.0*taps[col].rgb-outer[2]-taps[col+2].rgb,2.0*taps[col+2].rgb-taps[col].rgb-outer[3],f.y);
  let correction=0.5*(phase.x*sx+phase.y*sy);
  history=mix(history,clamp(history+correction,lo,hi),support);
 }

 var lower=current;
 var upper=current;
 for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
  let c=textureLoad(currentImage,clamp(pixel+vec2<i32>(x,y),vec2<i32>(0),dimensions-1),0).rgb;
  lower=min(lower,c); upper=max(upper,c);
 }}
 let padding=min(vec3<f32>(0.009),(upper-lower)*0.125);
 history=clamp(history,lower-padding,upper+padding);
 let weight=mix(0.89,0.65,smoothstep(0.25,7.0,motion));
 let reactive=clamp(length(current-history)*0.22,0.0,0.15);
 // A mixed pixel can retain the same majority depth after its minority
 // leaf has moved away. Relative surface motion and a color mismatch
 // shorten that history; still leaves keep the original integration window.
 let unresolved=smoothstep(0.035,0.8,motionSpread)*smoothstep(0.035,0.3,length(current-history));
 let retention=min(previous.parameters.w,mix(weight-reactive,0.94,coverageEdge)*(1.-0.74*unresolved));
 return vec4<f32>(mix(current,history,retention*smoothstep(0.0,0.65,confidence)),surface.w);
}
`;
