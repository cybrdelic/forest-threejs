// The two geometric LODs are selected by apparent crown size at the fixed
// 50° field of view. Fine branches on a sapling resolve much nearer than
// branches on a mature tree. Leave a small dead band around each crossing.
const band=0.06;
function boundary(distance,previous,level) {
 if(previous===0)return distance;
 return distance*(previous<=level?1+band:1-band);
}
export function treeDetailLevel(distance,scale,width,hero,near,middle,previous=0) {
 const crownScale=Math.max(0.06,Math.min(1.14,scale*(0.88+0.24*width)));
 const nearLimit=hero?Math.max(180,near*crownScale):near*crownScale;
 if(distance<boundary(nearLimit,previous,1))return 1;
 if(distance<boundary(Math.max(nearLimit,middle*crownScale),previous,2))return 2;
 if(distance<boundary(750,previous,3))return 3;
 return 4;
}
export const treeLodWGSL=`
fn boundary(range:f32,previous:u32,level:u32)->f32 {
 if(previous==0u){return range;}
 return range*select(${1-band},${1+band},previous<=level);
}
fn treeDetailLevel(distance:f32,scale:f32,width:f32,hero:bool,near:f32,middle:f32,previous:u32)->u32 {
 let crownScale=clamp(scale*(0.88+0.24*width),0.06,1.14);
 let nearLimit=select(near*crownScale,max(180.0,near*crownScale),hero);
 if(distance<boundary(nearLimit,previous,1u)){return 1u;}
 if(distance<boundary(max(nearLimit,middle*crownScale),previous,2u)){return 2u;}
 if(distance<boundary(750.0,previous,3u)){return 3u;}
 return 4u;
}`;
