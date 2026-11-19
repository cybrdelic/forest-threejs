// Extract the solitary pasture tree directly from the current scene. No private
// copy of its placement, terrain height, vertex stream, or index list is used.
import fs from 'node:fs';
import path from 'node:path';
import {createTreeInstances,terrainSurfaceHeight} from '../../dist/landscape.js';
import {decodeTreeVertices} from '../../dist/geometry-assets.js';
const dir=process.argv[2];
if(!dir)throw Error('Pass an output directory');
fs.mkdirSync(dir,{recursive:true});
const instances=createTreeInstances(90000);
let id=-1;
for(let i=0;i<instances.length/8;i++)if(instances[i*8]===13&&instances[i*8+2]===-467){id=i;break;}
if(id<0)throw Error('Solitary pasture tree missing');
const tree=Array.from(instances.subarray(id*8,id*8+8));
const species=id%5<2?'jacaranda':'trees';
const asset=(name)=>fs.readFileSync(new URL('../../dist/assets/'+species+'/'+name,import.meta.url));
const decoded=decodeTreeVertices(asset('near-vertices.bin'));
fs.writeFileSync(path.join(dir,'tree.f32'),Buffer.from(decoded.buffer,decoded.byteOffset,decoded.byteLength));
fs.writeFileSync(path.join(dir,'tree.u32'),asset('near-indices.bin'));
const [x,y,z]=tree;
const views={front:345,back:165,side:255};
const position=[x+16,terrainSurfaceHeight(x+16,z+7)+1.75,z+7];
const target=[x+.6,y+13.5,z+1.3];
// Real local terrain for indirect rays. Camera rays only use the projected
// crown matte. This crop faces up at an isolated tree with open ground below.
const ground=[];
for(let j=-32;j<=32;j++)for(let i=-32;i<=32;i++)ground.push([x+2*i,terrainSurfaceHeight(x+2*i,z+2*j),z+2*j]);
const nearby=[];
for(let i=0;i<instances.length/8;i++)if(i!==id){
 const t=instances.slice(i*8,i*8+8);
 const distance=Math.hypot(x-t[0],z-t[2]);
 if(distance<40)nearby.push({id:i,distance});
}
const scene={id,species,tree,position,target,verticalFov:50,width:256,height:192,sunElevation:48,views,groundSide:65,ground,otherTreesWithin40m:nearby};
fs.writeFileSync(path.join(dir,'scene.json'),JSON.stringify(scene));
console.log(JSON.stringify({...scene,ground:undefined}));
