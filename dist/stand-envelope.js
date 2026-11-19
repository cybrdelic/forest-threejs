// The terrain and the positioned crowns share a metric height field. At four
// metres per texel the map resolves inter-tree shelter well beyond the detailed
// shadow map. The source-density volume still resolves each tree's own leaves.
const SIZE = 1024;
const WORLD_WIDTH = 4000;
const SPACING = WORLD_WIDTH / SIZE;
const HALF = WORLD_WIDTH / 2;
const devices = new WeakMap();
const contexts = new WeakMap();
let population = null, surfaceHeight = null, cachedPixels = null;

export function setStandPopulation(instances, sampleGround) {
  population = instances;
  surfaceHeight = sampleGround;
  cachedPixels = null;
}

export function getStandEnvelope() {
  if (cachedPixels) return cachedPixels;
  const cells = SIZE * SIZE;
  const surface = new Float32Array(cells);
  const thickness = new Float32Array(cells);
  for (let iz = 0, i = 0; iz < SIZE; iz++) {
    const z = (iz + 0.5) * SPACING - HALF;
    for (let ix = 0; ix < SIZE; ix++, i++) {
      surface[i] = surfaceHeight ? surfaceHeight((ix + 0.5) * SPACING - HALF, z) : 0;
    }
  }

  const ground = surface.slice();
  for (let tree = 0; population && tree < population.length / 8; tree++) {
    const i = tree * 8;
    const jacaranda = tree % 5 < 2;
    const scale = population[i + 3], yaw = population[i + 4];
    const horizontal = scale * (0.78 + population[i + 6] * 0.48);
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    // Ellipsoids follow the measured source leaf bounds including the offset
    // from each trunk. The horizontal inset follows the occupied crown rather
    // than isolated outside leaf tips in the source AABB.
    const ox = (jacaranda ? -0.712 : 0.523) * horizontal;
    const oz = (jacaranda ? -0.377 : 2.673) * horizontal;
    const cx = population[i] + ox * cs + oz * sn;
    const cz = population[i + 2] - ox * sn + oz * cs;
    const cy = population[i + 1] + (jacaranda ? 10.859 : 10.569) * scale;
    const ry = (jacaranda ? 8.610 : 5.380) * scale;
    const rx = (jacaranda ? 11.1 : 4.8) * horizontal;
    const rz = (jacaranda ? 8.8 : 6.95) * horizontal;
    const reach = Math.max(rx, rz);
    const ix0 = Math.max(0, Math.ceil((cx - reach + HALF) / SPACING - 0.5));
    const ix1 = Math.min(SIZE - 1, Math.floor((cx + reach + HALF) / SPACING - 0.5));
    const iz0 = Math.max(0, Math.ceil((cz - reach + HALF) / SPACING - 0.5));
    const iz1 = Math.min(SIZE - 1, Math.floor((cz + reach + HALF) / SPACING - 0.5));
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = (iz + 0.5) * SPACING - HALF - cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix + 0.5) * SPACING - HALF - cx;
        const lx = (dx * cs - dz * sn) / rx;
        const lz = (dx * sn + dz * cs) / rz;
        const section = 1 - lx * lx - lz * lz;
        if (section <= 0) continue;
        const halfDepth = ry * Math.sqrt(section);
        const top = cy + halfDepth, cell = iz * SIZE + ix;
        if (top <= surface[cell]) continue;
        surface[cell] = top;
        thickness[cell] = 2 * halfDepth;
      }
    }
  }
  const rgba = new Uint8Array(cells * 4);
  for (let i = 0; i < cells; i++) {
    const packed = Math.max(0, Math.min(65535, Math.round((surface[i] + 100) * 64)));
    rgba[i * 4] = packed >> 8;
    rgba[i * 4 + 1] = packed & 255;
    rgba[i * 4 + 2] = Math.min(255, Math.round(thickness[i] * 6));
    rgba[i * 4 + 3] = Math.min(255, Math.round((surface[i] - ground[i]) * 3));
  }
  cachedPixels = { size: SIZE, bytes: rgba };
  return cachedPixels;
}

export function getGPUStandTexture(device) {
  let cache = devices.get(device);
  if (!cache) {
    const texture = device.createTexture({ label: 'Terrain and stand crown heights',
      size: [SIZE, SIZE], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    cache = { texture, source: null };
    devices.set(device, cache);
  }
  const source = getStandEnvelope();
  if (source !== cache.source) {
    device.queue.writeTexture({ texture: cache.texture }, source.bytes, { bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
    cache.source = source;
  }
  return cache.texture;
}

export function getGLStandTexture(gl) {
  let cache = contexts.get(gl);
  if (!cache) {
    cache = { texture: gl.createTexture(), source: null };
    contexts.set(gl, cache);
    gl.bindTexture(gl.TEXTURE_2D, cache.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, cache.texture);
  }
  const source = getStandEnvelope();
  if (source !== cache.source) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.bytes);
    cache.source = source;
  }
  return cache.texture;
}

// RG gives the linearly interpolable surface height. B is crown thickness;
// A is canopy top to real terrain. A low ray can pass underneath a crown.
export const standLightingWGSL = /* wgsl */ `
fn readStand(p:vec2<f32>)->vec3<f32>{
 let uv=p/4000.0+0.5;
 let data=textureSampleLevel(standEnvelope,standSampler,clamp(uv,vec2<f32>(0.0),vec2<f32>(1.0)),0.0);
 let inside=all(uv>=vec2<f32>(0.0))&&all(uv<=vec2<f32>(1.0));
 return select(vec3<f32>(-10000.0,0.0,0.0),vec3<f32>(dot(data.rg,vec2<f32>(1020.0,3.984375))-100.0,data.b*42.5,data.a*85.),inside);
}
fn standSunVisibility(world:vec3<f32>,sun:vec3<f32>,skipMetres:f32)->f32{
 let spans=array<f32,8>(2.5,5.0,8.5,13.5,20.0,31.0,50.0,87.0);
 var blocked=0.0;
 for(var i=0;i<8;i++) {
  let ray=world+sun*(skipMetres+spans[i]);
  let stand=readStand(ray.xz);let penetration=stand.x-ray.y;
  let coverage=1.0-exp(-0.27*stand.y);
  let crown=smoothstep(-0.6,3.8,penetration)*(1.0-smoothstep(stand.y,stand.y+1.5,penetration))*coverage;
  let ground=smoothstep(0.5,4.0,penetration-stand.z);
  blocked=max(blocked,max(crown,ground));
 }
 return 1.0-0.93*blocked;
}
fn standSkyVisibility(world:vec3<f32>)->f32{
 let directions=array<vec2<f32>,4>(vec2<f32>(.92,.38),vec2<f32>(-.38,.92),vec2<f32>(-.92,-.38),vec2<f32>(.38,-.92));
 var visible=0.0;
 for(var i=0;i<4;i++){
  let near=readStand(world.xz+directions[i]*11.0);
  let far=readStand(world.xz+directions[i]*27.0);
  let slope=max(0.0,max((near.x-world.y)/11.0,(far.x-world.y)/27.0));
  visible+=1.0/(1.0+slope*slope);
 }
 return visible*0.25;
}`;

export const standLightingGLSL = /* glsl */ `
vec3 readStand(vec2 p){
 vec2 uv=p/4000.+.5;vec4 data=textureLod(standEnvelope,clamp(uv,vec2(0.),vec2(1.)),0.);
 if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))return vec3(-10000.,0.,0.);
 return vec3(dot(data.rg,vec2(1020.,3.984375))-100.,data.b*42.5,data.a*85.);
}
float standSunVisibility(vec3 world,vec3 sun,float skipMetres){
 const float spans[8]=float[](2.5,5.,8.5,13.5,20.,31.,50.,87.);
 float blocked=0.;
 for(int i=0;i<8;i++){
  vec3 ray=world+sun*(skipMetres+spans[i]);vec3 stand=readStand(ray.xz);float penetration=stand.x-ray.y;
  float coverage=1.-exp(-.27*stand.y);
  float crown=smoothstep(-.6,3.8,penetration)*(1.-smoothstep(stand.y,stand.y+1.5,penetration))*coverage;
  float ground=smoothstep(.5,4.,penetration-stand.z);
  blocked=max(blocked,max(crown,ground));
 }
 return 1.-.93*blocked;
}
float standSkyVisibility(vec3 world){
 const vec2 directions[4]=vec2[](vec2(.92,.38),vec2(-.38,.92),vec2(-.92,-.38),vec2(.38,-.92));
 float visible=0.;
 for(int i=0;i<4;i++){
  vec3 a=readStand(world.xz+directions[i]*11.),b=readStand(world.xz+directions[i]*27.);
  float slope=max(0.,max((a.x-world.y)/11.,(b.x-world.y)/27.));visible+=1./(1.+slope*slope);
 }
 return visible*.25;
}`;
