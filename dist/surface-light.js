import { dielectricDFG } from './dielectric-dfg.js';
// Direct illumination is calibrated to the solar disk in the resident HDR.
// skyIrradiance() and sunlightOverPi() both return irradiance divided by pi.
// Texture diffuse color is reflected albedo. Thin leaves additionally
// transmit a fraction of that pigment, limited by the remaining energy.
// GGX follows the height-correlated Smith formulation documented by Filament.

const dfgBytes=Uint8Array.from(dielectricDFG,value=>Math.round(value*255));
const gpuTextures=new WeakMap();
const glTextures=new WeakMap();
export function gpuSurfaceDFG(device) {
 let texture=gpuTextures.get(device);
 if(!texture) {
  texture=device.createTexture({label:'Integrated dielectric GGX reflectance',size:[32,16],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},dfgBytes,{bytesPerRow:32},[32,16]);
  gpuTextures.set(device,texture);
 }
 return texture;
}
export function glSurfaceDFG(gl) {
 let texture=glTextures.get(gl);
 if(!texture) {
  texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,32,16,0,gl.RED,gl.UNSIGNED_BYTE,dfgBytes);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  glTextures.set(gl,texture);
 }
 return texture;
}

export const solarIrradianceWGSL = /* wgsl */`
fn sunlightOverPi(sun:vec3<f32>)->vec3<f32> {
 let opticalMass=1.0/max(0.08,sun.y)-1.0/0.741980412;
 return vec3<f32>(1.39009419,1.40065419,1.27155350)*exp(-vec3<f32>(0.15,0.23,0.42)*opticalMass);
}
`;
export const surfaceLightWGSL = solarIrradianceWGSL + /* wgsl */`
@group(2) @binding(11) var surfaceDFG:texture_2d<f32>;
fn ggxDirectionalReflectance(noV:f32,roughness:f32)->f32 {
 let grid=vec2<f32>(clamp(noV,0.0,1.0)*31.0,clamp((roughness-0.42)/0.58,0.0,1.0)*15.0);
 return textureSampleLevel(surfaceDFG,materialSampler,(grid+0.5)/vec2<f32>(32.0,16.0),0.0).r;
}
fn surfaceEnvironment(reflectedSky:vec3<f32>,noV:f32,roughness:f32)->vec3<f32> {
 return reflectedSky*ggxDirectionalReflectance(noV,roughness);
}
fn surfaceDiffuse(albedo:vec3<f32>,frontSky:vec3<f32>,backSky:vec3<f32>,transmission:f32,noV:f32,roughness:f32)->vec3<f32> {
 let nonSpecular=1.0-ggxDirectionalReflectance(noV,roughness);
 let reflected=clamp(albedo,vec3<f32>(0),vec3<f32>(0.95));
 let transmitted=min(vec3<f32>(0.95)-reflected,reflected*transmission);
 return nonSpecular*(reflected*frontSky+transmitted*backSky);
}
fn surfaceDirectFiltered(albedo:vec3<f32>,normal:vec3<f32>,view:vec3<f32>,sun:vec3<f32>,roughness:f32,transmission:f32,normalCoherence:f32,standAperture:f32)->vec3<f32> {
 let coherence=clamp(normalCoherence,0.0,1.0);
 let noV=max(0.001,dot(normal,view));
 let noL=max(0.0,dot(normal,sun));
 let backL=max(0.0,dot(-normal,sun));
 let forwardDiffuse=mix(0.25,noL,coherence);
 let backDiffuse=mix(0.25,backL,coherence);
 let diffuseBudget=1.0-ggxDirectionalReflectance(noV,roughness);
 let reflected=clamp(albedo,vec3<f32>(0),vec3<f32>(0.95));
 let transmitted=min(vec3<f32>(0.95)-reflected,reflected*transmission);
 let diffuse=(reflected*forwardDiffuse+transmitted*backDiffuse)*diffuseBudget;
 let halfDirection=normalize(view+sun+vec3<f32>(0.000001));
 let noH=max(0.0,dot(normal,halfDirection));
 let loH=max(0.0,dot(sun,halfDirection));
 // The variance in an averaged normal widens the lobe at distant LODs.
 let perceptualRoughness=clamp(sqrt(roughness*roughness+(1.0-coherence)*0.45),0.42,1.0);
 let alpha=perceptualRoughness*perceptualRoughness;
 let alpha2=alpha*alpha;
 let denominator=1.0+noH*noH*(alpha2-1.0);
 let distribution=alpha2/(3.141592654*denominator*denominator);
 let visibility=0.5/max(0.00001,noL*sqrt(noV*noV*(1.0-alpha2)+alpha2)+noV*sqrt(noL*noL*(1.0-alpha2)+alpha2));
 let fresnel=0.04+0.96*pow(1.0-loH,5.0);
 var specular=3.141592654*distribution*visibility*fresnel*noL*coherence*coherence;
 if(standAperture>=0. && fresnel>.12) {
  // An unresolved stand contains many independently oriented wax surfaces.
  // Compress the coherent direct glint toward the cosine-weighted hemispherical
  // Schlick response F0+(1-F0)/21, scaled by its measured open aperture.
  let tail=max(0.,specular-.04*standAperture);
  let headroom=(.96/21.)*standAperture;
  specular-=smoothstep(.12,.16,fresnel)*tail*tail/max(1.e-7,headroom+tail);
 }
 return (diffuse+vec3<f32>(specular))*sunlightOverPi(sun);
}
fn surfaceDirect(albedo:vec3<f32>,normal:vec3<f32>,view:vec3<f32>,sun:vec3<f32>,roughness:f32,transmission:f32,normalCoherence:f32)->vec3<f32> {
 return surfaceDirectFiltered(albedo,normal,view,sun,roughness,transmission,normalCoherence,-1.);
}
`;

export const surfaceLightGLSL = /* glsl */`
vec3 sunlightOverPi(vec3 sun) {
 float opticalMass=1./max(.08,sun.y)-1./.741980412;
 return vec3(1.39009419,1.40065419,1.27155350)*exp(-vec3(.15,.23,.42)*opticalMass);
}
uniform sampler2D uSurfaceDFG;
float ggxDirectionalReflectance(float noV,float roughness) {
 vec2 grid=vec2(clamp(noV,0.,1.)*31.,clamp((roughness-.42)/.58,0.,1.)*15.);
 return textureLod(uSurfaceDFG,(grid+.5)/vec2(32.,16.),0.).r;
}
vec3 surfaceEnvironment(vec3 reflectedSky,float noV,float roughness) {
 return reflectedSky*ggxDirectionalReflectance(noV,roughness);
}
vec3 surfaceDiffuse(vec3 albedo,vec3 frontSky,vec3 backSky,float transmission,float noV,float roughness) {
 float nonSpecular=1.-ggxDirectionalReflectance(noV,roughness);
 vec3 reflected=clamp(albedo,vec3(0.),vec3(.95));
 vec3 transmitted=min(vec3(.95)-reflected,reflected*transmission);
 return nonSpecular*(reflected*frontSky+transmitted*backSky);
}
vec3 surfaceDirectFiltered(vec3 albedo,vec3 normal,vec3 view,vec3 sun,float roughness,float transmission,float normalCoherence,float standAperture) {
 float coherence=clamp(normalCoherence,0.,1.);
 float noV=max(.001,dot(normal,view)),noL=max(0.,dot(normal,sun)),backL=max(0.,dot(-normal,sun));
 float forwardDiffuse=mix(.25,noL,coherence),backDiffuse=mix(.25,backL,coherence);
 float diffuseBudget=1.-ggxDirectionalReflectance(noV,roughness);
 vec3 reflected=clamp(albedo,vec3(0.),vec3(.95));
 vec3 transmitted=min(vec3(.95)-reflected,reflected*transmission);
 vec3 diffuse=(reflected*forwardDiffuse+transmitted*backDiffuse)*diffuseBudget;
 vec3 halfDirection=normalize(view+sun+vec3(.000001));
 float noH=max(0.,dot(normal,halfDirection)),loH=max(0.,dot(sun,halfDirection));
 float perceptualRoughness=clamp(sqrt(roughness*roughness+(1.-coherence)*.45),.42,1.);
 float alpha=perceptualRoughness*perceptualRoughness,alpha2=alpha*alpha;
 float denominator=1.+noH*noH*(alpha2-1.);
 float distribution=alpha2/(3.141592654*denominator*denominator);
 float visibility=.5/max(.00001,noL*sqrt(noV*noV*(1.-alpha2)+alpha2)+noV*sqrt(noL*noL*(1.-alpha2)+alpha2));
 float fresnel=.04+.96*pow(1.-loH,5.);
 float specular=3.141592654*distribution*visibility*fresnel*noL*coherence*coherence;
 if(standAperture>=0. && fresnel>.12) {
  float tail=max(0.,specular-.04*standAperture);
  float headroom=(.96/21.)*standAperture;
  specular-=smoothstep(.12,.16,fresnel)*tail*tail/max(.0000001,headroom+tail);
 }
 return (diffuse+vec3(specular))*sunlightOverPi(sun);
}
vec3 surfaceDirect(vec3 albedo,vec3 normal,vec3 view,vec3 sun,float roughness,float transmission,float normalCoherence) {
 return surfaceDirectFiltered(albedo,normal,view,sun,roughness,transmission,normalCoherence,-1.);
}
`;
