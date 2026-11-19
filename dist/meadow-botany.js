/** World-space geometry for the upper meadow layer. Distances are metres.
 * The lower sward uses the source volume slices. Stems, blades, grain and
 * flowers above that layer are individually oriented, two-sided surfaces.
 */
const TAU = Math.PI * 2;
const add = (a,b) => a.map((value,i) => value+b[i]);
const sub = (a,b) => a.map((value,i) => value-b[i]);
const mul = (a,k) => a.map(value => value*k);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = v => mul(v,1/(Math.hypot(...v)||1));
const white = [1,1,1];
const MODEL = 4;

function generator(seed) {
  return () => {
    seed = (Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  };
}
function geometry(base) {
  const vertices = Array.from(base.vertices);
  const indices = Array.from(base.indices);
  function point(position,normal,color,material=MODEL,u=0,v=0) {
    const index=vertices.length/12;
    vertices.push(...position,...unit(normal),...color,material,u,v);
    return index;
  }
  return {point,indices,finish(name) {
    return {...base,name,vertices:new Float32Array(vertices),indices:new Uint32Array(indices)};
  }};
}
function tube(mesh,points,radii,color,close=false) {
  const axis=unit(sub(points.at(-1),points[0]));
  const side=unit(cross(axis,[0,0,1]));
  const front=unit(cross(side,axis));
  let previous=null;
  for(let k=0;k<points.length;k++) {
    const ring=[];
    for(let i=0;i<3;i++) {
      const angle=TAU*i/3;
      const n=add(mul(side,Math.cos(angle)),mul(front,Math.sin(angle)));
      ring.push(mesh.point(add(points[k],mul(n,radii[k])),n,color,close?4.2:MODEL,points[0][0],points[0][2]));
    }
    if(previous) for(let j=0;j<3;j++){
      const next=(j+1)%3;
      mesh.indices.push(previous[j],ring[j],previous[next],previous[next],ring[j],ring[next]);
    }
    previous=ring;
  }
}
function blade(mesh,base,angle,length,halfWidth,lean,color) {
  // The basal and upper banks share the smooth blade curve. Upper shoots
  // stay full-height beyond walking distance and keep their own root phase.
  tillerBlade(mesh,base,angle,length*.73,lean,halfWidth*.61,.56,
    .67*Math.sin(angle*2.13+length*8.1),color,false);
}
const PETAL_ISLANDS=[
  [176.5,411.0,34.8,34.8,9],[67.0,457.0,37.8,37.8,9],[260.5,445.5,30.0,30.0,9],
  [351,70,55,64,10],[458,70,51,60,10]
];

/** A curved serrated leaf with its photographic midrib, lobes and alpha edge.
 * Four cross-sections follow the green island on the left of Dandelion 01.
 * For broadleaf forbs, reaching sideways exposes the visibly folded lamina.
 */
function rosetteLeaf(mesh,root,angle,length,halfWidth,lift,coarse) {
  const along=[Math.cos(angle),0,Math.sin(angle)],across=[-along[2],0,along[0]];
  const rows=[];
  const sections=[[0,65,476,11],[.32,55,361,32],[.72,44,211,41],[1,42,104,31]];
  if(coarse)sections.splice(1,1);
  for(const [t,cx,cy,uvWidth] of sections){
    const c=add(root,[along[0]*t*length,lift*(Math.sin(Math.PI*t*.85)+.17*t),along[2]*t*length]);
    const slope=lift*(Math.PI*.85*Math.cos(Math.PI*t*.85)+.17)/length;
    const n=unit([-along[0]*slope,1,-along[2]*slope]);
    const row=[];
    for(const j of [-1,0,1]) {
      const width=halfWidth*uvWidth/41;
      const point=add(add(c,mul(across,j*width)),[0,j===0?0:width*.22,0]);
      row.push(mesh.point(point,add(n,mul(across,-j*.24)),white,10,(cx+j*uvWidth)/512,cy/512));
    }
    rows.push(row);
  }
  for(let k=1;k<rows.length;k++) for(let j=0;j<2;j++) {
    const a=rows[k-1],b=rows[k];mesh.indices.push(a[j],a[j+1],b[j],a[j+1],b[j+1],b[j]);
  }
}
// A celandine leaf consists of a round, notched blade on its own slender
// petiole. The node at t=0 is the petiole insertion. The heart-shaped lobes
// extend behind that node. Texture coordinates follow the photographed island
// on the right of the Celandine 01 atlas, in its original orientation.
function celandineLeaf(mesh, base, angle, radialReach, height, width, pitch, close=false) {
  const along=[Math.cos(angle),0,Math.sin(angle)];
  const across=[-along[2],0,along[0]];
  const joint=add(base,[along[0]*radialReach,height,along[2]*radialReach]);
  const bend=add(base,[along[0]*radialReach*.46,height*.71,along[2]*radialReach*.46]);
  tube(mesh,[base,bend,joint],[.0019,.0015,.0011],[.116,.177,.024],close);
  const rows=[];
  const sections=[[-.32,164,433,50],[.12,142,436,55],[.65,106,436,51],[1.0,64,439,39]];
  for(const [t,v,cx,span] of sections) {
    const center=add(joint,[along[0]*width*1.6*t,width*(pitch*t+.20*t*t),along[2]*width*1.6*t]);
    const slope=(pitch+.4*t)/1.6;
    const normal=unit([-along[0]*slope,1,-along[2]*slope]);
    const row=[];
    for(const j of [-1,0,1]) {
      const offset=width*j*span/55;
      const position=add(add(center,mul(across,offset)),[0,Math.abs(offset)*(.17-.16*t),0]);
      row.push(mesh.point(position,add(normal,mul(across,-j*(.17-.16*t))),white,close?9.1:9,(cx+j*span)/512,v/512));
    }
    rows.push(row);
  }
  for(let k=1;k<rows.length;k++) for(let j=0;j<2;j++) {
    const a=rows[k-1],b=rows[k];
    mesh.indices.push(a[j],a[j+1],b[j],a[j+1],b[j+1],b[j]);
  }
}
// A broad blade has a petiole, a folded midrib and irregular, curved margins.
// The leaflet and plantain profiles share topology but have different outlines,
// vein colours, pitch and terminal notches. Distances are in metres.
function ribLeaf(mesh, root, angle, length, halfWidth, rise, droop, twist, leaflet=false) {
  const along=[Math.cos(angle),0,Math.sin(angle)],across=[-along[2],0,along[0]];
  const sections=leaflet?[[0,.11],[.27,.67],[.58,1],[.84,.91],[1,.52]]:
    [[0,.10],[.19,.31],[.43,.84],[.67,1],[.86,.67],[1,.055]];
  const sides=leaflet?[-1,0,1]:[-1,-.37,0,.37,1];
  const rows=[];
  for(const [t,spread] of sections) {
    const row=[];
    for(const q of sides) {
      const side=Math.abs(q),offset=q*halfWidth*spread*(1+.11*q*Math.sin(t*5.4+twist));
      // Offset the chevron through the centre and recess the terminal sinus
      // so a trifoliate leaf has three paired lobes in a low-angle silhouette.
      const bend=leaflet?(.105*side*Math.sin(t*Math.PI)-.087*(1-side)*t**5):0;
      const s=t+bend,roll=twist*(t-.27);
      const run=length*s;
      const h=rise*s-droop*s*s+Math.sin(Math.PI*s)*.13*length;
      const slope=(rise-2*droop*s)/length+Math.cos(Math.PI*s)*.13*Math.PI;
      const rib=(leaflet?-.11:.18)*halfWidth*spread*(1-side);
      const curl=halfWidth*spread*(.27+.17*Math.sin(angle+t*4.1))*side*side;
      const height=h+rib+curl+roll*offset;
      const p=add(root,[along[0]*run+across[0]*offset,height,along[2]*run+across[2]*offset]);
      const crossSlope=roll+q*(leaflet?.49:.32);
      const n=unit([-along[0]*slope-across[0]*crossSlope,1,-along[2]*slope-across[2]*crossSlope]);
      // Sample the interior of the photographed foliage islands. The mesh
      // defines the species silhouette. Interior UVs preserve fine vascular
      // detail while keeping surrounding source stems/alpha outside the leaf.
      let tint,material,u,v;
      if(leaflet) {
        const mark=Math.exp(-(((t-.58)/.094)**2));
        tint=[1.00+.31*mark,.97+.25*mark,.94+.42*mark];
        material=9;u=(437+q*22*spread)/512;v=(133-49*t)/512;
      } else {
        const vein=q===0?.77:side<.5?.25:.02;
        tint=[1.02+.13*vein,1.13+.18*vein,.95+.13*vein];
        material=10;u=(56-11*t+q*21*spread)/512;v=(364-223*t)/512;
      }
      row.push(mesh.point(p,n,tint,material,u,v));
    }
    rows.push(row);
  }
  for(let i=1;i<rows.length;i++)for(let j=0;j<sides.length-1;j++){
    const a=rows[i-1],b=rows[i];
    mesh.indices.push(a[j],a[j+1],b[j],a[j+1],b[j+1],b[j]);
  }
}
function plantain(mesh,rng) {
  const root=[.046,.008,-.033],angle=TAU*rng();
  // Old outer leaves lie on the sod. Recently opened leaves stand well up
  // into the grass, so sunlight can pass between blades of the same rosette.
  for(let j=0;j<5;j++) {
    const age=(j+.45)/5,a=angle+2.40*j+(rng()-.5)*.65;
    const length=.115+age*.137+.034*rng();
    const lift=.115+.174*(1-age)+.042*rng();
    ribLeaf(mesh,root,a,length,.026+.019*rng(),lift,.061+.099*age,(rng()-.5)*.72);
  }
}
function trifoliate(mesh,rng) {
  // The stolon contacts the soil, then each node carries its own long petiole.
  const root=[-.104,.012,.12],bearing=TAU*rng();
  let previous=root;
  for(let i=0;i<2;i++) {
    const a=bearing+i*.84;
    const node=add(previous,[Math.cos(a)*.079,.005,Math.sin(a)*.079]);
    tube(mesh,[previous,node],[.0020,.0018],[.112,.126,.036]);
    const h=.10+.088*rng();
    const joint=add(node,[Math.cos(a+.6)*.044,h,Math.sin(a+.6)*.044]);
    tube(mesh,[node,joint],[.0021,.0014],[.104,.157,.032]);
    for(const offset of [-1.14,0,1.23]) {
      const direction=a+offset+(rng()-.5)*.24;
      ribLeaf(mesh,joint,direction,.042+.012*rng(),.014+.006*rng(),
        .023+.013*rng(),.016+.012*rng(),(rng()-.5)*.84,true);
    }
    previous=node;
  }
}
function flower(mesh,origin,diameter,azimuth,tilt,atlasIndex,coarse) {
  // Each UV island contains a full, individually photographed blossom.
  // The angled ring cups its petals so the underside and edge silhouette
  // are visible from a walking camera as well as from above.
  // The far tuft spreads its basal footprint 2.8× to cover a sparser bank.
  // Counter the 2.8x far-footprint expansion so each flower keeps its
  // physical head diameter when the ground-cover LOD grows wider.
  const headDiameter=diameter*(coarse?.36:1);
  const n=[Math.sin(tilt)*Math.cos(azimuth),Math.cos(tilt),Math.sin(tilt)*Math.sin(azimuth)];
  const x=unit(cross(n,[0,0,1])),z=unit(cross(x,n));
  const [u,v,ru,rv,material]=PETAL_ISLANDS[atlasIndex];
  const vertex=(fraction,angle)=>{
    const a=Math.cos(angle),b=Math.sin(angle);
    const radial=add(mul(x,a),mul(z,b));
    const p=add(origin,add(mul(radial,headDiameter*.5*fraction),mul(n,headDiameter*.13*fraction*fraction)));
    return mesh.point(p,sub(n,mul(radial,.48*fraction)),white,material,(u+a*ru*fraction)/512,(v+b*rv*fraction)/512);
  };
  const core=vertex(0,0);
  if(coarse) {
    const edge=Array.from({length:8},(_,i)=>vertex(1.12,TAU*i/8));
    for(let i=0;i<8;i++)mesh.indices.push(core,edge[(i+1)%8],edge[i]);
    return;
  }
  const inner=[],rim=[];
  for(let i=0;i<10;i++){
    const angle=TAU*i/10;
    inner.push(vertex(.48,angle));rim.push(vertex(1.10,angle));
  }
  for(let i=0;i<10;i++){
    const j=(i+1)%10;
    mesh.indices.push(core,inner[j],inner[i],inner[i],rim[j],rim[i],inner[i],inner[j],rim[j]);
  }
}
function colony(mesh,rng,coarse) {
  // Separate crowns spread through a moist hollow. Their buds and blossoms
  // share a root system but never form an evenly spaced row at one height.
  const root=[-.035,.009,.026],heading=TAU*rng();
  const crowns=coarse?2:3;
  for(let shoot=0;shoot<crowns;shoot++) {
    const a=heading+2.35*shoot+.54*rng(),span=shoot*(.048+.019*rng());
    const foot=add(root,[Math.cos(a)*span,0,Math.sin(a)*span]);
    const reach=.039+.072*rng();
    const h=[.365,.279,.425][shoot]+.074*rng();
    const elbow=add(foot,[Math.cos(a)*reach*.25,h*.55,Math.sin(a)*reach*.25]);
    const head=add(foot,[Math.cos(a)*reach,h,Math.sin(a)*reach]);
    tube(mesh,coarse?[foot,head]:[foot,elbow,head],coarse?[.0024,.0013]:[.0024,.0019,.0013],[.108,.144,.021]);
    flower(mesh,head,.034+.013*rng(),a+.24,.25+.90*rng(),shoot,coarse);
    if(!coarse) {
      for(let j=0;j<2;j++) {
        celandineLeaf(mesh,foot,a-1.4+j*2.23,.040+.053*rng(),.099+.078*rng(),
          .032+.018*rng(),-.20+.96*rng());
      }
    }
  }
}
function spikelet(mesh,base,tip,width,color) {
  const axis=unit(sub(tip,base));
  const side=unit(cross(axis,[0,0,1])),front=unit(cross(side,axis));
  const middle=add(base,mul(sub(tip,base),.43));
  const ring=[];
  for(let i=0;i<3;i++){
    const a=i*TAU/3,n=add(mul(side,Math.cos(a)),mul(front,Math.sin(a)));
    ring.push(mesh.point(add(middle,mul(n,width)),n,color));
  }
  const b=mesh.point(base,mul(axis,-1),mul(color,.58)),t=mesh.point(tip,axis,mul(color,1.15));
  for(let i=0;i<3;i++){
    const j=(i+1)%3;
    mesh.indices.push(b,ring[i],ring[j],ring[i],t,ring[j]);
  }
}
function panicles(mesh,rng,coarse){
  // Branched heads follow each leaning culm and split into slender spikelets.
  for(let shoot=0;shoot<3;shoot++){
    const a=rng()*TAU,h=.40+rng()*.28;
    const root=[Math.cos(a)*rng()*.20,0,Math.sin(a)*rng()*.20];
    const axis=t=>add(root,[Math.cos(a)*.23*t*t,h*t*(1-.14*t*t),Math.sin(a)*.23*t*t]);
    const straw=rng(),color=[.105+straw*.055,.107+straw*.036,.034+straw*.025];
    tube(mesh,coarse?[root,axis(1)]:[root,axis(.58),axis(1)],coarse?[.0029,.0011]:[.0029,.0020,.0011],[.058,.101,.023]);
    if(!coarse)blade(mesh,axis(.24),a+.9,.21,.006,.15,[.056,.11,.030]);
    for(let k=0;k<6;k++) {
      const start=axis(.70+.049*k),az=a+k*2.4;
      const reach=(1-k/10)*(.035+.018*rng());
      const fork=add(start,[Math.cos(az)*reach,.015+.013*rng(),Math.sin(az)*reach]);
      if(!coarse)tube(mesh,[start,fork],[.0014,.0010],mul(color,.74));
      const tip=add(fork,[Math.cos(az)*.012,.021+rng()*.015,Math.sin(az)*.012]);
      if(coarse) {
        if(k%2===0)spikelet(mesh,start,tip,.006,color);
      } else spikelet(mesh,fork,tip,.0037,color);
    }
  }
}
export function upperMeadow(base,index,coarse=false) {
  const mesh=geometry(base),rng=generator(3193+index*389);
  const blades=[4,2,2,2][index];
  for(let i=0;i<blades;i++) {
    const a=rng()*TAU,r=Math.sqrt(rng())*.245;
    const root=[r*Math.cos(a),.012,r*Math.sin(a)],vigor=rng();
    const color=grassPigment(.16+.76*vigor);
    const heading=a+.9*rng(),length=.28+rng()*.35,width=.007+rng()*.008,lean=.18+.24*rng();
    if(!coarse)blade(mesh,root,heading,length,width,lean,color);
  }
  if(index===0&&!coarse) {
    // One lodged straw crosses the younger green tillers near their base.
    blade(mesh,[-.09,.016,.07],.56,.125,.004,.26,[.153,.125,.046]);
  }
  if(index===1&&!coarse) plantain(mesh,rng);
  if(index===2) {
    colony(mesh,rng,coarse);
    if(!coarse)trifoliate(mesh,rng);
  }
  if(index===3) {
    // Two composite flowers and their separate leaf rosettes occur among
    // the earlier and later phenotypes of the seeding grass community.
    for(let i=0;i<2;i++){
      const a=i*3.2+.31,root=[Math.cos(a)*.14,.01,Math.sin(a)*.14];
      const elbow=add(root,[.016,.16,-.025]),tip=add(root,[.065-.1*i,.31+.12*i,.045+.025*i]);
      tube(mesh,[root,elbow,tip],[.0038,.0031,.0024],[.094,.128,.027]);
      flower(mesh,tip,.050+.012*i,a,.67+.36*i,3+i,coarse);
      rosetteLeaf(mesh,add(root,[0,.03,0]),a+.83,.21,.034,.105,coarse);
    }
  }
  if(index===3)panicles(mesh,rng,coarse);
  return mesh.finish(['grazed tussocks','plantain rosettes','celandine and creeping clover','dandelion and seeding fescue'][index]);
}

const SWARD_PIGMENTS=[
  [.071,.100,.011], [.089,.114,.014], [.110,.133,.020], [.140,.159,.027]
];

// Linear RGB quartiles sampled from the green, alpha>0.8 pixels of the two
// measured grass captures. The geometry shadow and transmittance passes supply
// light along the blade, so pigment has no baked root-to-tip lighting gradient.
function grassPigment(age) {
  const t=Math.min(2.999,Math.max(0,age*3)),i=Math.floor(t),f=t-i;
  return SWARD_PIGMENTS[i].map((value,k)=>value+(SWARD_PIGMENTS[i+1][k]-value)*f);
}

function tillerBlade(mesh, root, azimuth, height, reach, breadth, droop, twist, color, close=true) {
  const forward=[Math.cos(azimuth),0,Math.sin(azimuth)];
  const lateral=[-forward[2],0,forward[0]];
  // Older leaves roll as their free end falls below the shoulder of the arc.
  // Width follows a sheath, a fully opened lamina, and a long tapered tip.
  function frame(t) {
    const h=height*(t*(1.60-.60*t)-droop*t*t*t);
    const along=reach*t*(.16+.84*t);
    const sway=twist*reach*.16*t*Math.sin(Math.PI*t);
    const dx=reach*(.16+1.68*t),dy=height*(1.60-1.20*t-3*droop*t*t);
    const surface=unit([-forward[0]*dy,dx,-forward[2]*dy]);
    const roll=twist*t*t;
    const normal=add(mul(surface,Math.cos(roll)),mul(lateral,-Math.sin(roll)));
    const across=add(mul(lateral,Math.cos(roll)),mul(surface,Math.sin(roll)));
    return {position:add(root,[forward[0]*along+lateral[0]*sway,h,forward[2]*along+lateral[2]*sway]),normal,across};
  }
  const wide=breadth>=.0040;
  const stations=wide?[[0,.48],[.27,1],[.48,.86],[.66,.67],[.81,.42],[.93,.18]]:
    [[0,.49],[.31,1],[.56,.83],[.77,.48],[.92,.18]];
  const material=close?4.1:MODEL;
  // Retain a geometric fold in the stiff sheath of wider blades. Past
  // that joint the same triangles give the free end additional curve
  // samples and a long taper, instead of two wide, straight segments.
  let previous=null;
  function pigment(t,side) {
    const tip=Math.max(0,(t-.63)/.37)**2*(.15+.23*Math.min(1,Math.abs(twist)));
    const vein=side===0?.09*(1-t):0;
    return color.map((c,i)=>c*(1+vein)+([.241,.167,.052][i]-c)*tip);
  }
  for(let k=0;k<stations.length;k++) {
    const [t,width]=stations[k],{position,normal,across}=frame(t);
    const w=breadth*width,fold=.46*(1-t)**2+.038;
    const sides=wide&&k<2?[-1,0,1]:[-1,1],row=[];
    for(const q of sides) {
      const p=add(add(position,mul(across,w*q)),mul(normal,q===0?w*fold:0));
      row.push(mesh.point(p,add(normal,mul(across,q*fold)),pigment(t,q),material,root[0],root[2]));
    }
    if(previous) {
      if(previous.length===3&&row.length===2) {
        mesh.indices.push(previous[0],previous[1],row[0],previous[1],row[1],row[0],previous[1],previous[2],row[1]);
      } else for(let j=0;j<row.length-1;j++) {
        mesh.indices.push(previous[j],previous[j+1],row[j],previous[j+1],row[j+1],row[j]);
      }
    }
    previous=row;
  }
  const end=frame(1);
  const tip=mesh.point(end.position,end.normal,pigment(1,1),material,root[0],root[2]);
  mesh.indices.push(previous[0],previous[1],tip);
}

export function closeMeadow() {
  const mesh=geometry({vertices:new Float32Array(),indices:new Uint32Array()});
  const rng=generator(912731);
  // Paired ranks make grass fans. Several tillers share a crown; grazing,
  // blade age and seedling recruitment give neighbouring fans unlike heights.
  for(let crown=0;crown<13;crown++) {
    const a=TAU*rng(),radius=.26*Math.sqrt(rng());
    const center=[Math.cos(a)*radius,.003,Math.sin(a)*radius];
    const head=TAU*rng(),vigor=rng(),adult=crown%3!==0;
    for(let tiller=0;tiller<2;tiller++) {
      const line=head+.68*tiller+.40*(rng()-.5);
      const offset=tiller*(.014+.021*rng());
      const root=add(center,[Math.sin(line)*offset,0,-Math.cos(line)*offset]);
      const count=adult?3:2;
      for(let j=0;j<count;j++) {
        const age=(j+.16+.65*rng())/count;
        const direction=line+j*Math.PI+.54*(rng()-.5);
        const height=(adult?.155:.114)+vigor*.12+.096*rng();
        const reach=.050+age*(.155+.135*rng());
        const droop=.058+age*age*(.53+.26*rng());
        const breadth=(adult?.0029:.0017)+.0030*rng();
        tillerBlade(mesh,root,direction,height*(1.04-.15*age),reach,breadth,droop,
          (rng()-.5)*(.5+age*.86),grassPigment(.13+.67*age+.20*rng()));
      }
    }
  }
  // Old blades and broken sheaths sit below the living tips. The taller
  // forb communities are separate sparse patches, instead of a copy of
  // every forb underneath every turf instance.
  for(let i=0;i<4;i++) {
    const root=[(rng()-.5)*.43,.011,(rng()-.5)*.43];
    const age=rng();
    tillerBlade(mesh,root,TAU*rng(),.092+.057*rng(),.145+.13*rng(),
      .0026+.0012*rng(),.62+.19*rng(),(rng()-.5)*1.72,
      [.146+age*.084,.114+age*.043,.049+age*.016]);
  }
  return mesh.finish('Basal tillers, narrow recruits and spent grass blades');
}
