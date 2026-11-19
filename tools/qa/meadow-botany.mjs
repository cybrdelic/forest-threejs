// Verifies that the vegetation banks can move without remixing a meadow,
// that lodgement retains a valid orientation, and that the herb shadow
// budget and culling bound cover the default camera's complete caster disk.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createGrassInstances, terrainSurfaceHeight} from '../../dist/landscape.js';
import {loadMeadowGeometry, closeMeadow} from '../../dist/meadow.js';
import {meadowSoilGap} from '../../dist/meadow-gaps.js';

globalThis.forestGeometryBytes={};
for(const family of ['bermuda','grass'])for(const attribute of ['vertices','indices']) {
  const filename=family+'-'+attribute+'.bin';
  const url=new URL('../../dist/assets/meadow/'+filename,import.meta.url);
  globalThis.forestGeometryBytes['meadow/'+filename]=await fs.readFile(url);
}
const upper=await loadMeadowGeometry(),turf=closeMeadow();
for(const mesh of [turf,...upper,...upper.map(model=>model.far)]) {
  assert(mesh.vertices.length%12===0);
  assert(mesh.vertices.every(Number.isFinite));
  assert(mesh.indices.every(index=>index<mesh.vertices.length/12));
  for(let i=0;i<mesh.vertices.length;i+=12) {
    assert(Math.abs(Math.hypot(...mesh.vertices.subarray(i+3,i+6))-1)<.0001);
  }
}
function overlappingRoots(spacing) {
  const first=createGrassInstances(10000,-170,210,spacing);
  const second=createGrassInstances(10000,-170+spacing*12,210+spacing*8,spacing);
  const byRoot=new Map();
  const key=(data,i)=>data[i]+','+data[i+2];
  for(let i=0;i<first.length;i+=8)byRoot.set(key(first,i),i);
  let checked=0;
  for(let i=0;i<second.length;i+=8) {
    const old=byRoot.get(key(second,i));
    if(old===undefined)continue;
    assert.deepEqual(second.subarray(i,i+8),first.subarray(old,old+8));
    checked++;
  }
  assert(checked>=7000);
  return checked;
}
const data=createGrassInstances(180000,-170,210,.4);
const communities=[0,0,0,0],shadowCommunities=[0,0,0,0];
let empty=0,lodged=0,casters=0,maximumGroundError=0;
for(let i=0;i<data.length;i+=8) {
  const [x,y,z,scale,packedYaw,,,phenotype]=data.subarray(i,i+8);
  const group=Math.floor(phenotype*4);
  const lodge=Math.floor(packedYaw/8);
  assert(group>=0&&group<4&&lodge>=0&&lodge<=15&&packedYaw%8<2*Math.PI);
  communities[group]++;
  if(scale===0)empty++;
  if(lodge>=8)lodged++;
  if(scale>0&&(x+170)**2+(z-210)**2<144) {
    shadowCommunities[group]++;
    casters++;
  }
  if(i%88===0)maximumGroundError=Math.max(maximumGroundError,Math.abs(y-terrainSurfaceHeight(x,z)));
}
assert(casters>0&&casters<4096&&maximumGroundError<.0001);
assert(empty>0&&lodged>0);
assert(communities.every(count=>count>0));
const herbTriangles=upper.map(mesh=>mesh.indices.length/3);
const shadowTriangles=shadowCommunities.reduce((sum,n,i)=>sum+n*herbTriangles[i],casters*turf.indices.length/3);
let fieldSamples=0,fieldArea=0;
for(let z=-75;z<75;z+=.31)for(let x=-150;x<150;x+=.29) {
  const gap=meadowSoilGap(x,z);
  assert(gap>=0&&gap<=1);fieldArea+=gap;fieldSamples++;
}
const meanGap=fieldArea/fieldSamples;
assert(Math.abs(meanGap-.023)<.005,'Filtered soil field must converge to the sampled area fraction');
console.log(JSON.stringify({communities,empty,lodged,casters,turfTriangles:turf.indices.length/3,herbTriangles,
  shadowTriangles,meanGap,maximumGroundError,overlap:{near:overlappingRoots(.4),far:overlappingRoots(1.6)}}));
