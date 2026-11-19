// Near and far models must preserve every leaf-bearing shoot, its UV tile,
// and incident light as the camera crosses the detail threshold.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeHedgerow,selectHedgerow} from '../../dist/hedgerow.js';
import {terrainSurfaceHeight,CAMERA_START} from '../../dist/landscape.js';
import {lookAt,multiply,perspective} from '../../dist/math.js';
import {meadowPlanes} from '../../dist/meadow-cull.js';
const digest=model=>{
 const hash=createHash('sha256');
 for(const array of [model.data,model.near.vertices,model.near.indices,model.far.vertices,model.far.indices]){
  hash.update(Buffer.from(array.buffer,array.byteOffset,array.byteLength));
 }
 return hash.digest('hex');
};
const models=makeHedgerow(),hashes=models.map(digest);
const eye=CAMERA_START.position,planes=new Float64Array(24);
meadowPlanes(multiply(perspective(50*Math.PI/180,16/9,.25,14000),lookAt(eye,CAMERA_START.target)),planes);
const stats=[];
for(const [id,m] of models.entries()) {
 const near=m.near.vertices,far=m.far.vertices,nearStart=near.length/12-6*m.shoots,farStart=far.length/12-4*m.shoots;
 const transmitted=new Set();
 for(const lod of [m.near,m.far]){
  assert.equal(lod.indices.length%3,0);
  for(const i of lod.indices)assert(i<lod.vertices.length/12);
  for(let i=0;i<lod.vertices.length;i+=12){
   assert(Number.isFinite(lod.vertices[i]+lod.vertices[i+1]+lod.vertices[i+2]));
   assert(Math.abs(Math.hypot(lod.vertices[i+3],lod.vertices[i+4],lod.vertices[i+5])-1)<1e-5);
   assert(lod.vertices[i+8]>=255*65536);
  }
 }
 for(let i=0;i<m.shoots;i++) {
  const a=(nearStart+6*i)*12,b=(farStart+4*i)*12;
  transmitted.add(Math.floor(near[a+8]/256)%256);
  for(const [fine,coarse] of [[0,0],[2,1],[3,2],[5,3]])for(const c of [0,1,2,6,7,8,9,10,11]){
   assert.equal(near[a+fine*12+c],far[b+coarse*12+c]);
  }
 }
 assert(transmitted.size>15);
 const selected=selectHedgerow(m,eye,planes),nearby=new Set(selected.near);
 for(const item of selected.far)assert(!nearby.has(item));
 assert(selected.near.length+selected.far.length>0);
 for(let i=0;i<m.data.length;i+=8)assert(Math.abs(m.data[i+1]+.015-terrainSurfaceHeight(m.data[i],m.data[i+2]))<2e-5);
 stats.push({form:m.name,baseStems:m.stems,connectedAxes:m.axes,leafSurfaces:m.shoots,apertures:transmitted.size,plants:m.data.length/8,
  heightMetres:m.height,radiusMetres:m.radius,triangles:[m.near.indices.length/3,m.far.indices.length/3],visible:[selected.near.length,selected.far.length],hash:hashes[id]});
}
assert.deepEqual(makeHedgerow().map(digest),hashes);
console.log(JSON.stringify(stats,null,2));
