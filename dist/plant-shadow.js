// Walking-distance leaves are narrower than a texel in the forest shadow map.
// A second, 32-metre sun frustum resolves their mutual shadows in centimetres.
export const plantShadowWGSL = /* wgsl */`
@group(2) @binding(9) var plantShadow:texture_depth_2d;
@group(2) @binding(10) var<uniform> plantLight:mat4x4<f32>;
fn nearPlantSun(world:vec3<f32>,normal:vec3<f32>)->f32 {
 let distance=length(world.xz-u.camera.xz);
 if(distance>11.0) {return 1.0;}
 let p=plantLight*vec4<f32>(world+normal*0.003,1.0);
 let uv=p.xy*vec2<f32>(0.5,-0.5)+0.5;
 if(any(uv<vec2<f32>(0.002))||any(uv>vec2<f32>(0.998))||p.z<0.0||p.z>1.0) {return 1.0;}
 var visibility=0.0;
 for(var y=0;y<2;y++) {for(var x=0;x<2;x++) {
  visibility+=textureSampleCompareLevel(plantShadow,shadowSampler,uv+(vec2<f32>(f32(x),f32(y))-0.5)/2048.0,p.z-0.00004);
 }}
 return mix(visibility*0.25,1.0,smoothstep(8.0,11.0,distance));
}`;
export const plantShadowGLSL = /* glsl */`
uniform highp sampler2DShadow uPlantShadow;
uniform mat4 uPlantLightProjection;
float nearPlantSun(vec3 world,vec3 normal) {
 float distanceToEye=length(world.xz-uCamera.xz);
 if(distanceToEye>11.) return 1.;
 vec3 p=(uPlantLightProjection*vec4(world+normal*.003,1.)).xyz*.5+.5;
 if(any(lessThan(p,vec3(.002)))||any(greaterThan(p,vec3(.998))))return 1.;
 float visible=0.;
 for(int y=0;y<2;y++)for(int x=0;x<2;x++){
  visible+=texture(uPlantShadow,vec3(p.xy+(vec2(x,y)-.5)/2048.,p.z-.00004));
 }
 return mix(visible*.25,1.,smoothstep(8.,11.,distanceToEye));
}`;
