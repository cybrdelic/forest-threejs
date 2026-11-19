// Verifies linkage between the field relief, seed bank habitat, visible
// substrate and source measurements. No graphics API is needed for this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mainSwaleX, pastureHabitat, pastureRelief} from '../../dist/pasture-fields.js';
import {createLandscape, terrainSurfaceHeight} from '../../dist/landscape.js';

const linear = x => {
  const s=x/255;
  return s<=.04045 ? s/12.92 : ((s+.055)/1.055)**2.4;
};
const lookup=Array.from({length:256},(_,i)=>linear(i));
const texture=fs.readFileSync(new URL('../../dist/assets/albedo.bin',import.meta.url));
const mask=fs.readFileSync(new URL('../../dist/assets/normal.bin',import.meta.url));
const n=512**2,luminance=c=>.2126*c[0]+.7152*c[1]+.0722*c[2];
function pixels(layer, predicate) {
  const accepted=[];
  for(let i=0;i<n;i++) {
    const o=(layer*n+i)*4;
    const rgb=[lookup[texture[o]],lookup[texture[o+1]],lookup[texture[o+2]]];
    if(predicate(rgb,mask[o+3])) accepted.push(rgb);
  }
  assert.ok(accepted.length);
  return accepted;
}
function mean(data) {
  const sum=[0,0,0];
  for(const c of data) for(let i=0;i<3;i++) sum[i]+=c[i];
  return sum.map(x=>x/data.length);
}
function near(actual, expected, tolerance) {
  assert.ok(actual.every((x,i)=>Math.abs(x-expected[i])<=tolerance),
    JSON.stringify({actual,expected,tolerance}));
}
const turf=mean(pixels(0,()=>true));
const litter=pixels(1,()=>true).sort((a,b)=>luminance(a)-luminance(b));
const soil=mean(litter.slice(0,Math.floor(litter.length/4)));
const mature=[5,6].map(layer=>mean(pixels(layer,(_c,a)=>a>229.5)));
const straw=[5,6].map(layer=>mean(pixels(layer,(c,a)=>a>229.5&&c[0]>1.07*c[1])));
near(turf,[.1341,.2341,.026],.0001);
near(soil,[.0954,.0633,.0308],.0001);
near(mean(mature),[.107,.125,.019],.001);
near(mean(straw),[.1844,.1511,.0317],.001);

const mesh=createLandscape();
let min=Infinity,max=-Infinity,maxTilt=0,samples=0;
for(let z=-810;z<=-370;z+=4)for(let x=-80;x<=450;x+=4) {
  const relief=pastureRelief(x,z);
  const wet=pastureHabitat(x,z);
  assert.ok(wet.every(v=>v>=0 && v<=1 && Number.isFinite(v)));
  const dx=(pastureRelief(x+2,z)-pastureRelief(x-2,z))/4;
  const dz=(pastureRelief(x,z+2)-pastureRelief(x,z-2))/4;
  maxTilt=Math.max(maxTilt, Math.hypot(dx,dz));
  min=Math.min(min,relief);max=Math.max(max,relief);samples++;
}
assert.ok(min < -7 && max > 6 && maxTilt < .55);
const channel=mainSwaleX(-650);
assert.ok(pastureHabitat(channel,-650)[0] > pastureHabitat(channel+53,-650)[0]+.4);
let positionError=0, habitatError=0;
for(let i=0;i<mesh.vertices.length;i+=12*101) {
  const a=mesh.vertices,x=a[i],y=a[i+1],z=a[i+2];
  positionError=Math.max(positionError,Math.abs(terrainSurfaceHeight(x,z)-y));
  const h=pastureHabitat(x,z);
  for(let k=0;k<3;k++) habitatError=Math.max(habitatError,Math.abs(h[k]-a[i+6+k]));
}
assert.ok(positionError<.0003 && habitatError<.00003);
assert.equal(pastureRelief(-170,210),0);
console.log(JSON.stringify({samples,reliefRangeMetres:[min,max],maximumAddedSlope:maxTilt,
  turf,soil,mature:mean(mature),straw:mean(straw),terrainTriangles:mesh.indices.length/3,
  maxGroundHeightErrorMetres:positionError,maxHabitatError:habitatError},null,2));
