// Tight texel scale for nearby leaf shadows. The stand envelope continues
// through the rest of the explicit forest, including clearings.
export const SHADOW_HALF_WIDTH = 360;
export const SHADOW_CASTER_DISTANCE = 650;
export const LEAF_CASTER_DISTANCE = 80;

// The camera-distance gate also limits reliance on casters outside the
// detailed map. A second gate handles high relief and an oblique sun, which
// can place a nearby receiver near a light-frustum edge.
export const receiverLightingWGSL = /* wgsl */`
fn detailedShadowWeight(world:vec3<f32>)->f32 {
 let clip=u.lightVP*vec4<f32>(world,1.0);
 let edge=0.5-0.5*max(abs(clip.x),abs(clip.y));
 let radial=1.0-smoothstep(260.0,340.0,length(world.xz-u.camera.xz));
 return select(0.0,radial*smoothstep(0.0,0.05,edge),clip.z>0.0&&clip.z<1.0);
}
fn standDomainWeight(world:vec3<f32>)->f32 {
 return 1.0-smoothstep(1970.0,2000.0,max(abs(world.x),abs(world.z)));
}
fn receiverSun(world:vec3<f32>,sun:vec3<f32>,fine:f32,crown:f32,forest:f32,tree:bool)->f32 {
 let weight=detailedShadowWeight(world);
 var standVisibility=mix(1.0,0.10,forest);
 let domain=standDomainWeight(world);
 if(weight<1.0 && domain>0.0) {
  // The first metres of each tree ray are already represented by its own
  // crown model. Ground and grass start their queries at the receiver.
  standVisibility=mix(standVisibility,standSunVisibility(world,sun,select(0.0,8.0,tree)),domain);
 }
 // The near depth map contains the receiver tree itself. Its occlusion and
 // internal leaf extinction share a path. The distant atlas measures shelter
 // from neighboring crowns, which is independent of internal extinction.
 // Within the detailed caster disk the filtered map already samples this
 // tree's cutout shadows. Reimposing the mean interior extinction there
 // double-counts the brightest resolved gaps.
 let resolved=select(0.,1.-smoothstep(45.,65.,distance(world,u.camera.xyz)),tree);
 return mix(standVisibility*crown,mix(min(fine,crown),fine,resolved*.25),weight);
}`;

export const receiverLightingGLSL = /* glsl */`
float detailedShadowWeight(vec3 world){
 vec3 q=vShadow.xyz/vShadow.w;
 float edge=.5-.5*max(abs(q.x),abs(q.y));
 float radial=1.-smoothstep(260.,340.,distance(world.xz,uCamera.xz));
 return abs(q.z)<1.?radial*smoothstep(0.,.05,edge):0.;
}
float standDomainWeight(vec3 world){
 return 1.-smoothstep(1970.,2000.,max(abs(world.x),abs(world.z)));
}
float receiverSun(vec3 world,vec3 sun,float fine,float crown,float forest,bool tree){
 float weight=detailedShadowWeight(world),domain=standDomainWeight(world);
 float standVisibility=mix(1.,.1,forest);
 if(weight<1.&&domain>0.)standVisibility=mix(standVisibility,standSunVisibility(world,sun,tree?8.:0.),domain);
 float resolved=tree?1.-smoothstep(45.,65.,distance(world,uCamera)):0.;
 return mix(standVisibility*crown,mix(min(fine,crown),fine,resolved*.25),weight);
}`;
