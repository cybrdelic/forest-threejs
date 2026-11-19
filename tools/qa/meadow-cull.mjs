import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createGrassInstances,terrainSurfaceHeight} from '../../dist/landscape.js';
import {loadMeadowGeometry,closeMeadow} from '../../dist/meadow.js';
import {makeMeadowBank,meadowEnvelope,meadowPlanes,visitMeadow} from '../../dist/meadow-cull.js';
import {multiply,lookAt,perspective} from '../../dist/math.js';

globalThis.forestGeometryBytes={};
for(const plant of ['bermuda','grass'])for(const part of ['vertices','indices']){
  const file=plant+'-'+part+'.bin';
  globalThis.forestGeometryBytes['meadow/'+file]=await fs.readFile(new URL('../../dist/assets/meadow/'+file,import.meta.url));
}
const models=await loadMeadowGeometry();
const banks=[false,true].map(far=>{
  const envelope=meadowEnvelope(far?models.map(m=>m.far):[...models,closeMeadow()],far);
  return makeMeadowBank(createGrassInstances(far?65536:180000,-170,210,far?1.6:.4),envelope);
});
const poses=[[.23,-.1,1.19,1.85],[1.4,-1.34,.46,4],[3.14,.61,2.22,1.1],[4.30,-.8,1.6,19]];
const result=[];
for(const [yaw,pitch,aspect,clearance] of poses) {
  const eye=[-170,terrainSurfaceHeight(-170,210)+clearance,210];
  const dir=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)];
  const p=perspective(50*Math.PI/180,aspect,.15,14000);
  for(let c=0;c<4;c++)p[4*c+2]=2*p[4*c+2]-p[4*c+3];
  const matrix=multiply(p,lookAt(eye,eye.map((v,i)=>v+dir[i])));
  const planes=new Float64Array(24);meadowPlanes(matrix,planes);
  for(const bank of banks){
    const {envelope:e,data}=bank,seen=[],casters=[];
    const tested=visitMeadow(bank,eye,planes,i=>seen.push(i),i=>casters.push(i));
    const brute=[],allCasters=[];
    for(let i=0;i<data.length;i+=8) {
      if(data[i+3]<=0)continue;
      const dx=data[i]-eye[0],dz=data[i+2]-eye[2],d=dx*dx+dz*dz;
      if(!e.far&&d<144)allCasters.push(i);
      if(d>(e.far?170:70)**2||(e.far&&d<1600))continue;
      const r=e.radius*data[i+3]+e.wind;
      const slope=r*(Math.abs(data[i+5])+Math.abs(data[i+6]-(e.far?4:0)));
      const lo=[data[i]-r,data[i+1]-slope,data[i+2]-r],hi=[data[i]+r,data[i+1]+e.height*data[i+3]+slope,data[i+2]+r];
      let hit=true;
      // Independent positive-vertex box vs. the six actual clip planes.
      for(let k=0;k<6;k++) {
        const o=k*4;
        const maxDistance=planes[o+3]+[0,1,2].reduce((s,j)=>s+planes[o+j]*(planes[o+j]>=0?hi[j]:lo[j]),0);
        if(maxDistance<0){hit=false;break;}
      }
      if(hit)brute.push(i);
    }
    assert.deepEqual(seen,brute);assert.deepEqual(casters,allCasters);
    assert(tested<data.length/8*.52);
    result.push({yaw,pitch,aspect,bank:e.far?'far':'near',total:data.length/8,tested,visible:seen.length,casters:casters.length});
  }
}
console.log(JSON.stringify(result));
