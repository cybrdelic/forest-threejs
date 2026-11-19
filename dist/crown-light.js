// Each vertex holds the transmission through the authored crown above it.
// Interpolate the incident direction in local tree space; camera motion has
// no influence on the sample. The final byte marks this packed mesh format.
export const crownTransferWGSL = /* wgsl */`
fn readVisibility(samples:vec3<u32>, i:u32)->f32 {
 return f32((samples[i/3u] >> ((i%3u)*8u)) & 255u)/255.0;
}
fn measuredCrownVisibility(encoded:vec3<f32>,sun:vec3<f32>,yaw:f32,width:f32)->vec2<f32> {
 let c=cos(yaw); let s=sin(yaw);
 let d=normalize(vec3<f32>((sun.x*c-sun.z*s)/width,sun.y,(sun.x*s+sun.z*c)/width));
 let packed=vec3<u32>(encoded);
 let horizontal=max(dot(d.xz,d.xz),1e-7);
 var azimuth=0.0;
 if(horizontal>1e-6) {azimuth=atan2(d.x,d.z);}
 let sector=fract(azimuth/6.283185307+1.0)*6.0;
 let index=u32(floor(sector))%6u;
 let ring=mix(readVisibility(packed,index),readVisibility(packed,(index+1u)%6u),fract(sector));
 let direct=mix(ring,readVisibility(packed,6u),clamp((d.y-0.587785)/0.412215,0.0,1.0));
 return vec2<f32>(readVisibility(packed,7u),direct);
}
`;
export const crownTransferGLSL = /* glsl */`
float readVisibility(uvec3 samples,uint i) {
 return float((samples[int(i/3u)] >> ((i%3u)*8u)) & 255u)/255.;
}
vec2 measuredCrownVisibility(vec3 encoded,vec3 sun,float yaw,float width) {
 float c=cos(yaw),s=sin(yaw);
 vec3 d=normalize(vec3((sun.x*c-sun.z*s)/width,sun.y,(sun.x*s+sun.z*c)/width));
 uvec3 packedValues=uvec3(encoded);
 float azimuth=dot(d.xz,d.xz)>1e-6?atan(d.x,d.z):0.;
 float sector=fract(azimuth/6.283185307+1.)*6.;
 uint index=uint(floor(sector))%6u;
 float ring=mix(readVisibility(packedValues,index),readVisibility(packedValues,(index+1u)%6u),fract(sector));
 float direct=mix(ring,readVisibility(packedValues,6u),clamp((d.y-.587785)/.412215,0.,1.));
 return vec2(readVisibility(packedValues,7u),direct);
}
`;

// Atlas-coverage-weighted linear means of the two photographed source crowns.
// The pigment varies optical path about these measured means, in leaf space,
// so material identity and the per-tree phenotype survive the LOD transition.
export const crownSurfaceWGSL = /* wgsl */`
// A lower-hemisphere Lambertian ground patch contributes (1 - n.y)/2.
// Solar diffuse bounce was absent from the sky harmonics (their lower half
// represents sky-lit ground). The neighboring foliage term integrates the
// projected area of randomly oriented two-sided leaves, E[max(n.L,0)]=1/4.
fn crownSolarBounce(ny:f32,aperture:f32,internalSun:f32,irradiance:vec3<f32>,sunY:f32,standOpen:f32)->vec3<f32> {
 let open=clamp(aperture,0.,1.);
 let ground=vec3<f32>(.075,.10,.035)*sunY*(.5-.5*ny)*open*standOpen;
 let leaf=vec3<f32>(.15760,.19451,.05302)*.25*1.32;
 let incident=sqrt(clamp(internalSun,0.,1.));
 return irradiance*(ground+leaf*(1.-open)*incident)*standOpen;
}
fn treeLeafPigment(phenotype:f32,jacaranda:bool)->vec3<f32> {
 let source=select(vec3<f32>(.12612,.18051,.04922),vec3<f32>(.18908,.20851,.05683),jacaranda);
 let pathVariation=(.5-smoothstep(.20,.80,phenotype))*.30;
 return exp(log(source)*pathVariation);
}
fn crownSkylight(aperture:f32)->vec3<f32> {
 let open=clamp(aperture,0.,1.);
 // One diffuse interaction at the neighboring canopy, from the same
 // measured pigments and leaf transmission ratio as the surface BSDF.
 let leafScatter=1.32*vec3<f32>(.15760,.19451,.05302);
 return vec3<f32>(open)+(1.-open)*leafScatter*sqrt(open);
}
`;
export const crownSurfaceGLSL = /* glsl */`
vec3 crownSolarBounce(float ny,float aperture,float internalSun,vec3 irradiance,float sunY,float standOpen) {
 float openSky=clamp(aperture,0.,1.);
 vec3 ground=vec3(.075,.10,.035)*sunY*(.5-.5*ny)*openSky*standOpen;
 vec3 leaf=vec3(.15760,.19451,.05302)*.25*1.32;
 float incident=sqrt(clamp(internalSun,0.,1.));
 return irradiance*(ground+leaf*(1.-openSky)*incident)*standOpen;
}
vec3 treeLeafPigment(float phenotype,bool jacaranda) {
 vec3 source=jacaranda?vec3(.18908,.20851,.05683):vec3(.12612,.18051,.04922);
 float pathVariation=(.5-smoothstep(.20,.80,phenotype))*.30;
 return exp(log(source)*pathVariation);
}
vec3 crownSkylight(float aperture) {
 float openSky=clamp(aperture,0.,1.);
 vec3 leafScatter=1.32*vec3(.15760,.19451,.05302);
 return vec3(openSky)+(1.-openSky)*leafScatter*sqrt(openSky);
}
`;
