// Trampled sod and shallow bare patches have the same metric boundary in
// the CPU seed bank and the two ground shaders. Each footprint ends inside
// its own 3.4 m cell. The integer hash stays exact on either GPU backend.
function gapSeed(x,z) {
  let h=(Math.imul(x,1597334677)^Math.imul(z,3812015801))>>>0;
  h=Math.imul(h^(h>>>16),2246822519);
  return (h^(h>>>13))>>>0;
}
function smooth(a,b,x) {
  const t=Math.min(1,Math.max(0,(x-a)/(b-a)));
  return t*t*(3-2*t);
}
export function meadowSoilGap(x,z) {
  const px=(.8660254*x+.5*z)/3.4,pz=(.8660254*z-.5*x)/3.4;
  const ix=Math.floor(px),iz=Math.floor(pz),h=gapSeed(ix,iz);
  if((h&255)>108)return 0;
  const a=((h>>>8)&255)/255,b=((h>>>16)&255)/255,t=(h>>>24)/255;
  const dx=px-ix-.5-(a-.5)*.24,dz=pz-iz-.5-(b-.5)*.22;
  const u=dx/(.167+.11*b);
  const v=(dz+dx*(a-.5)*.96+dx*dx*(t-.5)*1.78)/(.078+.051*t);
  const edge=1+.22*Math.sin(4.1*u+5.8*v+6*t)+.11*Math.sin(7.3*v-6*u+4*a);
  return 1-smooth(.42,1.08,(u*u+v*v)*edge);
}
export const meadowGapWGSL = /* wgsl */`
fn meadowSoilGap(xz:vec2<f32>,footprint:f32)->f32 {
 let p=vec2<f32>(.8660254*xz.x+.5*xz.y,.8660254*xz.y-.5*xz.x)/3.4;
 let id=bitcast<vec2<u32>>(vec2<i32>(floor(p)));
 var h=(id.x*1597334677u)^(id.y*3812015801u);
 h=(h^(h>>16u))*2246822519u;h=h^(h>>13u);
 let a=f32((h>>8u)&255u)/255.;let b=f32((h>>16u)&255u)/255.;let t=f32(h>>24u)/255.;
 let d=fract(p)-.5-(vec2<f32>(a,b)-.5)*vec2<f32>(.24,.22);
 let u=d.x/(.167+.11*b);
 let v=(d.y+d.x*(a-.5)*.96+d.x*d.x*(t-.5)*1.78)/(.078+.051*t);
 let edge=1.+.22*sin(4.1*u+5.8*v+6.*t)+.11*sin(7.3*v-6.*u+4.*a);
 let distance2=(u*u+v*v)*edge;let w=min(.4,footprint*1.7);
 let gap=select(0.,1.-smoothstep(.42-w,1.08+w,distance2),(h&255u)<=108u);
 return mix(gap,.023,smoothstep(.35,1.45,footprint));
}
`;
export const meadowGapGLSL = /* glsl */`
float meadowSoilGap(vec2 xz,float footprint) {
 vec2 p=vec2(.8660254*xz.x+.5*xz.y,.8660254*xz.y-.5*xz.x)/3.4;
 highp uvec2 id=uvec2(ivec2(floor(p)));
 highp uint h=(id.x*1597334677u)^(id.y*3812015801u);
 h=(h^(h>>16u))*2246822519u;h=h^(h>>13u);
 float a=float((h>>8u)&255u)/255., b=float((h>>16u)&255u)/255., t=float(h>>24u)/255.;
 vec2 d=fract(p)-.5-(vec2(a,b)-.5)*vec2(.24,.22);
 float u=d.x/(.167+.11*b);
 float v=(d.y+d.x*(a-.5)*.96+d.x*d.x*(t-.5)*1.78)/(.078+.051*t);
 float edge=1.+.22*sin(4.1*u+5.8*v+6.*t)+.11*sin(7.3*v-6.*u+4.*a);
 float distance2=(u*u+v*v)*edge,w=min(.4,footprint*1.7);
 float gap=(h&255u)<=108u?1.-smoothstep(.42-w,1.08+w,distance2):0.;
 return mix(gap,.023,smoothstep(.35,1.45,footprint));
}
`;
