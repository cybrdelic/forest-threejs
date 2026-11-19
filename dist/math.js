export const normalize = v => { const length = Math.hypot(...v) || 1; return v.map(x => x / length); };
export const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export function multiply(a,b) {
 const out=new Float32Array(16);
 for(let col=0;col<4;col++) for(let row=0;row<4;row++) {
  for(let k=0;k<4;k++) out[col*4+row]+=a[k*4+row]*b[col*4+k];
 }
 return out;
}
export function perspective(fov,aspect,near,far) {
 const f=1/Math.tan(fov/2), range=1/(near-far);
 return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,far*range,-1,0,0,near*far*range,0]);
}
export function lookAt(eye,target,up=[0,1,0]) {
 const z=normalize(eye.map((v,i)=>v-target[i]));
 const x=normalize(cross(up,z)),y=cross(z,x);
 return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
}
export function orthographic(left,right,bottom,top,near,far) {
 return new Float32Array([2/(right-left),0,0,0,0,2/(top-bottom),0,0,0,0,1/(near-far),0,-(right+left)/(right-left),-(top+bottom)/(top-bottom),near/(near-far),1]);
}
export function inverse(a, ArrayType = Float32Array) {
 const m=Array.from({length:4},(_,r)=>Array.from({length:8},(_,c)=>c<4?a[c*4+r]:+(c-4===r)));
 for(let c=0;c<4;c++) {
  let pivot=c;
  for(let r=c+1;r<4;r++) if(Math.abs(m[r][c])>Math.abs(m[pivot][c])) pivot=r;
  [m[c],m[pivot]]=[m[pivot],m[c]];
  const d=m[c][c];
  for(let j=0;j<8;j++) m[c][j]/=d;
  for(let r=0;r<4;r++) if(r!==c) { const f=m[r][c]; for(let j=0;j<8;j++) m[r][j]-=f*m[c][j]; }
 }
 return new ArrayType(Array.from({length:16},(_,i)=>m[i%4][4+Math.floor(i/4)]));
}
