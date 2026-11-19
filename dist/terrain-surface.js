import { meadowGapWGSL, meadowGapGLSL } from './meadow-gaps.js';

// The ground detail has a metric scale. Three independently rotated source
// samples remove the aligned periodic grass pattern. RGB sampling is linear
// through the sRGB texture-array view; tangent normals rotate back to world XZ.
export const terrainSurfaceWGSL = /* wgsl */`

${meadowGapWGSL}
struct GroundSurface {
 albedo:vec3<f32>, normal:vec3<f32>, leaf:vec3<f32>, lai:f32, occupied:f32, lay:f32, lean:vec2<f32>
};
fn pastureCanopy(ground:GroundSurface,terrainNormal:vec3<f32>,view:vec3<f32>,sun:vec3<f32>,shadow:f32,skyExposure:f32,groundRadiance:vec3<f32>)->vec3<f32> {
 let spreads=array<vec2<f32>,6>(vec2<f32>(.952,.306),vec2<f32>(.211,.978),vec2<f32>(-.741,.671),vec2<f32>(-.952,-.306),vec2<f32>(-.211,-.978),vec2<f32>(.741,-.671));
 let tangent=normalize(vec3<f32>(terrainNormal.y,-terrainNormal.x,0));
 let bitangent=cross(tangent,terrainNormal);
 let visibleDepth=.5/max(.09,abs(dot(terrainNormal,view)));
 let up=mix(.48,.82,ground.lay);let outwards=sqrt(1.-up*up);
 var viewProjection=0.;var sunProjection=0.;var direct=0.;var sky=vec3<f32>(0);var wax=vec3<f32>(0);
 for(var k=0;k<6;k++) {
  var normal=normalize(terrainNormal*up+tangent*(spreads[k].x*outwards+ground.lean.x)+bitangent*(spreads[k].y*outwards+ground.lean.y));
  let noV=dot(normal,view);let area=abs(noV);
  viewProjection+=area;sunProjection+=abs(dot(normal,sun));
  normal*=select(1.,-1.,noV<0.);
  let light=dot(normal,sun);
  direct+=area*(max(0.,light)+.48*max(0.,-light));
  sky+=area*(skyIrradiance(normal)+.48*skyIrradiance(-normal));
  let reflection=reflect(-view,normal);
  let exitCos=dot(reflection,terrainNormal);
  let reflSky=smoothstep(-.48,.62,exitCos)*visibleDepth/(visibleDepth+.5/max(.23,exitCos));
  let background=mix(groundRadiance,skyIrradiance(reflection),reflSky);
  wax+=area*surfaceEnvironment(background,area,.77);
 }
 let eyeDepth=viewProjection/(6.*max(.012,abs(dot(terrainNormal,view))));
 let sunDepth=sunProjection/(6.*max(.035,dot(terrainNormal,sun)));
 let optical=ground.lai;let visible=max(.0001,1.-exp(-optical*eyeDepth));
 let directVisibility=eyeDepth/(eyeDepth+sunDepth)*(1.-exp(-optical*(eyeDepth+sunDepth)))/visible;
 let skyVisibility=eyeDepth/(eyeDepth+.86)*(1.-exp(-optical*(eyeDepth+.86)))/visible;
 let reflected=ground.leaf*(.96*sky*skyVisibility*skyExposure+.96*sunlightOverPi(sun)*direct*directVisibility*shadow);
 let blades=(reflected+wax*skyVisibility*skyExposure)/max(.001,viewProjection);
 let soilSky=exp(-.86*optical);
 let soilSun=exp(-sunDepth*optical);
 let substrate=ground.albedo*.96*(skyIrradiance(terrainNormal)*skyExposure*soilSky
  +sunlightOverPi(sun)*max(0.,dot(terrainNormal,sun))*shadow*soilSun);
 return mix(groundRadiance,mix(substrate,blades,visible),ground.occupied);
}

fn groundHash(p:vec2<f32>)->vec3<f32> {
 let cell=vec2<u32>(vec2<i32>(p));
 var q=vec3<u32>(cell.x*1597334677u+cell.y*3812015801u)+vec3<u32>(32117u,51479u,104729u);
 q=(q^(q>>vec3<u32>(16u)))*2246822519u;
 q=(q^(q>>vec3<u32>(13u)))*3266489917u;
 return vec3<f32>((q^(q>>vec3<u32>(16u)))>>vec3<u32>(8u))/16777216.;
}
fn groundNoise(p:vec2<f32>)->f32 {
 let i=floor(p); let f=fract(p); let w=f*f*(3.0-2.0*f);
 return mix(mix(groundHash(i).x,groundHash(i+vec2<f32>(1,0)).x,w.x),mix(groundHash(i+vec2<f32>(0,1)).x,groundHash(i+vec2<f32>(1,1)).x,w.x),w.y);
}
fn groundFilteredNoise(p:vec2<f32>,footprint:f32)->f32 {
 return mix(groundNoise(p),0.5,smoothstep(0.28,0.85,footprint));
}
// A screen pixel on the far slope is an elongated strip. Integrate three
// positions along its major axis, preserving cross-slope bands that would
// disappear under isotropic filtering using its long dimension.
fn swardStructure(world:vec2<f32>,dx:vec2<f32>,dy:vec2<f32>)->vec3<f32> {
 let basis=mat2x2<f32>(vec2<f32>(.105,-.056),vec2<f32>(.0165,-.0458));
 let ax=basis*dx;let ay=basis*dy;
 let major=select(ay,ax,dot(ax,ax)>dot(ay,ay));let minor=select(ax,ay,dot(ax,ax)>dot(ay,ay));
 let residual=max(length(major)/3.,abs(major.x*minor.y-major.y*minor.x)/max(.0001,length(major)));
 // Tangled swaths elongate downslope, with locally crooked margins.
 let field=basis*world+vec2<f32>(87.,-34.);
 let p=field+1.12*(vec2<f32>(groundNoise(field*.39+14.),groundNoise(field*.43-39.))-.5);
 var value=vec3<f32>(0);
 for(var i=-1;i<=1;i++) {
  let q=p+major*(f32(i)/3.);let cell=floor(q);let f=fract(q);let w=f*f*(3.-2.*f);
  let a=groundHash(cell).y;let b=groundHash(cell+vec2<f32>(1,0)).y;
  let c=groundHash(cell+vec2<f32>(0,1)).y;let d=groundHash(cell+vec2<f32>(1)).y;
  let gradient=6.*f*(1.-f)*vec2<f32>(mix(b-a,d-c,w.y),mix(c-a,d-b,w.x));
  value+=vec3<f32>(mix(mix(a,b,w.x),mix(c,d,w.x),w.y),gradient);
 }
 return mix(value/3.,vec3<f32>(.5,0.,0.),smoothstep(.29,1.08,residual));
}
fn pastureSurface(world:vec3<f32>,baseNormal:vec3<f32>,dx:vec3<f32>,dy:vec3<f32>,meadow:f32,habitat:vec3<f32>)->GroundSurface {
 let litterUV=world.xz*0.5+vec2<f32>(0.37,0.59);
 let litter=textureSampleGrad(surfaceAlbedo,materialSampler,litterUV,1,dx.xz*0.5,dy.xz*0.5).rgb;
 let litterNormal=textureSampleGrad(surfaceNormal,materialSampler,litterUV,1,dx.xz*0.5,dy.xz*0.5).xy*2.0-1.0;
 let t=normalize(vec3<f32>(baseNormal.y,-baseNormal.x,0.0));
 let b=normalize(cross(t,baseNormal));
 var out:GroundSurface;
 if(meadow<=.005) {
  out.albedo=litter*.68;
  out.normal=normalize(baseNormal+.45*(t*litterNormal.x+b*litterNormal.y));
  return out;
 }
 let physicalUV=world.xz*0.5;
 let footprint=max(length(dx.xz),length(dy.xz));
 let skew=vec2<f32>(physicalUV.x-physicalUV.y*0.577350269,physicalUV.y*1.154700538);
 let cell=floor(skew);let f=fract(skew);
 var ids=array<vec2<f32>,3>(cell,cell+vec2<f32>(1,0),cell+vec2<f32>(0,1));
 var weight=vec3<f32>(1.0-f.x-f.y,f.x,f.y);
 if(f.x+f.y>1.0) {
  ids=array<vec2<f32>,3>(cell+vec2<f32>(1,1),cell+vec2<f32>(0,1),cell+vec2<f32>(1,0));
  weight=vec3<f32>(f.x+f.y-1.0,1.0-f.x,1.0-f.y);
 }
 // Sharper interpolation retains contrast within each source patch.
 weight=weight*weight*weight;weight/=dot(weight,vec3<f32>(1.0));
 var photo=vec3<f32>(0);var bump=vec2<f32>(0);
 for(var i=0u;i<3u;i++) {
  let random=groundHash(ids[i]);let angle=random.z*6.283185307;
  let c=cos(angle);let s=sin(angle);
  let rotated=vec2<f32>(c*physicalUV.x-s*physicalUV.y,s*physicalUV.x+c*physicalUV.y)+random.xy;
  let tx=vec2<f32>(c*dx.x-s*dx.z,s*dx.x+c*dx.z)*0.5;
  let ty=vec2<f32>(c*dy.x-s*dy.z,s*dy.x+c*dy.z)*0.5;
  photo+=textureSampleGrad(surfaceAlbedo,materialSampler,rotated,0,tx,ty).rgb*weight[i];
  let tangent=textureSampleGrad(surfaceNormal,materialSampler,rotated,0,tx,ty).xy*2.0-1.0;
  bump+=vec2<f32>(c*tangent.x+s*tangent.y,-s*tangent.x+c*tangent.y)*weight[i];
 }
 let warp=vec2<f32>(groundNoise(world.xz*0.0071+vec2<f32>(31,19)),groundNoise(world.xz*0.0063+vec2<f32>(71,-23)))-0.5;
 let terrainUV=world.xz+warp*48.0;
 let wet=groundFilteredNoise(terrainUV*0.014+vec2<f32>(18,61),footprint*0.014);
 let roots=groundFilteredNoise(terrainUV*0.052+vec2<f32>(59,-11),footprint*0.052);
 let tuft=groundFilteredNoise(terrainUV*0.217+vec2<f32>(-13,41),footprint*0.217);
 let fine=groundFilteredNoise(terrainUV*0.681+vec2<f32>(31,-91),footprint*0.681);
 let growth=swardStructure(terrainUV,dx.xz,dy.xz);
 let clipped=clamp(habitat.y+.51*(roots-.5)+.19*(tuft-.5)+.52*(growth.x-.5),0.,1.);
 let moisture=clamp(habitat.x+.41*(wet-.5)+.26*(roots-.5)-.31*(growth.x-.5),0.,1.);
 let dry=clamp(habitat.z+.41*(roots-.5)+.18*(tuft-.5)+.45*(growth.x-.5),0.,1.);
 // Separate measurements from the material arrays: mature blades (layers
 // 5 and 6), short green turf (layer 0), senescent blade pixels (5 and 6).
 let mature=mix(vec3<f32>(.107,.125,.019),vec3<f32>(.060,.096,.0095),moisture);
 let fresh=mix(vec3<f32>(.1341,.2341,.0260),vec3<f32>(.1229,.2526,.0192),moisture);
 let straw=vec3<f32>(.1844,.1511,.0317);
 let regrowth=clamp(.18+.63*clipped+.40*moisture-.29*dry,0.,1.);
 let litterFraction=smoothstep(.35,.94,dry+.13*(1.-clipped))*.38;
 let leaf=mix(mix(mature,fresh,regrowth),straw,litterFraction);
 let plantArea=mix(2.85,.86,clipped)+.72*moisture-.56*dry+.51*(tuft-.5);
 let gap=meadowSoilGap(world.xz,footprint);
 let exposed=clamp(.035+.31*clipped*dry+.12*smoothstep(.46,.89,tuft+dry*.23)+gap*.78,0.,.96);
 let photoRatio=clamp(photo/vec3<f32>(.1341,.2341,.0260),vec3<f32>(.38),vec3<f32>(2.12));
 let leafAlbedo=leaf*mix(vec3<f32>(1.),photoRatio,.59)*mix(.87,1.13,fine)*mix(.84,1.16,growth.x);
 let cover=smoothstep(0.005,0.70,meadow);
 // The washed forest-floor scan includes pale sticks. For exposed turf
 // soil, centre its detail on the darkest quartile of the scan and attenuate
 // the dry albedo as moisture increases. Forest litter keeps its own values.
 let soil=vec3<f32>(.0954,.0633,.0308)*clamp(litter/vec3<f32>(.1497,.1062,.0617),vec3<f32>(.3),vec3<f32>(1.8))*mix(.75,.40,moisture);
 let mat=mix(soil,photo*.47,.24+.20*moisture);
 out.albedo=mix(litter*.68,mix(mat,soil,exposed),cover);
 out.lean=vec2<f32>(.90*growth.y-.44*growth.z,.44*growth.y+.90*growth.z)*(.068+.048*dry);
 out.leaf=leafAlbedo;out.lai=max(.17,plantArea);
 out.occupied=1.-exposed;out.lay=clamp(.15+.60*clipped+.23*dry,0.,1.);
 let tangent=mix(litterNormal,bump,cover)*0.45;
 // A normal map stores a tangent slope. Reproject it onto the actual slope
 // instead of treating world Y as its local normal.
 out.normal=normalize(baseNormal+t*tangent.x+b*tangent.y);
 return out;
}
`;
export const terrainSurfaceGLSL = /* glsl */`

// Once individual blades are smaller than a pixel, integrate a finite stand
// of inclined leaves. Projected area weights the normals the eye can see. The
// depth integral uses both the eye and sun paths through the local stand.
${meadowGapGLSL}
struct GroundSurface {
 vec3 albedo;vec3 normal;vec3 leaf;float lai;float occupied;float lay;vec2 lean;
};
vec3 pastureCanopy(GroundSurface ground,vec3 terrainNormal,vec3 view,vec3 sun,float shadow,float skyExposure,vec3 groundRadiance) {
 const vec2 spreads[6]=vec2[](vec2(.952,.306),vec2(.211,.978),vec2(-.741,.671),vec2(-.952,-.306),vec2(-.211,-.978),vec2(.741,-.671));
 vec3 tangent=normalize(vec3(terrainNormal.y,-terrainNormal.x,0.));
 vec3 bitangent=cross(tangent,terrainNormal);
 float visibleDepth=.5/max(.09,abs(dot(terrainNormal,view)));
 float up=mix(.48,.82,ground.lay),outwards=sqrt(1.-up*up);
 float viewProjection=0.,sunProjection=0.,direct=0.;
 vec3 sky=vec3(0.),wax=vec3(0.);
 for(int k=0;k<6;k++) {
  vec3 normal=normalize(terrainNormal*up+tangent*(spreads[k].x*outwards+ground.lean.x)+bitangent*(spreads[k].y*outwards+ground.lean.y));
  float noV=dot(normal,view),noL=dot(normal,sun),area=abs(noV);
  viewProjection+=area;sunProjection+=abs(noL);
  normal*=noV<0.?-1.:1.;
  float light=dot(normal,sun);
  direct+=area*(max(0.,light)+.48*max(0.,-light));
  sky+=area*(skyIrradiance(normal)+.48*skyIrradiance(-normal));
  vec3 reflection=reflect(-view,normal);
  float exitCos=dot(reflection,terrainNormal);
  float reflSky=smoothstep(-.48,.62,exitCos)*visibleDepth/(visibleDepth+.5/max(.23,exitCos));
  vec3 background=mix(groundRadiance,skyIrradiance(reflection),reflSky);
  wax+=area*surfaceEnvironment(background,area,.77);
 }
 float eyeDepth=viewProjection/(6.*max(.012,abs(dot(terrainNormal,view))));
 float sunDepth=sunProjection/(6.*max(.035,dot(terrainNormal,sun)));
 float optical=ground.lai,visible=max(.0001,1.-exp(-optical*eyeDepth));
 float directVisibility=eyeDepth/(eyeDepth+sunDepth)*(1.-exp(-optical*(eyeDepth+sunDepth)))/visible;
 float skyVisibility=eyeDepth/(eyeDepth+.86)*(1.-exp(-optical*(eyeDepth+.86)))/visible;
 vec3 reflected=ground.leaf*(.96*sky*skyVisibility*skyExposure+.96*sunlightOverPi(sun)*direct*directVisibility*shadow);
 vec3 blades=(reflected+wax*skyVisibility*skyExposure)/max(.001,viewProjection);
 float soilSky=exp(-.86*optical),soilSun=exp(-sunDepth*optical);
 vec3 substrate=ground.albedo*.96*(skyIrradiance(terrainNormal)*skyExposure*soilSky
  +sunlightOverPi(sun)*max(0.,dot(terrainNormal,sun))*shadow*soilSun);
 return mix(groundRadiance,mix(substrate,blades,visible),ground.occupied);
}
vec3 groundHash(vec2 p) {
 uvec2 cell=uvec2(ivec2(p));
 uvec3 q=uvec3(cell.x*1597334677u+cell.y*3812015801u)+uvec3(32117u,51479u,104729u);
 q=(q^(q>>16u))*2246822519u;
 q=(q^(q>>13u))*3266489917u;
 return vec3((q^(q>>16u))>>8u)/16777216.;
}
float groundNoise(vec2 p) {
 vec2 i=floor(p),f=fract(p),w=f*f*(3.-2.*f);
 return mix(mix(groundHash(i).x,groundHash(i+vec2(1,0)).x,w.x),mix(groundHash(i+vec2(0,1)).x,groundHash(i+vec2(1,1)).x,w.x),w.y);
}
float groundFilteredNoise(vec2 p,float footprint) {
 return mix(groundNoise(p),.5,smoothstep(.28,.85,footprint));
}
vec3 swardStructure(vec2 world,vec2 dx,vec2 dy) {
 mat2 basis=mat2(.105,-.056,.0165,-.0458);
 vec2 ax=basis*dx,ay=basis*dy;
 bool longer=dot(ax,ax)>dot(ay,ay);vec2 major=longer?ax:ay,minor=longer?ay:ax;
 float residual=max(length(major)/3.,abs(major.x*minor.y-major.y*minor.x)/max(.0001,length(major)));
 vec2 field=basis*world+vec2(87.,-34.);
 vec2 p=field+1.12*(vec2(groundNoise(field*.39+14.),groundNoise(field*.43-39.))-.5);vec3 value=vec3(0.);
 for(int i=-1;i<=1;i++) {
  vec2 q=p+major*(float(i)/3.),cell=floor(q),f=fract(q),w=f*f*(3.-2.*f);
  float a=groundHash(cell).y,b=groundHash(cell+vec2(1,0)).y;
  float c=groundHash(cell+vec2(0,1)).y,d=groundHash(cell+vec2(1)).y;
  vec2 gradient=6.*f*(1.-f)*vec2(mix(b-a,d-c,w.y),mix(c-a,d-b,w.x));
  value+=vec3(mix(mix(a,b,w.x),mix(c,d,w.x),w.y),gradient);
 }
 return mix(value/3.,vec3(.5,0.,0.),smoothstep(.29,1.08,residual));
}
GroundSurface pastureSurface(vec3 world,vec3 baseNormal,vec3 dx,vec3 dy,float meadow,vec3 habitat) {
 vec2 litterUV=world.xz*.5+vec2(.37,.59);
 vec3 litter=textureGrad(uAlbedo,vec3(litterUV,1.),dx.xz*.5,dy.xz*.5).rgb;
 vec2 litterNormal=textureGrad(uSurfaceNormal,vec3(litterUV,1.),dx.xz*.5,dy.xz*.5).xy*2.-1.;
 vec3 t=normalize(vec3(baseNormal.y,-baseNormal.x,0.)),b=normalize(cross(t,baseNormal));
 GroundSurface result;
 if(meadow<=.005) {
  result.albedo=litter*.68;
  result.normal=normalize(baseNormal+.45*(t*litterNormal.x+b*litterNormal.y));
  result.lai=0.;result.occupied=0.;result.lay=0.;result.lean=vec2(0.);result.leaf=vec3(0.);
  return result;
 }
 vec2 physicalUV=world.xz*.5;
 float footprint=max(length(dx.xz),length(dy.xz));
 vec2 skew=vec2(physicalUV.x-physicalUV.y*.577350269,physicalUV.y*1.154700538),cell=floor(skew),f=fract(skew);
 vec2 ids[3]=vec2[](cell,cell+vec2(1,0),cell+vec2(0,1));vec3 weight=vec3(1.-f.x-f.y,f.x,f.y);
 if(f.x+f.y>1.) {ids=vec2[](cell+vec2(1,1),cell+vec2(0,1),cell+vec2(1,0));weight=vec3(f.x+f.y-1.,1.-f.x,1.-f.y);}
 weight=weight*weight*weight;weight/=dot(weight,vec3(1.));
 vec3 photo=vec3(0.);vec2 bump=vec2(0.);
 for(int i=0;i<3;i++) {
  vec3 random=groundHash(ids[i]);float angle=random.z*6.283185307,c=cos(angle),s=sin(angle);
  vec2 rotated=vec2(c*physicalUV.x-s*physicalUV.y,s*physicalUV.x+c*physicalUV.y)+random.xy;
  vec2 tx=vec2(c*dx.x-s*dx.z,s*dx.x+c*dx.z)*.5,ty=vec2(c*dy.x-s*dy.z,s*dy.x+c*dy.z)*.5;
  photo+=textureGrad(uAlbedo,vec3(rotated,0.),tx,ty).rgb*weight[i];
  vec2 tangent=textureGrad(uSurfaceNormal,vec3(rotated,0.),tx,ty).xy*2.-1.;
  bump+=vec2(c*tangent.x+s*tangent.y,-s*tangent.x+c*tangent.y)*weight[i];
 }
 vec2 warp=vec2(groundNoise(world.xz*.0071+vec2(31,19)),groundNoise(world.xz*.0063+vec2(71,-23)))-.5;
 vec2 terrainUV=world.xz+warp*48.;
 float wet=groundFilteredNoise(terrainUV*.014+vec2(18,61),footprint*.014);
 float roots=groundFilteredNoise(terrainUV*.052+vec2(59,-11),footprint*.052);
 float tuft=groundFilteredNoise(terrainUV*.217+vec2(-13,41),footprint*.217);
 float fine=groundFilteredNoise(terrainUV*.681+vec2(31,-91),footprint*.681);
 vec3 growth=swardStructure(terrainUV,dx.xz,dy.xz);
 float clipped=clamp(habitat.y+.51*(roots-.5)+.19*(tuft-.5)+.52*(growth.x-.5),0.,1.);
 float moisture=clamp(habitat.x+.41*(wet-.5)+.26*(roots-.5)-.31*(growth.x-.5),0.,1.);
 float dry=clamp(habitat.z+.41*(roots-.5)+.18*(tuft-.5)+.45*(growth.x-.5),0.,1.);
 vec3 mature=mix(vec3(.107,.125,.019),vec3(.060,.096,.0095),moisture);
 vec3 fresh=mix(vec3(.1341,.2341,.0260),vec3(.1229,.2526,.0192),moisture);
 vec3 straw=vec3(.1844,.1511,.0317);
 float regrowth=clamp(.18+.63*clipped+.40*moisture-.29*dry,0.,1.);
 float litterFraction=smoothstep(.35,.94,dry+.13*(1.-clipped))*.38;
 vec3 leaf=mix(mix(mature,fresh,regrowth),straw,litterFraction);
 float plantArea=mix(2.85,.86,clipped)+.72*moisture-.56*dry+.51*(tuft-.5);
 float gap=meadowSoilGap(world.xz,footprint);
 float exposed=clamp(.035+.31*clipped*dry+.12*smoothstep(.46,.89,tuft+dry*.23)+gap*.78,0.,.96);
 vec3 photoRatio=clamp(photo/vec3(.1341,.2341,.0260),vec3(.38),vec3(2.12));
 vec3 leafAlbedo=leaf*mix(vec3(1.),photoRatio,.59)*mix(.87,1.13,fine)*mix(.84,1.16,growth.x);
 float cover=smoothstep(.005,.70,meadow);
 vec3 soil=vec3(.0954,.0633,.0308)*clamp(litter/vec3(.1497,.1062,.0617),vec3(.3),vec3(1.8))*mix(.75,.40,moisture);
 vec3 mat=mix(soil,photo*.47,.24+.20*moisture);
 result.albedo=mix(litter*.68,mix(mat,soil,exposed),cover);
 result.lean=vec2(.90*growth.y-.44*growth.z,.44*growth.y+.90*growth.z)*(.068+.048*dry);
 result.leaf=leafAlbedo;result.lai=max(.17,plantArea);
 result.occupied=1.-exposed;result.lay=clamp(.15+.60*clipped+.23*dry,0.,1.);
 vec2 tangent=mix(litterNormal,bump,cover)*.45;
 result.normal=normalize(baseNormal+t*tangent.x+b*tangent.y);
 return result;
}
`;
