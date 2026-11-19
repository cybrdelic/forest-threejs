// A tree can be rejected only if an entire cross section of its sight cone is
// beneath the drawn ground. Empty cells and positions outside the map remain
// visible. Each map value is a lower bound, never a sampled terrain average.
const SIZE=256, CELL=16, HALF=SIZE*CELL/2, EMPTY=-1e20;
const SAMPLE_FRACTIONS=[.09,.19,.30,.41,.52,.63,.74,.84,.91,.97];
const PADDING=[1,2,3];

export function buildTerrainVisibility(mesh) {
  const vertices=mesh.vertices,indices=mesh.indices;
  const n=Math.sqrt(vertices.length/12);
  const maps=new Float32Array(SIZE*SIZE*PADDING.length).fill(EMPTY);
  if(!Number.isInteger(n)||indices.length!==(n-1)**2*6)return maps;
  const height=new Float32Array(SIZE*SIZE).fill(Infinity);
  // Only the canonical, closed height-field topology is supported. All four
  // corners bound both linear triangles even where render cells are large.
  let next=0;
  for(let z=0;z<n-1;z++)for(let x=0;x<n-1;x++) {
    const a=z*n+x,b=a+1,c=a+n,d=c+1;
    if(indices[next++]!==a||indices[next++]!==c||indices[next++]!==b||
       indices[next++]!==b||indices[next++]!==c||indices[next++]!==d)return maps;
    const x0=vertices[a*12],z0=vertices[a*12+2],x1=vertices[d*12],z1=vertices[d*12+2];
    if(!(x1>x0&&z1>z0)||vertices[b*12]!==x1||vertices[b*12+2]!==z0||
       vertices[c*12]!==x0||vertices[c*12+2]!==z1)return maps;
    if(x1<=-HALF||x0>=HALF||z1<=-HALF||z0>=HALF)continue;
    const low=Math.min(vertices[a*12+1],vertices[b*12+1],vertices[c*12+1],vertices[d*12+1]);
    if(!Number.isFinite(low))return maps;
    const i0=Math.max(0,Math.floor((x0+HALF)/CELL)),i1=Math.min(SIZE-1,Math.ceil((x1+HALF)/CELL)-1);
    const j0=Math.max(0,Math.floor((z0+HALF)/CELL)),j1=Math.min(SIZE-1,Math.ceil((z1+HALF)/CELL)-1);
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
      const at=j*SIZE+i;height[at]=Math.min(height[at],low);
    }
  }
  const first=0,last=(n*n-1)*12;
  if(vertices[first]>-HALF||vertices[first+2]>-HALF||vertices[last]<HALF||vertices[last+2]<HALF)return maps;
  for(let level=0;level<PADDING.length;level++) {
    const radius=PADDING[level],start=level*SIZE*SIZE;
    for(let z=radius;z<SIZE-radius;z++)for(let x=radius;x<SIZE-radius;x++) {
      let lowest=Infinity;
      for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++){
        const h=height[(z+dz)*SIZE+x+dx];lowest=Math.min(lowest,h===Infinity?EMPTY:h);
      }
      maps[start+z*SIZE+x]=lowest;
    }
  }
  return maps;
}

export function treeBehindTerrain(maps,camera,trees,index) {
  const scale=trees[index+3],width=trees[index+6];
  if(!(scale>0&&scale<=2&&width>=0&&width<=1))return false;
  const dx=trees[index]-camera[0],dz=trees[index+2]-camera[2];
  if(dx*dx+dz*dz<180*180)return false;
  // Both source trees and their full camera-facing cards fit inside these
  // yaw-independent bounds, including width jitter and wind displacement.
  const ySpan=trees[index+1]+25*scale+1-camera[1],horizontal=23*scale+1;
  for(const t of SAMPLE_FRACTIONS) {
    const ix=Math.floor((camera[0]+dx*t+HALF)/CELL),iz=Math.floor((camera[2]+dz*t+HALF)/CELL);
    if(ix<0||ix>=SIZE||iz<0||iz>=SIZE)continue;
    const level=Math.max(0,Math.ceil(horizontal*t/CELL)-1);
    if(maps[(level*SIZE+iz)*SIZE+ix]>camera[1]+t*ySpan+.5)return true;
  }
  return false;
}

export const terrainCullWGSL=/* wgsl */`
@group(1) @binding(3) var<storage,read> terrainMinima:array<f32>;
fn treeBehindTerrain(root:vec4<f32>,width:f32)->bool {
 let camera=u.camera.xyz;let delta=root.xz-camera.xz;
 if(root.w<=0.0||root.w>2.0||width<0.0||width>1.0||dot(delta,delta)<32400.0){return false;}
 let fractions=array<f32,${SAMPLE_FRACTIONS.length}>(${SAMPLE_FRACTIONS.join(',')});
 let horizontal=23.0*root.w+1.0;
 let top=root.y+25.0*root.w+1.0-camera.y;
 for(var i=0u;i<${SAMPLE_FRACTIONS.length}u;i++){
  let t=fractions[i];
  let cell=vec2<i32>(floor((camera.xz+t*delta+${HALF}.0)/${CELL}.0));
  if(all(cell>=vec2<i32>(0))&&all(cell<vec2<i32>(${SIZE}))){
   let level=max(0,i32(ceil(horizontal*t/${CELL}.0))-1);
   let index=(level*${SIZE}+cell.y)*${SIZE}+cell.x;
   if(terrainMinima[index]>camera.y+t*top+0.5){return true;}
  }
 }
 return false;
}`;
