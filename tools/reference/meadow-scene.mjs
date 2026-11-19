// Export the exact seeded meadow bank around an on-site, downward-facing view.
// Apply actual production vertex transforms in GLES transform feedback afterwards.
import fs from 'node:fs';
import path from 'node:path';
import {loadMeadowGeometry,closeMeadow} from '../../dist/meadow.js';
import {createGrassInstances,terrainSurfaceHeight} from '../../dist/landscape.js';
const dir=process.argv[2];fs.mkdirSync(dir,{recursive:true});
globalThis.fetch=async url=>{const b=fs.readFileSync(url);return {ok:true,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}};
const x=-170,z=207;
const position=[x,terrainSurfaceHeight(x,z)+1.4,z];
const target=[x+.18,terrainSurfaceHeight(x+.18,z-.26)+.12,z-.26];
const roots=createGrassInstances(180000,x,z,.4);
const groups=[[],[],[],[],[]];
for(let i=0;i<roots.length;i+=8) {
 if(Math.hypot(roots[i]-x,roots[i+2]-z)>3.5)continue;
 const k=Math.min(3,Math.floor(roots[i+7]*4));
 const plant=Array.from(roots.subarray(i,i+8));groups[k].push(...plant);groups[4].push(...plant);
}
const models=[...await loadMeadowGeometry(),closeMeadow()];
for(let k=0;k<models.length;k++) {
 const mesh=models[k];const write=(name,data)=>fs.writeFileSync(path.join(dir,k+'-'+name),Buffer.from(data.buffer,data.byteOffset,data.byteLength));
 write('vertices',mesh.vertices);write('indices',mesh.indices);write('roots',Float32Array.from(groups[k]));
}
const ground=[];for(let j=-32;j<=32;j++)for(let i=-32;i<=32;i++)ground.push([x+i*.19,terrainSurfaceHeight(x+i*.19,z+j*.19),z+j*.19]);
const scene={kind:'meadow',position,target,verticalFov:50,width:192,height:144,sunElevation:48,views:{front:345},groundSide:65,ground,roots:groups[4].length/8};
fs.writeFileSync(path.join(dir,'scene.json'),JSON.stringify(scene));console.log('Exported',scene.roots,'live roots');
