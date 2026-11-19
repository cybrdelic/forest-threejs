// Reconstruct the footprint of the photographed cloud layer on the landscape.
// The projected layer is fixed in world space. Moving the eye never drags a
// cloud shadow across a tree. Both backends use the sky capture's orientation.
import { SOURCE_SUN } from './sky-orientation.js';

const sourceAzimuth = Math.atan2(SOURCE_SUN[2], SOURCE_SUN[0]).toFixed(9);
const maskWidth = 512;
const maskHeight = 128;

async function readCloudMask() {
  const response = await fetch(new URL('./assets/cloud-transmittance.bin', import.meta.url));
  if (!response.ok) throw new Error('Unable to load cloud transmittance.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== maskWidth * maskHeight) throw new Error('Invalid cloud transmittance map.');
  return bytes;
}

export async function gpuCloudMask(device) {
  const bytes = await readCloudMask();
  const texture = device.createTexture({
    label: 'Photographic cloud transmittance', size: [maskWidth, maskHeight], format: 'r8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
  });
  device.queue.writeTexture({texture}, bytes, {bytesPerRow: maskWidth}, [maskWidth, maskHeight]);
  return texture;
}
export async function glCloudMask(gl) {
  const bytes = await readCloudMask();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskWidth, maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

// Photographic sky has a measured azimuth. Project from this fixed capture
// station to a single cloud base. RGB radiance only estimates optical depth.
export const cloudLightWGSL = `
@group(2) @binding(7) var cloudCover:texture_2d<f32>;
fn cloudSunVisibility(world:vec3<f32>,sun:vec3<f32>)->f32 {
 if(u.settings.z>0.5) { return 1.0; }
 let station=vec3<f32>(-170.0,245.0,210.0);
 let layerHeight=1330.0;
 let hit=world+sun*(max(0.0,layerHeight-world.y)/max(0.13,sun.y))-station;
 let azimuth=atan2(hit.z,hit.x)+${sourceAzimuth}-atan2(sun.z,sun.x);
 let uv=vec2<f32>(fract(azimuth/6.283185307+0.5),acos(clamp(normalize(hit).y,0.0,1.0))*0.636619772);
 return textureSampleLevel(cloudCover,CLOUD_SAMPLER,uv,0).r;
}`;
export const cloudLightGLSL = `
uniform sampler2D uCloudCover;
uniform bool uUsePhotoCloud;
float cloudSunVisibility(vec3 world,vec3 sun) {
 if(!uUsePhotoCloud) return 1.;
 vec3 station=vec3(-170.,245.,210.);
 float layerHeight=1330.;
 vec3 hit=world+sun*(max(0.,layerHeight-world.y)/max(.13,sun.y))-station;
 float azimuth=atan(hit.z,hit.x)+${sourceAzimuth}-atan(sun.z,sun.x);
 vec2 uv=vec2(fract(azimuth/6.283185307+.5),acos(clamp(normalize(hit).y,0.,1.))*.636619772);
 return textureLod(uCloudCover,uv,0.).r;
}`;

// Directional horizon radiance measured from the clear parts of the source HDR.
// Five Fourier terms preserve the warm/cool azimuthal variation through a full turn.
const horizonFit = [
 [0.384928,0.454970,0.606988], [0.145524,0.203588,0.282880],
 [0.112487,0.135604,0.163107], [0.023729,0.038841,0.065913],
 [0.094253,0.112768,0.145548]
];
function horizonRadiance(vector) {
 const [dc,cos1,sin1,cos2,sin2] = horizonFit.map(rgb => vector+'('+rgb.join(',')+')');
 return dc+'+'+cos1+'*az.x+'+sin1+'*az.y+'+cos2+'*(az.x*az.x-az.y*az.y)+'+sin2+'*(2.0*az.x*az.y)';
}

// The green aerosol coefficient corresponds to about 36 km of meteorological
// visibility at the valley datum. This daylight preset leaves relief readable
// through multiple wooded ridges. Integrate along the view segment. The
// mountain ridges retain a longer scattering path than the open pasture.
export const aerialWGSL = `
fn aerialPerspective(radiance:vec3<f32>,world:vec3<f32>,eye:vec3<f32>,sun:vec3<f32>)->vec3<f32> {
 let ray=world-eye;
 let distance=length(ray);
 let altitude=max(0.0,(world.y+eye.y)*0.5-155.0);
 // The meadow overlooks an open pocket of clearer air. Intersect the
 // view segment with that pocket so the pasture stays legible while the
 // succession of more distant ridges picks up valley haze.
 let offset=eye-vec3<f32>(0.0,210.0,-140.0);
 let along=-dot(offset,ray/max(distance,0.01));
 let span=sqrt(max(0.0,1320.0*1320.0-dot(offset,offset)+along*along));
 let clearDistance=max(0.0,min(distance,along+span)-max(0.0,along-span));
 let aerosol=vec3<f32>(0.000087,0.000108,0.000140)*exp(-altitude/1100.0);
 let molecular=vec3<f32>(0.000006,0.000013,0.000030)*exp(-altitude/7800.0);
 let through=exp(-distance*molecular-(distance-0.955*clearDistance)*aerosol);
 let direction=ray.xz/max(length(ray.xz),0.001);
 let rotation=${sourceAzimuth}-atan2(sun.z,sun.x);
 let az=vec2<f32>(direction.x*cos(rotation)-direction.y*sin(rotation),direction.x*sin(rotation)+direction.y*cos(rotation));
 let horizon=${horizonRadiance('vec3<f32>')};
 let day=smoothstep(0.03,0.56,sun.y);
 let air=horizon*mix(vec3<f32>(0.66,0.54,0.51),vec3<f32>(1.0),day);
 return radiance*through+air*(vec3<f32>(1.0)-through);
}`;
export const aerialGLSL = `
vec3 aerialPerspective(vec3 radiance,vec3 world,vec3 eye,vec3 sun) {
 vec3 ray=world-eye;
 float d=length(ray);
 float altitude=max(0.,(world.y+eye.y)*.5-155.);
 vec3 offset=eye-vec3(0.,210.,-140.);
 float along=-dot(offset,ray/max(d,.01));
 float span=sqrt(max(0.,1320.*1320.-dot(offset,offset)+along*along));
 float clearDistance=max(0.,min(d,along+span)-max(0.,along-span));
 vec3 aerosol=vec3(.000087,.000108,.000140)*exp(-altitude/1100.);
 vec3 molecular=vec3(.000006,.000013,.000030)*exp(-altitude/7800.);
 vec3 through=exp(-d*molecular-(d-.955*clearDistance)*aerosol);
 vec2 direction=ray.xz/max(length(ray.xz),.001);
 float rotation=${sourceAzimuth}-atan(sun.z,sun.x);
 vec2 az=vec2(direction.x*cos(rotation)-direction.y*sin(rotation),direction.x*sin(rotation)+direction.y*cos(rotation));
 vec3 horizon=${horizonRadiance('vec3')};
 vec3 air=horizon*mix(vec3(.66,.54,.51),vec3(1.),smoothstep(.03,.56,sun.y));
 return radiance*through+air*(1.-through);
}`;
