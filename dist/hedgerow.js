// All lengths are metres. The four growth habits share photographed leaf tissue,
// but each has its own branch topology, annual shoot arrangement and crown depth.
import { meadowPlanes } from './meadow-cull.js';
import { terrainSurfaceHeight } from './landscape.js';

const TAU=2*Math.PI;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const mul=(a,s)=>a.map(v=>v*s);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const unit=v=>mul(v,1/(Math.hypot(...v)||1));
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const branchVector=(yaw,reach,rise)=>[Math.cos(yaw)*reach,rise,Math.sin(yaw)*reach];
function sequence(seed) {
 let state=seed>>>0;
 return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
}
function pointOn(points,t) {
 const s=Math.max(0,Math.min(1,t))*(points.length-1),i=Math.min(points.length-2,Math.floor(s));
 return mix(points[i],points[i+1],s-i);
}
const habits=[
 {name:'Open-grown forked broadleaf',seed:74257,habit:'standard',leaf:.46},
 {name:'Coppice stool',seed:7142,habit:'coppice',leaf:.165},
 {name:'Thorn scrub',seed:5157,habit:'thorn',leaf:.118},
 {name:'Woodland sapling',seed:1799,habit:'pole',leaf:.115}
];

function grow({seed,habit,leaf}) {
 const random=sequence(seed),axes=[],shoots=[];
 const standard=habit==='standard',pole=habit==='pole',thorn=habit==='thorn';
 function axis(start,yaw,reach,rise,sag,base,tip,order) {
  const points=[],curl=(random()-.5)*.54,knuckle=(random()-.5)*reach*.17;
  for(let i=0;i<=4;i++) {
   const t=i*.25,angle=yaw+curl*t;
   points.push(add(start,add(branchVector(angle,reach*t,rise*t-sag*Math.sin(Math.PI*t)),branchVector(angle+Math.PI*.5,knuckle*Math.sin(Math.PI*2*t),0))));
  }
  axes.push({points,base,tip,order});return points;
 }
 function leafAt(base,yaw,length,tile,inclination) {
  const along=unit(branchVector(yaw,1,inclination)),flat=[-Math.sin(yaw),0,Math.cos(yaw)];
  const roll=(random()-.5)*(standard?2.12:1.17),up=unit(cross(flat,along));
  const across=add(mul(flat,Math.cos(roll)),mul(up,Math.sin(roll)));
  shoots.push({base,along,across,normal:unit(cross(across,along)),length,
   width:length*(tile>=8?.83+random()*.23:.57+random()*.22),tile,fold:(.035+random()*.08)*length,bow:(random()*.19-.11)*length});
 }
 function twigs(start,yaw,reach,rise) {
  // Leaf-bearing current-year wood stays connected to the previous increment.
  const twig=axis(start,yaw,reach,rise,reach*(.04+random()*.11),standard?.017:thorn?.007:.0045,.0013,3);
  const count=standard?9:thorn?7:6;
  for(let i=0;i<count;i++) {
   const t=.15+.81*(i+random()*.25)/count;
   const size=leaf*(.78+random()*.42)*(1-.20*t);
   const base=pointOn(twig,t),side=i%2?1:-1;
   const twigTile=8+Math.floor(random()*5),single=Math.floor(random()*6);
   const isSpray=standard||(!pole&&random()<(thorn?.72:.48));
   leafAt(base,yaw+side*(.43+random()*.86),size*(isSpray?1.21:.98),isSpray?twigTile:single,(random()-.44)*(standard?2.75:1.32));
   if(!standard && !thorn)leafAt(base,yaw-side*(.69+random()*.94),size*(.8+random()*.22),single,(random()-.41)*.95);
  }
  leafAt(pointOn(twig,.92),yaw,leaf*.71,standard?9:Math.floor(random()*6),random()*.9);
 }
 function lateral(start,yaw,reach,rise,radius) {
  const bough=axis(start,yaw,reach,rise,reach*(thorn?.04:.12),radius,radius*.14,2);
  const laterals=standard?6:pole?4:thorn?4:5;
  for(let i=0;i<laterals;i++) {
   const t=.18+.78*(i+random()*.38)/laterals,side=i%2?1:-1;
   const length=reach*(.30+random()*.38)*(1.08-.34*t)+leaf*.31;
   twigs(pointOn(bough,t),yaw+side*(.41+random()*.76),length,length*((thorn?-.25:-.1)+random()*.74));
  }
  twigs(bough[4],yaw+random()*.33,reach*.34+leaf*.6,rise*.15+leaf*.18);
 }
 function scaffold(start,yaw,reach,rise,radius,ramification) {
  const wood=axis(start,yaw,reach,rise,reach*(standard?.22:.085),radius,radius*.14,1);
  const initialOrientation=random()*TAU;
  for(let i=0;i<ramification;i++) {
   const t=.15+.82*(i+random()*.46)/ramification;
   const side=i%2?1:-1;
   const split=pole?initialOrientation+i*2.39996:yaw+side*(.51+random()*.98);
   const radial=(.50+random()*.60)*((1-t)*.58+.54)*(standard?2.05:pole?.83:thorn?.55:.68);
   lateral(pointOn(wood,t),split,radial,radial*(.18+random()*.72),radius*(.29-.16*t));
  }
  if(standard) {
   // Reiterated shoots from the scaffold crotches fill the interior crown.
   // Their steep growth and inward aspect connect adjacent leafy masses.
   const forkSide=random()<.5?-1:1;
   for(let j=0;j<4;j++) {
    const t=.29+j*.16+random()*.08;
    const angle=yaw+forkSide*(j%2?-1:1)*(1.43+random()*.85);
    lateral(pointOn(wood,t),angle,.8+random()*1.33,.74+random()*1.15,radius*(.22-.095*t));
   }
  }
  lateral(wood[4],yaw+(random()-.5)*.56,(standard?1.5:pole?.55:.64)*(.8+random()*.5),standard?1.05:.33,radius*.15);
 }
 const roots=[];
 if(standard) {
  const trunk=axis([0,-.02,0],.7,.54,6.8,.04,.32,.09,0);roots.push(trunk[0]);
  for(let i=0;i<12;i++) {
   const t=.38+.59*i/12,yaw=i*2.39996+random()*.53;
   scaffold(pointOn(trunk,t),yaw,(4.3+random()*1.18)*(1.09-.45*t),1.55+t*2.2+random()*1.05,.185-.082*t,9);
  }
  for(let i=0;i<5;i++) {
   const t=.77+.22*random(),yaw=i*2.39996+random();
   scaffold(pointOn(trunk,t),yaw,1.62+random()*.93,1.72+random()*1.24,.083,7);
  }
  for(let i=0;i<7;i++){
   const yaw=i*2.39996+random()*.42;
   axis(pointOn(trunk,.088),yaw,.58+random()*.22,-.63,.09,.12,.015,0);
  }
 } else if(pole) {
  const yaw=random()*TAU,stem=axis([0,-.025,0],yaw,.32,4.12,.1,.061,.01,0);roots.push(stem[0]);
  for(let i=0;i<14;i++) {
   const t=.23+.74*i/14,angle=i*2.39996+random()*.52;
   lateral(pointOn(stem,t),angle,(.46+random()*.46)*(1.31-.73*t),.28+random()*.53,.021*(1.23-t*.66));
  }
  twigs(stem[4],yaw,.14,.31);
 } else {
  // Each stem emerges at the stool. Thorn first runs outwards then forks
  // back up. Coppice sends several independent straight rods to the light.
  const count=thorn?5:7;
  for(let i=0;i<count;i++) {
   const yaw=i*2.39996+random()*.6,r=thorn?.15:.11;
   const root=branchVector(yaw,random()*r,-.025);roots.push(root);
   const radius=(thorn?.047:.050)*(.63+random()*.55);
   const cane=axis(root,yaw,thorn?.48+random()*.45:.21+random()*.26,thorn?.30+random()*.52:.93+random()*.72,thorn?-.17:.04,radius,radius*.56,0);
   for(let j=0;j<3;j++) {
    const direction=yaw+(j-1)*(.72+random()*.69);
    scaffold(pointOn(cane,.45+j*.23),direction,thorn?.37+random()*.49:.31+random()*.67,thorn?.27+random()*.55:.79+random()*.73,radius*.49,thorn?4:5);
   }
  }
 }
 return {axes,shoots,roots};
}

// Voxelize the actual surface area of the reconstructed leaf or photographed
// shoot. Six oblique and one zenith optical-depth integrations use the same
// packed directional transmission convention as the source tree assets.
const occupiedFraction=[.596,.586,.561,.572,.540,.553,0,0,.247,.247,.275,.265,.301];
function lightGrid(shoots) {
 const size=24,count=size**3,centers=shoots.map(s=>add(s.base,mul(s.along,s.length*.5)));
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<shoots.length;i++)for(let j=0;j<3;j++) {
  lo[j]=Math.min(lo[j],centers[i][j]-shoots[i].length*.65);
  hi[j]=Math.max(hi[j],centers[i][j]+shoots[i].length*.65);
 }
 const cell=lo.map((v,j)=>(hi[j]-v)/size),volume=cell[0]*cell[1]*cell[2];
 const density=new Float32Array(count),visibility=new Uint8Array(count*8);
 const key=(x,y,z)=>x+size*(z+size*y);
 const index=v=>v.map((s,j)=>Math.max(0,Math.min(size-1,Math.floor((s-lo[j])/cell[j]))));
 // Deposit with trilinear weights, reducing grid-direction quantization.
 for(let i=0;i<shoots.length;i++) {
  const s=shoots[i],p=centers[i].map((v,j)=>(v-lo[j])/cell[j]-.5),floor=p.map(Math.floor),f=p.map((v,j)=>v-floor[j]);
  const area=s.length*s.width*occupiedFraction[s.tile]/volume;
  for(let y=0;y<2;y++)for(let z=0;z<2;z++)for(let x=0;x<2;x++) {
   const xx=floor[0]+x,yy=floor[1]+y,zz=floor[2]+z;
   if(xx>=0&&yy>=0&&zz>=0&&xx<size&&yy<size&&zz<size)density[key(xx,yy,zz)]+=area*(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);
  }
 }
 for(let k=0;k<7;k++) {
  const elev=k===6?Math.PI*.5:Math.PI*.2,dist=cell[1]/Math.sin(elev),angle=k*TAU/6;
  const dx=Math.sin(angle)*Math.cos(elev)*dist/cell[0],dz=Math.cos(angle)*Math.cos(elev)*dist/cell[2];
  const depth=new Float32Array(count);
  for(let y=size-1;y>=0;y--)for(let z=0;z<size;z++)for(let x=0;x<size;x++) {
   const id=key(x,y,z),u=x+dx,v=z+dz,ix=Math.floor(u),iz=Math.floor(v);
   let tau=density[id]*dist*.25;
   if(y<size-1)for(let b=0;b<2;b++)for(let a=0;a<2;a++) {
    const xx=ix+a,zz=iz+b;
    if(xx>=0&&zz>=0&&xx<size&&zz<size) {
     const next=key(xx,y+1,zz),weight=(a?u-ix:1-u+ix)*(b?v-iz:1-v+iz);
     tau+=(depth[next]+density[next]*dist*.25)*weight;
    }
   }
   depth[id]=tau;visibility[id*8+k]=Math.round(255*Math.exp(-tau));
  }
 }
 for(let i=0;i<count;i++) {
  let ring=0;for(let k=0;k<6;k++)ring+=visibility[i*8+k];
  visibility[i*8+7]=Math.round(.125*ring+.25*visibility[i*8+6]);
 }
 return pos=>{
  const xyz=index(pos),offset=key(...xyz)*8;
  return [visibility[offset]+256*visibility[offset+1]+65536*visibility[offset+2],
   visibility[offset+3]+256*visibility[offset+4]+65536*visibility[offset+5],visibility[offset+6]+256*visibility[offset+7]+65536*255];
 };
}
function meshOf(plant,lit,fine) {
 const vertices=[],indices=[];
 function vert(p,n,color,mat,u,v){const id=vertices.length/12;vertices.push(...p,...n,...color,mat,u,v);return id;}
 for(const axis of plant.axes) {
  // Keep junctions overlapped by the parent bark. Ring axes follow the
  // current segment tangent, maintaining a curved, watertight outer tube.
  const sides=(fine?[12,9,6,4]:[8,6,4,3])[axis.order],points=fine?axis.points:[axis.points[0],axis.points[2],axis.points[4]];
  const first=vertices.length/12,reference=unit(sub(points.at(-1),points[0]));
  const helper=Math.abs(reference[1])<.85?[0,1,0]:[1,0,0],across=unit(cross(reference,helper));
  for(let r=0;r<points.length;r++) {
   const t=r/(points.length-1),p=points[r],tangent=unit(sub(points[Math.min(r+1,points.length-1)],points[Math.max(r-1,0)]));
   const around=unit(cross(tangent,across)),perp=unit(cross(around,tangent));
   const radius=axis.tip+(axis.base-axis.tip)*(1-t)**1.25,light=lit(p);
   for(let j=0;j<sides;j++) {
    const theta=j*TAU/sides,n=add(mul(perp,Math.cos(theta)),mul(around,Math.sin(theta)));
    vert(add(p,mul(n,radius)),n,light,1,.035*Math.max(0,p[1]),0);
    if(r){const a=first+(r-1)*sides+j,b=first+(r-1)*sides+(j+1)%sides;indices.push(a,b,a+sides,b,b+sides,a+sides);}
   }
  }
 }
 for(const s of plant.shoots) {
  const t=s.tile,col=t%4,row=t>>2,first=vertices.length/12;
  const light=lit(add(s.base,mul(s.along,.5*s.length))),cols=fine?3:2;
  for(let j=0;j<2;j++)for(let i=0;i<cols;i++) {
   const u=i/(cols-1),side=2*u-1;
   const bend=side*side*s.fold+(j?s.bow:0),p=add(add(s.base,mul(s.along,j*s.length)),add(mul(s.across,(u-.5)*s.width),mul(s.normal,-bend)));
   const normal=unit(add(s.normal,add(mul(s.across,side*s.fold*2/s.width),mul(s.along,s.bow/s.length))));
   vert(p,normal,light,5,(col*128+3.5+121*u)/512,(row*128+3.5+121*(1-j))/512);
  }
  for(let c=0;c<cols-1;c++)indices.push(first+c,first+c+1,first+c+cols,first+c+1,first+c+cols+1,first+c+cols);
 }
 return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices)};
}

// Groups trace the margins of the clearing, the pasture lip and the small
// woodland glade. Open-grown trees get space, coppice and thorn interlock.
const positions=[
 [[-184,151,1.19],[-187,111,1.48],[-108,135,1.27],[-80,83,1.18],[-354,-94,1.17],[-347,-48,1.04],[-323,-101,.89],[108,-325,1.03]],
 [[-171,166,.99],[-173,164,.86],[-161,146,1.17],[-147,139,.92],[-126,137,1.23],[-118,140,1.03],[-114,135,1.12],[-108,146,.88],[-93,91,1.02],[-87,87,.91],[-350,-81,1.09],[-351,-83,.91],[-341,-86,.8],[-339,-87,1.15],[101,-313,1.23],[106,-311,1.08]],
 [[-170.5,187,.71],[-165.05,184.20,.72],[-164.0,183.7,.53],[-147,157,.99],[-144.7,156.3,1.11],[-143,155,.75],[-135,143,1.07],[-129,139,1.25],[-120,146,.95],[-119,146,.83],[-353,-79,.94],[-341,-83,.56],[-337,-69,.72],[100,-312,.99]],
 [[-169,158,.96],[-153,146,1.23],[-139,150,.93],[-120,144,1.15],[-107,140,1.19],[-90,90,1.11],[-351,-84,.81],[-336,-78,1.2],[-343,-92,1.16],[122,-307,1.04]]
];
export function makeHedgerow() {
 return habits.map((habit,h)=>{
  const architecture=grow(habit),light=lightGrid(architecture.shoots),near=meshOf(architecture,light,true),far=meshOf(architecture,light,false);
  let radius=0,height=0;for(let j=0;j<near.vertices.length;j+=12){radius=Math.max(radius,Math.hypot(near.vertices[j],near.vertices[j+2]));height=Math.max(height,near.vertices[j+1]);}
  const random=sequence(habit.seed+81),individuals=[];
  for(const [x,z,scale] of positions[h])individuals.push(x,terrainSurfaceHeight(x,z)-.015,z,scale,random()*TAU,.32+random()*.50,.21+random()*.71,random());
  return {name:habit.name,near,far,radius,height,data:new Float32Array(individuals),previous:new Uint8Array(individuals.length/8),
   shoots:architecture.shoots.length,axes:architecture.axes.length,stems:architecture.roots.length};
 });
}

export function selectHedgerow(model,camera,planes) {
 const {data,radius,height,previous}=model,near=[],far=[],wide=[],close=[];
 for(let i=0;i<data.length;i+=8) {
  const x=data[i],y=data[i+1],z=data[i+2],s=data[i+3],r=radius*s*(.78+.48*data[i+6])+.18,h=height*s*.5+.1;
  const distance=Math.hypot(x-camera[0],z-camera[2]),eyeDistance=Math.hypot(distance,y+h-camera[1]);
  if(distance<650+r)wide.push(i/8);
  // Cover off-camera crowns whose shadows can enter the close map.
  if(distance<35+r+2*h)close.push(i/8);
  let visible=true;
  for(let j=0;j<24;j+=4) {
   const a=planes[j],b=planes[j+1],c=planes[j+2];
   if(a*x+b*(y+h)+c*z+planes[j+3]+(Math.abs(a)+Math.abs(c))*r+Math.abs(b)*h<0){visible=false;break;}
  }
  if(!visible)continue;
  const band=previous[i/8]===1?1.07:previous[i/8]===2?.93:1,nearLimit=Math.max(20,8.3*height*s)*band;
  const useFine=eyeDistance<nearLimit;previous[i/8]=useFine?1:2;
  (useFine?near:far).push(i/8);
 }
 return {near,far,wide,close};
}
// Generate the local canopy geometry while the larger tree assets load. The
// offline render harness and hosts without module workers use the same code.
export async function prepareHedgerow() {
 if(typeof Worker==='undefined')return makeHedgerow();
 let worker;
 try {
  worker=new Worker(new URL('./hedgerow-worker.js',import.meta.url),{type:'module'});
  return await new Promise((resolve,reject)=>{
   worker.onmessage=({data})=>resolve(data);
   worker.onerror=event=>reject(new Error(event.message||'Woodland generation failed'));
   worker.onmessageerror=()=>reject(new Error('Invalid woodland geometry'));
   worker.postMessage(null);
  });
 } catch {return makeHedgerow();}
 finally {worker?.terminate();}
}

const passes=['near','far','wide','close'];
export function createGPUHedgerow(source,device,layout,uploadMesh,createBuffer) {
 const models=source.map(model=>{
  const instances=createBuffer(model.data,GPUBufferUsage.STORAGE,'Hedgerow transforms');
  const meshes=[uploadMesh(model.near,model.name),uploadMesh(model.far,model.name+' distance')];
  const banks=Object.fromEntries(passes.map(key=>{
   const buffer=device.createBuffer({size:model.data.length/2,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
   const group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:instances}},{binding:1,resource:{buffer}}]});
   return [key,{buffer,group,count:0}];
  }));
  model.near=null;model.far=null;return {model,meshes,banks};
 });
 const planes=new Float64Array(24);
 return {update(eye,matrix){
  meadowPlanes(matrix,planes);let triangles=0;
  for(const {model,meshes,banks} of models){const selected=selectHedgerow(model,eye,planes);
   for(const key of passes){const list=selected[key],bank=banks[key];bank.count=list.length;if(list.length)device.queue.writeBuffer(bank.buffer,0,new Uint32Array(list));}
   triangles+=(selected.near.length*meshes[0].count+selected.far.length*meshes[1].count)/3;
  }return triangles;
 },draw(pass,key){for(const {meshes,banks} of models){const bank=banks[key];if(!bank.count)continue;
   const mesh=meshes[key==='near'||key==='close'?0:1];pass.setBindGroup(1,bank.group);pass.setVertexBuffer(0,mesh.vertex);pass.setIndexBuffer(mesh.index,'uint32');pass.drawIndexed(mesh.count,bank.count);
  }}};
}
export function createGLHedgerow(source,uploadMesh,uploadInstances,drawMesh) {
 const models=source.map(model=>{
  const meshes=[uploadMesh(model.near),uploadMesh(model.far)],buffers=Object.fromEntries(passes.map(key=>[key,new Float32Array(model.data.length)]));
  model.near=null;model.far=null;return {model,meshes,buffers,counts:{}};
 });
 const planes=new Float64Array(24);
 return {update(eye,matrix){meadowPlanes(matrix,planes);let triangles=0;
  for(const {model,meshes,buffers,counts} of models){const selected=selectHedgerow(model,eye,planes);
   for(const key of passes){counts[key]=selected[key].length;selected[key].forEach((id,i)=>buffers[key].set(model.data.subarray(id*8,id*8+8),i*8));}
   triangles+=(selected.near.length*meshes[0].count+selected.far.length*meshes[1].count)/3;
  }return triangles;
 },draw(key){for(const {meshes,buffers,counts} of models){if(!counts[key])continue;const mesh=meshes[key==='near'||key==='close'?0:1];uploadInstances(mesh,buffers[key],counts[key]);drawMesh(mesh,true);}}};
}
