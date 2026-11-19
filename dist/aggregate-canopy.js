// Static geometry in the outer forest measures the elevation of its horizon
// in eight azimuths. Both packed integers fit exactly in a float32 vertex
// attribute. Runtime shading can then follow a moving sun on those ridges.
const directions = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
const ranges = [1, 2, 4, 8, 16];

export function packCanopyHorizon(axis, heights, indices, ix, iz, crownHeight) {
  const side = axis.length, y = heights[iz * side + ix];
  let first = 0, second = 0, sky = 0;
  for (let i = 0; i < directions.length; i++) {
    const [dx, dz] = directions[i];
    let slope = 0;
    for (const stride of ranges) {
      const jx = ix + stride * dx, jz = iz + stride * dz;
      if (jx < 0 || jz < 0 || jx >= side || jz >= side) break;
      const sample = jz * side + jx;
      if (indices[sample] < 0) continue;
      const rise = heights[sample] - y;
      if (rise <= 0) continue;
      const runX = axis[jx] - axis[ix], runZ = axis[jz] - axis[iz];
      slope = Math.max(slope, rise / Math.sqrt(runX * runX + runZ * runZ));
    }
    const elevation = Math.min(31, Math.round(Math.atan(slope) * 62 / Math.PI));
    const term = elevation << ((i & 3) * 5);
    if (i < 4) first |= term;
    else second |= term;
    sky += 1 / (1 + slope * slope);
  }
  const top = Math.min(1, crownHeight / 17);
  first |= Math.round(15 * (sky / 8) * (0.47 + 0.47 * top)) << 20;
  second |= Math.round(15 * (0.24 + 0.48 * top)) << 20;
  return [first, second];
}

export const outerLightWGSL = /* wgsl */`
fn horizonSector(bits:vec2<u32>,index:u32)->f32 {
 let word=select(bits.x,bits.y,(index&7u)>=4u);
 return f32((word>>((index&3u)*5u))&31u)*0.050670849;
}
fn outerCanopyLight(values:vec2<f32>,sun:vec3<f32>)->vec2<f32> {
 let bits=vec2<u32>(values);
 let angle=fract(atan2(sun.z,sun.x)*0.159154943+1.)*8.;let sector=u32(angle);
 let horizon=mix(horizonSector(bits,sector),horizonSector(bits,sector+1u),fract(angle));
 let visible=smoothstep(horizon-.085,horizon+.085,asin(clamp(sun.y,-1.,1.)));
 return vec2<f32>(f32(bits.x>>20u),f32(bits.y>>20u)*visible)/15.;
}`;
export const outerLightGLSL = /* glsl */`
float horizonSector(uvec2 bits,uint index) {
 uint word=(index&7u)>=4u?bits.y:bits.x;
 return float((word>>((index&3u)*5u))&31u)*.050670849;
}
vec2 outerCanopyLight(vec2 values,vec3 sun) {
 uvec2 bits=uvec2(values);
 float angle=fract(atan(sun.z,sun.x)*.159154943+1.)*8.;uint sector=uint(angle);
 float horizon=mix(horizonSector(bits,sector),horizonSector(bits,sector+1u),fract(angle));
 float visible=smoothstep(horizon-.085,horizon+.085,asin(clamp(sun.y,-1.,1.)));
 return vec2(float(bits.x>>20),float(bits.y>>20)*visible)/15.;
}`;
