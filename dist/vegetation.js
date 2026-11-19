/** Procedural broadleaf geometry in metres, with linear RGB vertex colors. */
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
    state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
    state = (state ^ (state >>> 15)) >>> 0;
    return state / 4294967296;
  };
}
const add = (a,b) => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const scale = (v,s) => [v[0]*s,v[1]*s,v[2]*s];
const subtract = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize = v => scale(v,1/(Math.hypot(...v)||1));
const mix = (a,b,t) => a.map((value,axis)=>value*(1-t)+b[axis]*t);

class MeshBuilder {
  constructor() { this.vertices=[];this.indices=[]; }
  vertex(position,normal,color,material,wind=0,roughness=0.9) {
    const id=this.vertices.length/12;
    this.vertices.push(...position,...normal,...color,material,wind,roughness);
    return id;
  }
  triangle(a,b,c) { this.indices.push(a,b,c); }
  finish() { return {vertices:new Float32Array(this.vertices),indices:new Uint32Array(this.indices)}; }
}

function cylinder(mesh,start,end,bottomRadius,topRadius,sides,random) {
  const direction=normalize(subtract(end,start));
  const reference=Math.abs(direction[1])>0.92?[1,0,0]:[0,1,0];
  const tangent=normalize(cross(direction,reference));
  const bitangent=cross(direction,tangent);
  const first=mesh.vertices.length/12;
  for(let ring=0;ring<2;ring++) {
    const center=ring?end:start;
    const radius=ring?topRadius:bottomRadius;
    for(let side=0;side<=sides;side++) {
      const angle=side/sides*Math.PI*2;
      const radial=add(scale(tangent,Math.cos(angle)),scale(bitangent,Math.sin(angle)));
      const ridge=1+0.035*Math.cos(angle*7+center[1]*0.7)+0.018*Math.sin(angle*13);
      const normal=normalize(add(radial,scale(direction,(bottomRadius-topRadius)/Math.hypot(...subtract(end,start)))));
      const shade=0.78+random()*0.28;
      mesh.vertex(add(center,scale(radial,radius*ridge)),normal,[0.16*shade,0.122*shade,0.079*shade],1,Math.max(0,center[1]-5)*0.008,0.98);
    }
  }
  for(let side=0;side<sides;side++) {
    const a=first+side,b=first+sides+1+side;
    mesh.triangle(a,a+1,b);mesh.triangle(a+1,b+1,b);
  }
}

function createTreeStructure(seed) {
  const random=randomSource(seed);
  const segments=[],lobes=[];
  const trunk=[];
  for(let i=0;i<=12;i++) {
    const y=i*1.08;
    trunk.push([Math.sin(y*0.34)*0.18+y*0.022,y,Math.sin(y*0.45+0.4)*0.14]);
    if(i) segments.push({start:trunk[i-1],end:trunk[i],r0:0.46*Math.pow(1-(i-1)/14,1.6)+0.018,r1:0.46*Math.pow(1-i/14,1.6)+0.018,order:0});
  }
  for(let primary=0;primary<11;primary++) {
    const angle=primary*2.39996323+random()*0.5;
    const level=primary%4;
    const start=trunk[4+level*2];
    const reach=3.3-level*0.28+random()*0.8;
    const middle=add(start,[Math.cos(angle)*reach*0.55,1.0+random(),Math.sin(angle)*reach*0.55]);
    const end=add(start,[Math.cos(angle)*reach,2.5+random()*1.4,Math.sin(angle)*reach]);
    segments.push({start,end:middle,r0:0.16-level*0.017,r1:0.10-level*0.01,order:1});
    segments.push({start:middle,end,r0:0.10-level*0.01,r1:0.042,order:1});
    lobes.push({center:add(end,[0,0.62,0]),radius:[1.30,1.22,1.30]});
    for(let secondary=0;secondary<4;secondary++) {
      const fan=angle+(secondary-1.5)*0.62+(random()-0.5)*0.35;
      const attach=mix(middle,end,0.35+secondary*0.18);
      const reach2=1.6+random()*1.0;
      const tip=add(attach,[Math.cos(fan)*reach2,0.7+random()*1.3,Math.sin(fan)*reach2]);
      const bend=mix(attach,tip,0.52);bend[1]-=0.22;
      segments.push({start:attach,end:bend,r0:0.045,r1:0.025,order:2});
      segments.push({start:bend,end:tip,r0:0.025,r1:0.008,order:2});
      const lobe={center:add(tip,[0,0.20,0]),radius:[0.88+random()*0.45,0.80+random()*0.55,0.88+random()*0.45]};
      lobes.push(lobe);
      for(let twig=0;twig<4;twig++) {
        const twigAngle=fan+(twig-1.5)*0.85;
        const twigEnd=add(tip,[Math.cos(twigAngle)*(0.5+random()*0.5),(random()-0.3)*0.8,Math.sin(twigAngle)*(0.5+random()*0.5)]);
        segments.push({start:mix(bend,tip,0.65),end:twigEnd,r0:0.011,r1:0.0025,order:3});
      }
    }
  }
  // Upper shoots complete the crown without imposing a spherical outer shell.
  for(let i=0;i<8;i++) {
    const angle=i*2.39996;
    const tip=[Math.cos(angle)*(0.6+random()*1.6),13.7+random()*1.6,Math.sin(angle)*(0.6+random()*1.6)];
    segments.push({start:trunk[10],end:tip,r0:0.04,r1:0.006,order:2});
    lobes.push({center:tip,radius:[1.1,0.8+random()*0.5,1.1]});
  }
  // Overlapping scaffold masses fill the lower and inner crown. Small terminal
  // lobes retain the broken natural silhouette around the outside.
  lobes.push({center:[0.1,10.6,-0.1],radius:[4.5,3.5,4.2]});
  lobes.push({center:[0.5,14.0,0.3],radius:[3.6,3.1,3.5]});
  for(let i=0;i<10;i++) {
    const angle=i*2.39996323+random()*0.45;
    const reach=3.1+random()*1.0;
    lobes.push({
      center:[Math.cos(angle)*reach,8.9+random()*3.2,Math.sin(angle)*reach],
      radius:[2.05+random()*0.65,1.9+random()*0.7,2.0+random()*0.7]
    });
  }
  return {segments,lobes};
}

function branches(mesh,structure,detail) {
  const random=randomSource(1701);
  if(detail==='far') {
    const trunk=structure.segments.filter(segment=>segment.order===0);
    for(let i=0;i<trunk.length;i+=3) {
      const end=trunk[Math.min(i+2,trunk.length-1)];
      cylinder(mesh,trunk[i].start,end.end,trunk[i].r0,end.r1,5,random);
    }
    return;
  }
  for(const segment of structure.segments) {
    if(detail==='far'&&segment.order>0) continue;
    if(detail==='mid'&&segment.order>1) continue;
    const sides=segment.order===0?(detail==='near'?14:8):segment.order===1?8:5;
    cylinder(mesh,segment.start,segment.end,segment.r0,segment.r1,sides,random);
  }
  if(detail!=='near')return;
  for(let i=0;i<7;i++) {
    const angle=i*Math.PI*2/7+0.3;
    cylinder(mesh,[Math.cos(angle)*0.30,0.75,Math.sin(angle)*0.30],[Math.cos(angle)*1.04,-0.06,Math.sin(angle)*1.04],0.16,0.035,7,random);
  }
}

function sampleLeaves(structure,count,seed) {
  const random=randomSource(seed);
  const result=[];
  let totalWeight=0;
  const weights=structure.lobes.map(lobe=>{
    totalWeight+=Math.pow(lobe.radius[0]*lobe.radius[1]*lobe.radius[2],0.75);
    return totalWeight;
  });
  for(let i=0;i<count;i++) {
    const selection=random()*totalWeight;
    let lobeIndex=0;
    while(weights[lobeIndex]<selection)lobeIndex++;
    const lobe=structure.lobes[lobeIndex];
    const azimuth=random()*Math.PI*2;
    const vertical=random()*2-1;
    const horizontal=Math.sqrt(1-vertical*vertical);
    const radius=Math.cbrt(random());
    const offset=[Math.cos(azimuth)*horizontal,vertical,Math.sin(azimuth)*horizontal];
    const center=lobe.center.map((value,axis)=>value+offset[axis]*lobe.radius[axis]*radius);
    const outward=normalize([(center[0]-0.2)*0.8,(center[1]-11.4)*0.9,center[2]*0.8]);
    const brightness=0.76+random()*0.42;
    const young=random();
    result.push({center,outward,length:0.18+random()*0.08,width:0.082+random()*0.036,
      angle:azimuth+random()*2.5,tilt:(random()-0.5)*1.85,roll:(random()-0.5)*1.3,
      bend:(random()-0.35)*0.14,color:[(0.057+young*0.020)*brightness,(0.124+young*0.034)*brightness,(0.019+young*0.009)*brightness],seed:random()});
  }
  return result;
}

function modeledLeaf(mesh,leaf,enlargement,detail) {
  const along=[Math.sin(leaf.angle)*Math.cos(leaf.tilt),Math.sin(leaf.tilt),Math.cos(leaf.angle)*Math.cos(leaf.tilt)];
  const flatAcross=[Math.cos(leaf.angle),0,-Math.sin(leaf.angle)];
  const up=normalize(cross(along,flatAcross));
  const across=add(scale(flatAcross,Math.cos(leaf.roll)),scale(up,Math.sin(leaf.roll)));
  let normal=normalize(cross(along,across));
  // Preserve local leaf curvature while making the entire crown receive light
  // as a coherent volume instead of a collection of bright disconnected cards.
  const orientedOutward=scale(leaf.outward,normal[0]*leaf.outward[0]+normal[1]*leaf.outward[1]+normal[2]*leaf.outward[2]<0?-1:1);
  normal=normalize(add(scale(normal,0.69),scale(orientedOutward,0.31)));
  const length=leaf.length*enlargement,width=leaf.width*enlargement;
  const outline=detail==='near'
    ? [[0,0],[0.23,-0.77],[0.65,-1],[1,0],[0.65,1],[0.23,0.77]]
    : [[0,0],[0.48,-1],[1,0],[0.48,1]];
  const first=mesh.vertices.length/12;
  const ridge=add(leaf.center,scale(normal,length*0.045));
  mesh.vertex(ridge,normal,leaf.color.map(value=>value*1.02),5,0.5,0.5);
  for(const [t,side] of outline) {
    const point=add(add(add(leaf.center,scale(along,(t-0.47)*length)),scale(across,side*width*0.5)),scale(normal,leaf.bend*length*t*t));
    const bentNormal=normalize(add(normal,scale(across,side*0.10)));
    mesh.vertex(point,bentNormal,leaf.color,5,0.5+side*0.5,t);
  }
  for(let i=0;i<outline.length;i++) mesh.triangle(first,first+1+i,first+1+(i+1)%outline.length);
}

function createLeafTree(structure,leaves,detail) {
  const mesh=new MeshBuilder();
  branches(mesh,structure,detail);
  const step=detail==='near'?1:14;
  const enlargement=detail==='near'?1:Math.sqrt(step)*1.04;
  for(let i=0;i<leaves.length;i+=step) modeledLeaf(mesh,leaves[i],enlargement,detail);
  const result=mesh.finish();result.leafCount=Math.ceil(leaves.length/step);
  return result;
}

function occupied(point,lobes) {
  return lobes.some(lobe=>{
    const d=point.map((value,axis)=>(value-lobe.center[axis])/lobe.radius[axis]);
    return d[0]*d[0]+d[1]*d[1]+d[2]*d[2]<1.05;
  });
}

function createVoxelTree(structure,targetCells) {
  const mesh=new MeshBuilder(),random=randomSource(719);
  branches(mesh,structure,'far');
  let voxelSize=targetCells>40?1.35:2.05,cells=[];
  do {
    cells=[];
    for(let y=5;y<=19;y+=voxelSize)for(let x=-8;x<=8;x+=voxelSize)for(let z=-8;z<=8;z+=voxelSize) {
      const center=[x+voxelSize*0.5,y+voxelSize*0.5,z+voxelSize*0.5];
      if(occupied(center,structure.lobes))cells.push(center);
    }
    if(cells.length>targetCells)voxelSize*=1.05;
  } while(cells.length>targetCells);
  const axes=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const faces=[[2,0,4],[2,4,1],[2,1,5],[2,5,0],[3,4,0],[3,1,4],[3,5,1],[3,0,5]];
  for(const center of cells) {
    const first=mesh.vertices.length/12;
    const radius=voxelSize*(1.10+random()*0.10);
    const color=[0.073,0.15,0.026].map(value=>value*(0.78+random()*0.37));
    for(const axis of axes) {
      const point=add(center,scale(axis,radius*(0.90+random()*0.20)));
      // Smooth normals preserve a canopy's aggregate volume across cell edges.
      const outward=normalize(add(scale(subtract(point,[0.2,11.3,0]),0.50),scale(axis,0.25)));
      mesh.vertex(point,outward,color,2,0.18,0.88);
    }
    for(const face of faces)mesh.triangle(...face.map(value=>value+first));
  }
  const result=mesh.finish();result.voxelCount=cells.length;result.voxelSize=voxelSize;
  return result;
}

function createGrass() {
  const mesh=new MeshBuilder(),random=randomSource(6301);
  // Overlapping blades form a continuous sward at the world lattice spacing.
  // Three curved segments retain a pointed tip with five triangles per blade.
  for(let blade=0;blade<76;blade++) {
    const angle=random()*Math.PI*2;
    const base=[(random()-0.5)*0.60,0,(random()-0.5)*0.60];
    // A meadow contains low, spreading leaves beneath its upright grasses.
    // Mixing their habits in one tuft avoids an even wall of identical tips.
    const habit=random();
    const low=habit<0.28;
    const height=low?0.065+random()*0.14
      :habit<0.78?0.16+Math.pow(random(),0.85)*0.24
      :0.30+random()*0.27;
    const bend=low?0.10+random()*0.18:0.035+random()*0.20;
    const sideways=(random()-0.5)*0.12;
    const halfWidth=low?0.012+random()*0.013:0.006+random()*0.0105;
    const across=[Math.cos(angle),0,-Math.sin(angle)];
    const forward=[Math.sin(angle),0,Math.cos(angle)];
    const first=mesh.vertices.length/12;
    const dry=random()<0.075;
    const color=dry
      ? [0.18+random()*0.055,0.155+random()*0.045,0.055+random()*0.025]
      : [0.064+random()*0.037,0.16+random()*0.08,0.026+random()*0.022];
    for(let segment=0;segment<=3;segment++) {
      const t=segment/3;
      const center=add(base,add(add(scale(forward,bend*t*t),scale(across,sideways*t*t)),[0,height*t,0]));
      const normal=normalize(add(scale(forward,-1),[0,0.28+t*0.65,0]));
      const shade=0.68+t*0.34;
      const width=halfWidth*Math.pow(1-t,0.68);
      for(const side of [-1,1]) {
        mesh.vertex(add(center,scale(across,side*width)),normal,color.map(value=>value*shade),3,t*0.65,0.88);
      }
    }
    for(let segment=0;segment<3;segment++) {
      const a=first+segment*2;
      mesh.triangle(a,a+1,a+2);
      if(segment<2)mesh.triangle(a+1,a+3,a+2);
    }
  }
  for(let cluster=0;cluster<3;cluster++) {
    const center=[(random()-0.5)*0.56,0.045+random()*0.055,(random()-0.5)*0.56];
    for(let leaflet=0;leaflet<3;leaflet++) {
      const angle=leaflet*Math.PI*2/3+cluster*0.8;
      const along=[Math.cos(angle),0.12,Math.sin(angle)];
      const across=[-Math.sin(angle),0,Math.cos(angle)];
      const tip=add(center,scale(along,0.060));
      const middle=add(center,scale(along,0.031));
      const left=add(middle,scale(across,0.025));
      const right=add(middle,scale(across,-0.025));
      const first=mesh.vertices.length/12;
      const color=[0.052,0.16,0.034];
      for(const point of [center,left,tip,right])mesh.vertex(point,[0,1,0],color,3,0.08,0.84);
      mesh.triangle(first,first+1,first+2);mesh.triangle(first,first+2,first+3);
    }
  }
  // A low rosette fills gaps between stems. Its folded leaf surface catches
  // different light from the clover without introducing a repeated bloom.
  const rosette=[0.17,0.018,-0.12];
  for(let leaf=0;leaf<5;leaf++) {
    const angle=leaf*Math.PI*2/5+0.31;
    const along=[Math.cos(angle),0,Math.sin(angle)];
    const across=[-Math.sin(angle),0,Math.cos(angle)];
    const length=0.085+random()*0.045;
    const width=0.014+random()*0.011;
    const first=mesh.vertices.length/12;
    const middle=add(rosette,add(scale(along,length*0.54),[0,0.027+random()*0.018,0]));
    const left=add(middle,add(scale(across,width),[0,-0.009,0]));
    const right=add(middle,add(scale(across,-width),[0,-0.009,0]));
    const tip=add(rosette,add(scale(along,length),[0,0.018,0]));
    const normal=normalize(add([0,1,0],scale(along,-0.26)));
    const color=[0.047+random()*0.015,0.112+random()*0.040,0.026+random()*0.010];
    for(const point of [rosette,left,middle,right,tip]) {
      mesh.vertex(point,normal,color,3,0.04,0.82);
    }
    mesh.triangle(first,first+1,first+2);
    mesh.triangle(first,first+2,first+3);
    mesh.triangle(first+1,first+4,first+2);
    mesh.triangle(first+2,first+4,first+3);
  }
  return mesh.finish();
}

export function createVegetation(seed=180731, options={}) {
  if(options.generatedTrees===false)return {grass:createGrass()};
  const structure=createTreeStructure(seed);
  const leaves=sampleLeaves(structure,55000,seed^0x79f32);
  return {near:createLeafTree(structure,leaves,'near'),mid:createLeafTree(structure,leaves,'mid'),far:createVoxelTree(structure,30),shadow:createVoxelTree(structure,145),grass:createGrass()};
}
