// Bounds are derived from the actual plant vertices before they are uploaded.
// Account for every orientation of the per-root, per-blade rotation, the close
// phenotype, bank width, wind at its supported maximum and the tangent plane.
export function meadowEnvelope(meshes, far=false) {
  let radius=0, height=0;
  for(const mesh of meshes) {
    for(let i=0;i<mesh.vertices.length;i+=12) {
      const v=mesh.vertices,material=v[i+9];
      let r=Math.hypot(v[i],v[i+2]),h=v[i+1];
      if(material%1>.05) {
        if(material<4.15) {
          r=Math.hypot(v[i+10],v[i+11])+Math.hypot(v[i]-v[i+10],v[i+2]-v[i+11]);
          h*=1.21;
        }
        r*=1.21;
      }
      radius=Math.max(radius,r);
      height=Math.max(height,h);
    }
  }
  // bladeHeight <= 1.5, wind weight = 0.75*bladeHeight², wind range 0–2.
  return {radius:radius*(far?2.8:1)+.82*height,height,wind:1.5**2*.75*2*Math.hypot(.07,.05)+.002,far};
}

const TILE=16, STRIDE=6;
export function buildMeadowTiles(data,envelope) {
  const count=data.length/8,side=Math.ceil(Math.sqrt(count)),cols=Math.ceil(side/TILE);
  const rows=Math.ceil(count/side/TILE),boxes=new Float64Array(rows*cols*STRIDE);
  for(let i=0;i<boxes.length;i+=STRIDE) {
    boxes[i]=boxes[i+1]=boxes[i+2]=Infinity;
    boxes[i+3]=boxes[i+4]=boxes[i+5]=-Infinity;
  }
  for(let i=0;i<count;i++) {
    const o=i*8,k=(Math.floor(i/side/TILE)*cols+Math.floor((i%side)/TILE))*STRIDE;
    const x=data[o],y=data[o+1],z=data[o+2],scale=data[o+3];
    const r=scale*envelope.radius+envelope.wind;
    const shear=r*(Math.abs(data[o+5])+Math.abs(data[o+6]-(envelope.far?4:0)));
    boxes[k]=Math.min(boxes[k],x-r);boxes[k+3]=Math.max(boxes[k+3],x+r);
    boxes[k+1]=Math.min(boxes[k+1],y-shear);boxes[k+4]=Math.max(boxes[k+4],y+shear+scale*envelope.height);
    boxes[k+2]=Math.min(boxes[k+2],z-r);boxes[k+5]=Math.max(boxes[k+5],z+r);
  }
  return boxes;
}
export function meadowPlanes(matrix,planes) {
  for(let axis=0;axis<3;axis++)for(let sign=0;sign<2;sign++) {
    const i=(axis*2+sign)*4;
    for(let c=0;c<4;c++)planes[i+c]=matrix[c*4+3]+(sign?-1:1)*matrix[c*4+axis];
  }
}
function classify(planes,x,y,z,rx,ry,rz) {
  let inside=2;
  for(let i=0;i<24;i+=4) {
    const a=planes[i],b=planes[i+1],c=planes[i+2];
    const center=a*x+b*y+c*z+planes[i+3];
    const extent=Math.abs(a)*rx+Math.abs(b)*ry+Math.abs(c)*rz;
    if(center+extent<0)return 0;
    if(center<extent)inside=1;
  }
  return inside;
}
export function makeMeadowBank(data,envelope,boxes=buildMeadowTiles(data,envelope)) {
  const side=Math.ceil(Math.sqrt(data.length/8)),cols=Math.ceil(side/TILE);
  return {data,envelope,boxes,side,cols,active:new Int32Array(cols),status:new Uint8Array(cols)};
}
export function visitMeadow(bank,eye,planes,visible,shadow) {
  const {data,side,cols,boxes,active,status,envelope}=bank;
  const [cx,,cz]=eye,far=envelope.far,limit=far?170*170:70*70;
  const count=data.length/8,lastRow=Math.ceil(count/side);
  let candidates=0;
  for(let row=0;row<lastRow;row+=TILE) {
    const band=Math.floor(row/TILE)*cols;
    let n=0;
    for(let col=0;col<cols;col++) {
      const i=(band+col)*STRIDE;
      const x0=boxes[i],y0=boxes[i+1],z0=boxes[i+2];
      const x1=boxes[i+3],y1=boxes[i+4],z1=boxes[i+5];
      if(x0>x1)continue;
      const dx=Math.max(x0-cx,cx-x1,0),dz=Math.max(z0-cz,cz-z1,0);
      const near2=dx*dx+dz*dz;
      if(near2>limit)continue;
      if(far&&Math.max(Math.abs(x0-cx),Math.abs(x1-cx))**2+Math.max(Math.abs(z0-cz),Math.abs(z1-cz))**2<1600)continue;
      const view=classify(planes,(x0+x1)*.5,(y0+y1)*.5,(z0+z1)*.5,(x1-x0)*.5,(y1-y0)*.5,(z1-z0)*.5);
      const cast=!far&&near2<144;
      if(view||cast){active[n]=col;status[n++]=view+(cast?4:0);}
    }
    // Preserve row-major submission order across adjacent tiles, including
    // equal-depth cutouts. Shadow-only tiles still visit the full caster disk.
    for(let z=row;z<Math.min(lastRow,row+TILE);z++)for(let a=0;a<n;a++) {
      const first=z*side+active[a]*TILE;
      const end=Math.min(count,(z+1)*side,first+TILE);
      const flags=status[a],view=flags&3;
      candidates+=Math.max(0,end-first);
      for(let i=first*8;i<end*8;i+=8) {
        if(data[i+3]<=0)continue;
        const x=data[i],y=data[i+1],pz=data[i+2],dx=x-cx,dz=pz-cz;
        const d=dx*dx+dz*dz;
        if((flags&4)&&d<144)shadow(i);
        if(!view||d>limit||(far&&d<1600))continue;
        if(view===1) {
          const scale=data[i+3],radius=scale*envelope.radius+envelope.wind;
          const h=.5*scale*envelope.height;
          const shear=radius*(Math.abs(data[i+5])+Math.abs(data[i+6]-(far?4:0)));
          if(!classify(planes,x,y+h,pz,radius,h+shear,radius))continue;
        }
        visible(i,d);
      }
    }
  }
  return candidates;
}
