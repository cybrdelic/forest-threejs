// RG and A are the signed-horizontal and upward components of the filtered
// stand normal. B measures the cosine-weighted visible sky at the crown top.
const width = 512;
async function levels() {
  const response = await fetch(new URL('./assets/stand-relief.bin', import.meta.url));
  if (!response.ok) throw new Error('Unable to load distant crown relief.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const result = [];
  let offset = 0;
  for (let side = width; side >= 1; side >>= 1) {
    const count = side * side * 4;
    result.push({side, data: bytes.subarray(offset, offset + count)});
    offset += count;
  }
  if (bytes.length !== offset) throw new Error('Incomplete crown relief.');
  return result;
}
export async function gpuStandRelief(device) {
  const chain = await levels();
  const texture = device.createTexture({label:'Filtered crown relief', size:[width,width],
    format:'rgba8unorm', mipLevelCount:chain.length,
    usage:GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  chain.forEach(({side,data}, mipLevel) => device.queue.writeTexture({texture,mipLevel}, data, {bytesPerRow:side*4}, [side,side]));
  return texture;
}
export async function glStandRelief(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  (await levels()).forEach(({side,data}, level) => gl.texImage2D(gl.TEXTURE_2D,level,gl.RGBA8,side,side,0,gl.RGBA,gl.UNSIGNED_BYTE,data));
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  return texture;
}
// The smooth warp decorrelates the patch from the terrain grid. Transform its
// slope by the transpose Jacobian and its screen gradients by the Jacobian.
export const reliefWGSL = `
@group(2) @binding(12) var standRelief:texture_2d<f32>;
fn crownRelief(normal:vec3<f32>,world:vec2<f32>,dx:vec2<f32>,dy:vec2<f32>,scale:f32)->vec4<f32> {
 let rate=vec2<f32>(.0029,.0036);let amplitude=vec2<f32>(57.,43.);
 let warp=amplitude*sin(world.yx*rate);let jac=amplitude*rate*cos(world.yx*rate);
 let uv=(world+warp)*scale;
 let field=textureSampleGrad(standRelief,materialSampler,uv,(dx+jac*dx.yx)*scale,(dy+jac*dy.yx)*scale);
 let slope=(2.*field.rg-1.)/max(.35,field.a);
 let adjusted=slope+jac.yx*slope.yx;
 let base=normal/max(.35,normal.y);
 return vec4<f32>(normalize(base+vec3<f32>(adjusted.x,0.,adjusted.y)),field.b);
}`;
export const reliefGLSL = `
uniform sampler2D uStandRelief;
vec4 crownRelief(vec3 normal,vec2 world,vec2 dx,vec2 dy,float scale) {
 vec2 rate=vec2(.0029,.0036),amp=vec2(57.,43.);
 vec2 warp=amp*sin(world.yx*rate),jac=amp*rate*cos(world.yx*rate);
 vec4 field=textureGrad(uStandRelief,(world+warp)*scale,(dx+jac*dx.yx)*scale,(dy+jac*dy.yx)*scale);
 vec2 slope=(2.*field.rg-1.)/max(.35,field.a);
 vec2 adjusted=slope+jac.yx*slope.yx;
 vec3 base=normal/max(.35,normal.y);
 return vec4(normalize(base+vec3(adjusted.x,0.,adjusted.y)),field.b);
}`;
