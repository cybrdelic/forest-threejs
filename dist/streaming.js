import { createGrassInstances, meadowAmount, terrainHeight } from './landscape.js';

const VOXEL_SIZE = 8;
const VOLUME_SIZE = 64;
const VOLUME_ANCHOR = 64;

/** CPU work shared by the module worker and the native validation runtime. */
export function buildStreamingData({ camera, treeData, grassCenter, grassCount = 180000, force = false }) {
  const origin = [
    Math.floor(camera[0] / VOLUME_ANCHOR) * VOLUME_ANCHOR - 256,
    0,
    Math.floor(camera[2] / VOLUME_ANCHOR) * VOLUME_ANCHOR - 256,
  ];
  const voxels = new Uint8Array(VOLUME_SIZE ** 3 * 4);
  function put(x, y, z, red, green, blue, opacity) {
    if (x < 0 || y < 0 || z < 0 || x >= VOLUME_SIZE || y >= VOLUME_SIZE || z >= VOLUME_SIZE) return;
    const offset = ((z * VOLUME_SIZE + y) * VOLUME_SIZE + x) * 4;
    // A foliage voxel cannot replace the material of solid ground below it.
    if (voxels[offset + 3] > opacity) return;
    voxels[offset] = red;
    voxels[offset + 1] = green;
    voxels[offset + 2] = blue;
    voxels[offset + 3] = opacity;
  }

  // One border cell supplies centered terrain derivatives for all 64²
  // surface voxels, including the edges of the moving injection domain.
  const stride=VOLUME_SIZE+2,heights=new Float32Array(stride*stride);
  for(let z=-1;z<=VOLUME_SIZE;z++)for(let x=-1;x<=VOLUME_SIZE;x++) {
    heights[(z+1)*stride+x+1]=terrainHeight(origin[0]+(x+.5)*VOXEL_SIZE,origin[2]+(z+.5)*VOXEL_SIZE);
  }
  for(let z=0;z<VOLUME_SIZE;z++)for(let x=0;x<VOLUME_SIZE;x++) {
    const i=(z+1)*stride+x+1,top=Math.floor(heights[i]/VOXEL_SIZE);
    const nx=(heights[i-1]-heights[i+1])/(2*VOXEL_SIZE),nz=(heights[i-stride]-heights[i+stride])/(2*VOXEL_SIZE);
    const length=Math.hypot(nx,1,nz),coverage=meadowAmount(origin[0]+(x+.5)*VOXEL_SIZE,origin[2]+(z+.5)*VOXEL_SIZE);
    put(x,top,z,Math.round((nx/length*.5+.5)*255),Math.round((nz/length*.5+.5)*255),Math.round(coverage*255),230);
    put(x,top-1,z,0,0,0,255);
  }

  const canopyOffsets = [];
  for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const distance = Math.hypot(x, y * 0.9, z);
        if (distance <= 1.55) canopyOffsets.push([x, y, z, Math.round((1 - distance / 2) * 170)]);
      }
    }
  }
  for (let index = 0; index < treeData.length; index += 8) {
    const x = (treeData[index] - origin[0]) / VOXEL_SIZE;
    const z = (treeData[index + 2] - origin[2]) / VOXEL_SIZE;
    if (x < -1 || z < -1 || x >= VOLUME_SIZE + 1 || z >= VOLUME_SIZE + 1) continue;
    const centerY = (treeData[index + 1] + 11 * treeData[index + 3]) / VOXEL_SIZE;
    // Linear, coverage-weighted albedo of the same two source leaf atlases.
    const compound=(index/8)%5<2;
    for (const [dx, dy, dz, opacity] of canopyOffsets) {
      put(Math.floor(x+dx),Math.floor(centerY+dy),Math.floor(z+dz),compound?48:32,compound?53:46,compound?14:13,opacity);
    }
  }

  let grass = null;
  let nextGrassCenter = grassCenter ? [...grassCenter] : null;
  if (force || !grassCenter || Math.hypot(camera[0] - grassCenter[0], camera[2] - grassCenter[1]) > 7) {
    nextGrassCenter = [Math.floor(camera[0] / 3.2) * 3.2, Math.floor(camera[2] / 3.2) * 3.2];
    grass = createGrassInstances(grassCount, nextGrassCenter[0], nextGrassCenter[1]);
  }
  return { origin, voxels, grass, grassCenter: nextGrassCenter };
}
