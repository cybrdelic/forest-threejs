// Store the previous-pose screen displacement in the unused alpha channel of
// the multisampled HDR buffer. Both components share one finite, normalized
// binary16 word. Subpixel movement gets the finest steps. A zero alpha marks
// sky, terrain, impostors and stationary leaves. Never average packed words.
export const motionFormat = 'rg16float';

export const motionPackingWGSL = /* wgsl */`
fn packFoliageMotion(pixels:vec2<f32>)->f32 {
 if(any(abs(pixels)>vec2<f32>(32.0))) {return -1.0;}
 let magnitude=sqrt(clamp(abs(pixels)/32.0,vec2<f32>(0.0),vec2<f32>(1.0)));
 let signedCode=vec2<i32>(round(sign(pixels)*magnitude*63.0));
 if(all(signedCode==vec2<i32>(0))) {return 0.0;}
 let code=vec2<u32>(signedCode+vec2<i32>(63));
 return unpack2x16float(0x400u+code.x+(code.y<<7u)).x;
}
fn unpackFoliageMotion(word:f32)->vec2<f32> {
 if(word<0.0) {return vec2<f32>(65504.0);}
 if(word==0.0) {return vec2<f32>(0.0);}
 let bits=(pack2x16float(vec2<f32>(word,0.0))&65535u)-0x400u;
 let signedCode=(vec2<f32>(f32(bits&127u),f32((bits>>7u)&127u))-63.0)/63.0;
 return sign(signedCode)*signedCode*signedCode*32.0;
}`;

// Compute the animated difference before adding a large world-space origin.
// For both positions use the *previous* camera. The temporal resolve adds its
// independent camera/depth reprojection exactly once.
export const foliageWindWGSL = /* wgsl */`
fn windOffset(root:vec3<f32>,height:f32,bend:f32,time:f32,strength:f32)->vec2<f32> {
 return vec2<f32>(
  sin(time*1.3+root.x*0.12+root.z*0.09+height*0.7)*0.07,
  cos(time*0.9+root.z*0.13+height)*0.05
 )*(bend*strength);
}
fn projectedWindDelta(world:vec3<f32>,worldDelta:vec3<f32>)->vec2<f32> {
 let clip=u.previousVP*vec4<f32>(world,1.0);
 let delta=u.previousVP*vec4<f32>(worldDelta,0.0);
 if(min(clip.w,clip.w+delta.w)<=0.001){return vec2<f32>(65504.0);}
 // Algebraic difference of NDC positions avoids subtracting two close UVs.
 return (delta.xy-clip.xy*(delta.w/clip.w))/(clip.w+delta.w)
   *u.resolution.xy*vec2<f32>(0.5,-0.5);
}`;
