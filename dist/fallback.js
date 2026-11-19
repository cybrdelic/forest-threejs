import {createGLHedgerow,prepareHedgerow} from './hedgerow.js';
import { reliefGLSL, glStandRelief } from './stand-relief.js';
import {createCoverageTarget} from './gl-coverage-target.js';
import { materialBytes } from './materials.js';
import { treeDetailLevel } from './tree-lod.js';
import { outerLightGLSL } from './aggregate-canopy.js';
import {meadowEnvelope,makeMeadowBank,meadowPlanes,visitMeadow} from './meadow-cull.js';
import { surfaceLightGLSL, glSurfaceDFG } from './surface-light.js';
import {terrainSurfaceGLSL} from './terrain-surface.js';
import { buildTerrainVisibility, treeBehindTerrain } from './terrain-visibility.js';
import { glSkyDetail } from './sky-detail.js';
import { crownTransferGLSL, crownSurfaceGLSL } from './crown-light.js';
import { getGLStandTexture, standLightingGLSL } from './stand-envelope.js';
import { receiverLightingGLSL, SHADOW_HALF_WIDTH, SHADOW_CASTER_DISTANCE, LEAF_CASTER_DISTANCE } from './forest-shadow.js';
import { cloudLightGLSL, aerialGLSL, glCloudMask } from './weather-light.js';
import { plantShadowGLSL } from './plant-shadow.js';
import { createLandscape, createTreeInstances, createGrassInstances, createCanopyProxy, terrainHeight, terrainSurfaceHeight } from './landscape.js';
import { loadMeadowGeometry, closeMeadow } from './meadow.js';
import { loadRealTreeGeometry } from './geometry-assets.js';
import { layeredCoverageGLSL, shootPhaseGLSL } from './sample-coverage.js';
import { createGLTreeImpostors } from './impostors.js';
import { skyIrradianceGLSL } from './shaders.js';
import { updateStats } from './controls.js';
import { multiply, perspective, lookAt, orthographic, inverse } from './math.js';

const treeLevels = ['near', 'mid', 'voxel', 'far'];

const geometryVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aExtra;
layout(location=4) in vec4 aTransform;
layout(location=5) in vec4 aVariation;
uniform mat4 uViewProjection;
uniform mat4 uLightProjection;
uniform bool uInstanced;
uniform float uTime;
uniform float uWind;
uniform vec3 uCamera;
uniform vec3 uSun;
out vec2 vCrownLight;
flat out float vCoveragePhase;
${shootPhaseGLSL}
out vec3 vPosition;
out vec3 vNormal;
out vec3 vColor;
out vec3 vExtra;
out float vHeight;
out float vSeed;
out vec4 vShadow;
float crownExitBounds(vec3 local,vec3 direction,vec3 center,vec3 radius) {
  vec3 p=(local-center)/radius,d=direction/radius;
  float a=dot(d,d),b=dot(p,d),c=dot(p,p)-1.0;
  float discriminant=b*b-a*c;
  if(discriminant<0.0)return 0.0;
  float root=sqrt(discriminant);
  return max(0.0,(-b+root)/a-max(0.0,(-b-root)/a));
}
${crownTransferGLSL}
${crownSurfaceGLSL}
vec2 crownVisibility(vec3 local,float yaw,float material) {
  float c=cos(yaw),s=sin(yaw);
  vec3 localSun=vec3(uSun.x*c-uSun.z*s,uSun.y,uSun.x*s+uSun.z*c);
  bool oak=material>4.5&&material<5.5;
  vec3 center=oak?vec3(0.522748,10.568585,2.672641):vec3(-0.711726,10.859104,-0.376526);
  vec3 radius=oak?vec3(5.104225,5.380008,7.511835):vec3(12.208525,8.609772,9.577288);
  return exp(-vec2(crownExitBounds(local,vec3(0.0,1.0,0.0),center,radius),crownExitBounds(local,localSun,center,radius))*vec2(0.105,0.145));
}
${outerLightGLSL}
void main() {
  vec3 position = aPosition;
  if(!uInstanced&&aExtra.x==2.&&aExtra.y== -2.)position.y-=(aExtra.z+.25)*(1.-smoothstep(210.,425.,distance(position.xz,uCamera.xz)));
  vec3 normal = aNormal;
  vec3 color = aColor;
  vHeight = aPosition.y;
  vSeed = aVariation.w;
  bool isPlant=(aExtra.x>2.5&&aExtra.x<4.5)||aExtra.x>6.5;
  bool isTree=aExtra.x<2.5||(aExtra.x>4.5&&aExtra.x<6.5);
  vCrownLight = uInstanced && isTree ? crownVisibility(aPosition,aVariation.x,aExtra.x) : vec2(1.0);
  if(uInstanced && aColor.z>16000000.) {
    vCrownLight=measuredCrownVisibility(aColor,uSun,aVariation.x,0.78+aVariation.z*0.48);
    color=vec3(1.);
  }
  if(!uInstanced && aExtra.x>1.5) {
    vCrownLight=aExtra.y>=0.?outerCanopyLight(aExtra.yz,uSun):vec2(.32,.20);
  }
  if (uInstanced) {
    float lodgingStep=isPlant?floor(aVariation.x*.125):0.;
    float yaw=aVariation.x-8.*lodgingStep, lodging=lodgingStep/15.;
    float cosine = cos(yaw), sine = sin(yaw);
    mat2 rotation = mat2(cosine, -sine, sine, cosine);
    if(isPlant&&fract(aExtra.x)>.05) {
      float phenotype=fract(sin(dot(aTransform.xz,vec2(17.13,41.71)))*9173.17);
      vec2 shape=vec2(.82+phenotype*.39,1.21-phenotype*.38);
      if(aExtra.x<4.15) {
        float leafSeed=fract(sin(dot(aExtra.yz+aTransform.xz,vec2(63.31,17.93)))*7163.29);
        float turn=(leafSeed-.5)*1.3;
        vec2 anchor=aExtra.yz;
        vec2 delta=position.xz-anchor;
        position.xz=anchor+mat2(cos(turn),-sin(turn),sin(turn),cos(turn))*delta;
        position.y*=.76+leafSeed*.45;
        normal.xz=mat2(cos(turn),-sin(turn),sin(turn),cos(turn))*normal.xz;
        normal.y/=.76+leafSeed*.45;
      }
      position.xz*=shape;
      normal.xz/=shape;
    }
    position.xz = rotation * position.xz;
    normal.xz = rotation * normal.xz;
    position *= aTransform.w;
    if((aExtra.x>6.5&&aExtra.x<8.5)||(aExtra.x>3.5&&aExtra.x<4.5)) {
      float opticalDepth=1.15*clamp(1.0-aPosition.y/0.34,0.0,1.0);
      vCrownLight=exp(-vec2(opticalDepth,opticalDepth/max(uSun.y,0.18)));
    }
    float horizontalScale=isTree?0.78+aVariation.z*0.48:(aVariation.z>1.5?2.8:1.0);
    normal.y*=horizontalScale;
    if(isTree) position.xz*=horizontalScale;
    if(isPlant) {
      float grassDistance=distance(aTransform.xyz,uCamera);
      if(aVariation.z>1.5) {
        position.xz*=2.8;
        position.y*=smoothstep(40.0,70.0,grassDistance)*(1.0-smoothstep(120.0,170.0,grassDistance));
      } else position.y*=1.0-smoothstep(40.0,70.0,grassDistance);
    }
    if(isPlant) {
      float plantDistance=distance(aTransform.xyz,uCamera);
      if(fract(aExtra.x)>.05) {
        position.y*=1.-smoothstep(8.,12.,plantDistance);
      } else if(aExtra.x>6.5&&aExtra.x<8.5) {
        position.y*=smoothstep(7.,11.,plantDistance);
      }
    }
    float phase = uTime * 1.2 + aTransform.x * 0.11 + aTransform.z * 0.17;
    float bladeHeight=clamp(position.y/0.55,0.0,1.5);
    float windWeight = isPlant ? bladeHeight*bladeHeight*0.75 : aExtra.x>4.5 ? 0.5+position.y*0.02 : aExtra.y;
    position.x += sin(phase + position.y * 0.25) * windWeight * uWind * 0.07;
    position.z += cos(phase * 0.73 + position.y * 0.3) * windWeight * uWind * 0.05;
    if(isPlant) {
      vec2 lay=vec2(cosine,-sine);
      float shear=.82*lodging, upright=1.-.66*lodging;
      position.xz+=lay*(shear*position.y);
      position.y*=upright;
      normal.y=(normal.y-shear*dot(lay,normal.xz))/upright;
      float gradientX=aVariation.y;
      float gradientZ=aVariation.z-(aVariation.z>1.5?4.0:0.0);
      position.y+=gradientX*position.x+gradientZ*position.z;
      normal=vec3(normal.x-gradientX*normal.y,normal.y,normal.z-gradientZ*normal.y);
    }
    position += aTransform.xyz;
    if(isPlant){
      float vigor=smoothstep(0.19,0.84,fract(aVariation.w*4.0));
      color*=mix(vec3(0.83,0.78,0.68),vec3(1.04,1.09,1.03),vigor);
      if(aExtra.x>8.5)color=aColor;
    } else if(aExtra.x>4.5&&aExtra.x<6.5) {
      color=treeLeafPigment(aVariation.y,aExtra.x>5.5);
    } else if(aColor.z<=16000000.) color *= mix(vec3(0.83, 0.92, 0.76), vec3(1.13, 1.06, 0.95), aVariation.y);
  }
  vPosition = position;
  vNormal = normal;
  vColor = color;
  vExtra = aExtra;
  vCoveragePhase=shootPhase(aVariation.w,aPosition,aExtra.yz);
  vShadow = uLightProjection * vec4(position, 1.0);
  gl_Position = uViewProjection * vec4(position, 1.0);
}`;

const geometryFragment = multisampled => `#version 300 es
precision highp float;
precision highp int;
in vec3 vPosition;
in vec3 vNormal;
in vec3 vColor;
in vec3 vExtra;
in float vHeight;
in float vSeed;
in vec4 vShadow;
in vec2 vCrownLight;
flat in float vCoveragePhase;
${layeredCoverageGLSL}
uniform vec3 uCamera;
uniform vec3 uSun;
${skyIrradianceGLSL}
${plantShadowGLSL}
${surfaceLightGLSL}
${crownSurfaceGLSL}
${cloudLightGLSL}
${aerialGLSL}
uniform highp sampler2DShadow uShadow;
uniform mat4 uLightProjection;
uniform sampler2D uCanopy;
uniform highp sampler2D standEnvelope;
${standLightingGLSL}
${receiverLightingGLSL}
uniform highp sampler2DArray uAlbedo;
uniform highp sampler2DArray uSurfaceNormal;
uniform int uDebug;
uniform int uDetail;
${terrainSurfaceGLSL}
${reliefGLSL}
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
vec3 tonemap(vec3 x) {
  x = max(vec3(0.0), x);
  return pow(clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0),vec3(1.0/2.2));
}
float shadowAmount() {
  vec2 offset=vPosition.xz-uCamera.xz;
  if(dot(offset,offset)>340.*340.)return 1.;
  vec3 facing=normalize(vNormal);
  facing*=dot(facing,uSun)>=0.?1.:-1.;
  vec4 shifted=uLightProjection*vec4(vPosition+facing*.045,1.);
  vec3 p=shifted.xyz/shifted.w*.5+.5;
  if (min(p.x,p.y) < 0.002 || max(p.x,p.y)>0.998 || p.z>1.0) return 1.0;
  float result = 0.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) {
    result += texture(uShadow,vec3(p.xy+vec2(x,y)*1.6/4096.0,p.z-.000055));
  }
  float edge = smoothstep(0.0,0.07,min(min(p.x,p.y),min(1.0-p.x,1.0-p.y)));
  return mix(1.0,result/9.0,edge);
}
void main() {
  vec3 n = normalize(vNormal);
  if(!gl_FrontFacing && vExtra.x!=2.) n = -n;
  float distanceToCamera = distance(vPosition,uCamera);
  float leaf = step(1.5,vExtra.x);
  bool grassBlade=(vExtra.x>2.5&&vExtra.x<4.5)||vExtra.x>6.5;
  bool treeSurface=vExtra.x<2.5||(vExtra.x>4.5&&vExtra.x<6.5);
  float ground = 1.0-step(0.5,vExtra.x);
  float canopy = texture(uCanopy,vPosition.xz/4000.0+0.5).r;
  float ambient = mix(0.46,0.86,smoothstep(0.0,15.0,vHeight));
  ambient = mix(ambient,1.0-canopy*0.74,ground);
  vec3 gradientX=dFdx(vPosition);
  vec3 gradientY=dFdy(vPosition);
  vec2 leafGradientX=dFdx(vExtra.yz);
  vec2 leafGradientY=dFdy(vExtra.yz);
  float standAperture=1.;
  if(vExtra.x==2.) {
    vec4 relief=crownRelief(n,vPosition.xz,gradientX.xz,gradientY.xz,vExtra.y<0.?1./141.:1./256.);
    n=relief.xyz;standAperture=relief.w;
  }
  float coverage=1.;
  float unresolvedSlope=0.;
  GroundSurface groundSurface;
  vec3 albedo = vColor * 0.85;
  if (vExtra.x < 0.5) {
    groundSurface=pastureSurface(vPosition,n,gradientX,gradientY,clamp(vExtra.z,0.,1.),vColor);
    albedo=groundSurface.albedo;
    n=groundSurface.normal;
  } else if (vExtra.x < 1.5) {
    vec2 uv = vec2(vPosition.x+vPosition.z,vPosition.y)*vec2(1.5,0.65);
    vec2 dx=vec2(gradientX.x+gradientX.z,gradientX.y)*vec2(1.5,0.65);
    vec2 dy=vec2(gradientY.x+gradientY.z,gradientY.y)*vec2(1.5,0.65);
    albedo = textureGrad(uAlbedo,vec3(uv,2.0),dx,dy).rgb*0.9;
    vec3 surfaceNormal = textureGrad(uSurfaceNormal,vec3(uv,2.0),dx,dy).xyz*2.0-1.0;
    vec3 tangent = abs(n.y)>0.98?vec3(1.0,0.0,0.0):normalize(vec3(n.z,0.0,-n.x));
    vec3 bitangent = normalize(cross(n,tangent));
    n = normalize(tangent*surfaceNormal.x*0.55+bitangent*surfaceNormal.y*0.55+n*max(surfaceNormal.z,0.2));
  }
  if(vExtra.x>4.5) {
    float leafLayer=floor(vExtra.x+0.1)-2.0;
    vec4 photographed=textureGrad(uAlbedo,vec3(vExtra.yz,leafLayer),leafGradientX,leafGradientY);
    vec4 normalMask=textureGrad(uSurfaceNormal,vec3(vExtra.yz,leafLayer),leafGradientX,leafGradientY);
    ${multisampled?'float footprint=512.*max(length(leafGradientX),length(leafGradientY)); coverage=layeredCoverage(normalMask.a,vCoveragePhase,mix(1.,.22,smoothstep(1.,4.,footprint))); if(coverage<=0.)discard;':'if(photographed.a<.5)discard;'}
    vec3 leafColor=photographed.rgb/max(normalMask.a,1./255.);
    albedo=leafColor*vColor*(grassBlade?1.:.85);
    if(vExtra.x>8.5 && vColor.r<0.99) {
      float neutral=dot(leafColor,vec3(0.2126,0.7152,0.0722));
      albedo=mix(leafColor,vec3(neutral),0.17)*vColor;
    }
    {
      vec3 mapNormal=(normalMask.xyz*2.-1.-vec3(0.,0.,1.-normalMask.a))/max(normalMask.a,1./255.);
      // The calibrated first moment retains subpixel leaflet folds. For a
      // narrow lobe 2*(1-R) estimates angular variance about its mean.
      unresolvedSlope=.65*.65*max(0.,2.*(1.-min(1.,length(mapNormal))));
      vec3 dp2perp=cross(gradientY,n),dp1perp=cross(n,gradientX);
      vec3 tangent=dp2perp*leafGradientX.x+dp1perp*leafGradientY.x;
      vec3 bitangent=dp2perp*leafGradientX.y+dp1perp*leafGradientY.y;
      float norm=max(max(dot(tangent,tangent),dot(bitangent,bitangent)),0.000001);
      n=normalize((tangent*mapNormal.x+bitangent*mapNormal.y)*inversesqrt(norm)*0.65+n*max(mapNormal.z,0.15));
    }
  }
  vec3 view=normalize(uCamera-vPosition);
  if(vExtra.x>2.5&&dot(n,view)<0.)n=-n;
  float forest=ground*clamp(vExtra.y,0.0,1.0);
  bool modeledTree=treeSurface&&vExtra.x>0.5&&!(vExtra.x>1.5&&vExtra.x<2.5);
  float innerCrown=grassBlade?mix(0.2,1.,vCrownLight.y):vCrownLight.y;
  float shadow=receiverSun(vPosition,uSun,shadowAmount(),innerCrown,forest,modeledTree);
  shadow = min(shadow,nearPlantSun(vPosition,n));
  float cloudLight=cloudSunVisibility(vPosition,uSun);
  shadow *= cloudLight;
  float occlusion = mix(0.62,1.0,ambient);
  float domain=standDomainWeight(vPosition);
  if((ground>0.5||modeledTree)&&domain>0.)occlusion=min(occlusion,mix(1.,standSkyVisibility(vPosition),domain));
  float outsideShelter=occlusion;
  occlusion*=ground>0.5?mix(mix(1.,.28,forest),1.,domain):mix(0.26,1.0,vCrownLight.x);
  vec3 skyLight = skyIrradiance(n);
  vec3 internalSky=modeledTree?outsideShelter*crownSkylight(vCrownLight.x):vec3(occlusion);
  vec3 ambientLight=skyLight*internalSky*standAperture;
  vec3 ambientBack=skyIrradiance(-n)*internalSky*standAperture;
  if(modeledTree) {
    vec3 sunIrradiance=sunlightOverPi(uSun)*cloudLight;
    ambientLight+=crownSolarBounce(n.y,vCrownLight.x,vCrownLight.y,sunIrradiance,uSun.y,outsideShelter);
    ambientBack+=crownSolarBounce(-n.y,vCrownLight.x,vCrownLight.y,sunIrradiance,uSun.y,outsideShelter);
  }
  if(grassBlade) {
    vec3 backSky=skyIrradiance(-n);
    ambientLight=skyLight*(1.0-canopy*0.52)*mix(0.25,1.0,vCrownLight.x);
    ambientBack=backSky*(1.0-canopy*0.52)*mix(0.25,1.0,vCrownLight.x);
  }
  float diffuseTransmission=vExtra.x>1.5?(grassBlade?.50:.32):0.;
  float roughness=ground>.5?.91:(vExtra.x>1.5?min(1.,sqrt(sqrt(.18974736+unresolvedSlope))):.85);
  vec3 reflection=reflect(-view,n);
  vec3 reflectedSky=skyIrradiance(reflection)*internalSky;
  if(ground>.5&&vExtra.z>.01) {
    float section=groundSurface.occupied*smoothstep(.01,.75,vExtra.z)*(1.-smoothstep(105.,170.,distanceToCamera));
    float skyPass=mix(1.,exp(-.86*groundSurface.lai),section);
    vec3 bounce=groundSurface.leaf*(.5*(ambientLight+ambientBack)+sunlightOverPi(uSun)*shadow*.25);
    ambientLight=mix(bounce,ambientLight,skyPass);ambientBack=mix(bounce,ambientBack,skyPass);
    float elevation=dot(reflection,normalize(vNormal));
    float specPass=mix(1.,exp(-.5*groundSurface.lai/max(.28,elevation)),section);
    reflectedSky=mix(bounce,reflectedSky,specPass);
  }
  if(grassBlade) {
    float coneWidth=roughness*roughness;
    float skyFraction=smoothstep(-coneWidth,coneWidth,reflection.y);
    float opening=pow(clamp(vCrownLight.x,.005,1.),1./max(coneWidth*.5,reflection.y));
    vec3 neighbor=vec3(.136,.231,.027)*(.5*(ambientLight+ambientBack)+sunlightOverPi(uSun)*shadow*.25);
    reflectedSky=mix(neighbor,reflectedSky,skyFraction*opening);
  }
  float outerAperture=(vExtra.x>1.9 && vExtra.x<2.1 && vExtra.y>=0.)?standAperture:-1.;
  vec3 color=surfaceDiffuse(albedo,ambientLight,ambientBack,diffuseTransmission,dot(n,view),roughness)
    +surfaceEnvironment(reflectedSky,dot(n,view),roughness)
    +surfaceDirectFiltered(albedo,n,view,uSun,roughness,diffuseTransmission,1.,outerAperture)*shadow;
  if(ground>.5&&vExtra.z>.01) {
    float footprintBlend=smoothstep(105.,170.,distanceToCamera)*smoothstep(.01,.75,vExtra.z);
    if(footprintBlend>0.)color=mix(color,pastureCanopy(groundSurface,normalize(vNormal),view,uSun,shadow,occlusion,color),footprintBlend);
  }
  color = aerialPerspective(color,vPosition,uCamera,uSun);
  if(uDebug==1 && ground<0.5) color=uDetail==0?vec3(0.16,0.62,0.2):uDetail==1?vec3(0.84,0.42,0.07):vec3(0.13,0.36,0.9);
  if(uDebug==2) { outColor=vec4(n*0.5+0.5,coverage); return; }
  if(uDebug==3) { outColor=vec4(vec3(occlusion*shadow),coverage); return; }
  outColor=vec4(tonemap(color),coverage);
}`;

const skyVertex = `#version 300 es
precision highp float;
out vec2 vClip;
void main(){
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  vClip=p*2.0-1.0;
  gl_Position=vec4(vClip,1.0,1.0);
}`;

const skyFragment = `#version 300 es
precision highp float;
in vec2 vClip;
uniform mat4 uInverseProjection;
uniform vec3 uCamera;
uniform vec3 uSun;
uniform float uTime;
uniform sampler2D uPhotographicSky;
uniform sampler2D uPhotographicCloudDetail;
uniform int uSkyMode;
out vec4 outColor;
vec3 mapRadiance(vec3 color) {
  color=max(color,vec3(0.0));
  return pow(clamp((color*(2.51*color+0.03))/(color*(2.43*color+0.59)+0.14),0.0,1.0),vec3(1.0/2.2));
}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
float fbm(vec2 p){float n=0.0,a=0.5;for(int i=0;i<5;i++){n+=noise(p)*a;p=p*2.01+7.7;a*=0.5;}return n;}
void main(){
  vec4 world=uInverseProjection*vec4(vClip,1.0,1.0);
  vec3 ray=normalize(world.xyz/world.w-uCamera);
  if(uSkyMode==0) {
    vec3 sourceSun=vec3(0.554562,0.741980,0.376731);
    vec3 currentSun=normalize(uSun);
    float yaw=atan(sourceSun.z,sourceSun.x)-atan(currentSun.z,currentSun.x);
    vec3 lookup=vec3(ray.x*cos(yaw)-ray.z*sin(yaw),ray.y,ray.x*sin(yaw)+ray.z*cos(yaw));
    lookup=normalize(vec3(lookup.x,max(0.012,lookup.y),lookup.z));
    vec2 uv=vec2(atan(lookup.z,lookup.x)/6.2831853+0.5,acos(clamp(lookup.y,-1.0,1.0))/3.14159265);
    vec2 detailUV=uv*vec2(1.,2.);
    vec2 dx=dFdx(detailUV), dy=dFdy(detailUV);
    dx.x-=round(dx.x); dy.x-=round(dy.x);
    float gain=textureGrad(uPhotographicCloudDetail,detailUV,dx,dy).r;
    vec3 sky=texture(uPhotographicSky,uv).rgb*exp2((gain*255.-128.)/48.);
    outColor=vec4(mapRadiance(sky*1.25),1.0);
    return;
  }
  float height=max(ray.y,0.0);
  vec3 color=mix(vec3(0.65,0.76,0.83),vec3(0.035,0.19,0.46),pow(height,0.5));
  float towardSun=max(dot(ray,uSun),0.0);
  color+=vec3(1.0,0.77,0.38)*pow(towardSun,600.0)*2.0;
  color+=vec3(0.16,0.12,0.07)*pow(towardSun,12.0);
  if(ray.y>0.015){
    vec2 cloud=(uCamera.xz+ray.xz*(1600.0/max(ray.y,0.03)))*0.00085+vec2(uTime*0.0015,0.0);
    float field=fbm(cloud);
    float shape=smoothstep(0.58,0.73,field)*smoothstep(0.01,0.20,ray.y);
    float light=clamp(0.82+(field-fbm(cloud-uSun.xz*0.15))*3.0,0.58,1.0);
    color=mix(color,vec3(1.0,0.985,0.95)*light,shape*0.96);
  }
  outColor=vec4(color,1.0);
}`;

// Use the exact visible deformation for both tree and grass casters.
const shadowVertex = geometryVertex.replaceAll('vExtra','vShadowExtra');

const shadowFragment = `#version 300 es
precision highp float;
in vec3 vShadowExtra;
uniform highp sampler2DArray uAlbedo;
void main(){
  if(vShadowExtra.x>4.5){
    float layer=floor(vShadowExtra.x+0.1)-2.0;
    if(texture(uAlbedo,vec3(vShadowExtra.yz,layer)).a<0.5)discard;
  }
}`;

function webGLProjection(matrix) {
  const result = new Float32Array(matrix);
  for (let column = 0; column < 4; column++) result[column * 4 + 2] = 2 * matrix[column * 4 + 2] - matrix[column * 4 + 3];
  return result;
}

export async function startFallback(canvas, options) {
  const { settings, telemetry, setLoading, setError, getCamera } = options;
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) throw Object.assign(new Error('A WebGPU or WebGL 2 graphics context is required.'), {code:'NO_GRAPHICS_CONTEXT'});
  telemetry.backend = 'WebGL 2 compatibility';
  telemetry.adapter = gl.getParameter(gl.RENDERER);
  const coverageTarget=createCoverageTarget(gl,Math.max(1,canvas.width),Math.max(1,canvas.height));
  telemetry.rasterSamples=coverageTarget.samples;
  const multisampled=telemetry.rasterSamples>1;
  telemetry.gpuErrors = [];

  function program(vertexSource, fragmentSource) {
    const result = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(result, shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
    return result;
  }

  async function loadMaterialArray(name, internalFormat) {
    const bytes = await materialBytes(name);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    let offset = 0;
    for (let level = 0, side = 512; level < 10; level++, side >>= 1) {
      const length = side * side * 4 * 9;
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, level, internalFormat, side, side, 9, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes.subarray(offset, offset + length));
      offset += length;
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return texture;
  }

  setLoading('Loading terrain and bark materials…', 0.08);
  const albedoTexture = await loadMaterialArray('albedo', gl.SRGB8_ALPHA8);
  const normalTexture = await loadMaterialArray('normal', gl.RGBA8);
  const skyDetail=await glSkyDetail(gl);
  const skyResponse=await fetch(new URL('./assets/environment.bin',import.meta.url));
  if(!skyResponse.ok)throw new Error('Unable to load the photographic sky.');
  const skyBytes=await skyResponse.arrayBuffer();
  if(skyBytes.byteLength!==2048*1024*4)throw new Error('The photographic sky texture is incomplete.');
  const photographicSky=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,photographicSky);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.R11F_G11F_B10F,2048,1024,0,gl.RGB,gl.UNSIGNED_INT_10F_11F_11F_REV,new Uint32Array(skyBytes));
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);

  const photoCloudMask = await glCloudMask(gl);
  const standRelief=await glStandRelief(gl);
  const surfaceDFG=glSurfaceDFG(gl);
  const sceneProgram = program(geometryVertex, geometryFragment(multisampled));
  const skyProgram = program(skyVertex, skyFragment);
  const depthProgram = program(shadowVertex, shadowFragment);
  const uniformCache = new Map();
  function uniform(target, name) {
    if (!uniformCache.has(target)) uniformCache.set(target, new Map());
    const locations = uniformCache.get(target);
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(target, name));
    return locations.get(name);
  }

  function uploadMesh(mesh) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertex = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    for (let location = 0; location < 4; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 48, location * 12);
    }
    const index = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    const instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 32, gl.DYNAMIC_DRAW);
    for (let location = 4; location < 6; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 32, (location - 4) * 16);
      gl.vertexAttribDivisor(location, 1);
    }
    return { vao, vertex, index, instanceBuffer, count: mesh.indices.length, visible: 0, instanceCapacity: 32 };
  }

  setLoading('Building the compatible forest renderer…', 0.15);
  await new Promise(resolve => requestAnimationFrame(resolve));
  const vegetation = {};
  const meadowGeometry = await loadMeadowGeometry();
  setLoading('Loading detailed tree geometry…',0.30);
  const hedgerowAssets=prepareHedgerow();
  const [realTrees,jacaranda] = await Promise.all([loadRealTreeGeometry(),loadRealTreeGeometry('jacaranda')]);
  Object.assign(vegetation,realTrees);
  vegetation.voxel=vegetation.canopy;
  vegetation.shadow=vegetation.canopy;
  const hedgerow=createGLHedgerow(await hedgerowAssets,uploadMesh,uploadInstances,drawMesh);
  const terrain=createLandscape();
  const occlusionTerrain=buildTerrainVisibility(terrain);
  const meshes = { terrain: uploadMesh(terrain), canopy: uploadMesh(createCanopyProxy()) };
  for (const name of treeLevels) meshes[name] = uploadMesh(vegetation[name]);
  const closeGeometry=closeMeadow();
  const closeMeadowMesh=uploadMesh(closeGeometry);
  const nearMeadowMeshes=meadowGeometry.map(mesh=>uploadMesh(mesh));
  const farMeadowMeshes=meadowGeometry.map(mesh=>uploadMesh(mesh.far));
  const shadowMesh = uploadMesh(vegetation.shadow || vegetation.far);
  const jacarandaMeshes={};
  const jacarandaLevels={...jacaranda,voxel:jacaranda.canopy};
  for(const name of treeLevels)jacarandaMeshes[name]=uploadMesh(jacarandaLevels[name]);
  const [oakImpostors,jacarandaImpostors]=await Promise.all([
    createGLTreeImpostors(gl,{species:'oak',multisampled}),createGLTreeImpostors(gl,{species:'jacaranda',multisampled})
  ]);
  const treeGroups=[
    {name:'trees',meshes,shadowMesh,detailShadowMesh:uploadMesh(realTrees.mid),impostors:oakImpostors},
    {name:'jacaranda',meshes:jacarandaMeshes,shadowMesh:uploadMesh(jacaranda.canopy),detailShadowMesh:uploadMesh(jacaranda.mid),impostors:jacarandaImpostors}
  ];
  const meshStats = Object.fromEntries(Object.entries(meshes).map(([name, mesh]) => [name, mesh.count / 3]));
  telemetry.meshTriangles = meshStats;

  const plantShadowMesh=uploadMesh(closeGeometry);
  const herbShadowMeshes=meadowGeometry.map(mesh=>uploadMesh(mesh));
  const plantShadowTexture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,plantShadowTexture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,2048,2048,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_MODE,gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const plantShadowFramebuffer=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,plantShadowFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,plantShadowTexture,0);
  gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('The near plant shadow framebuffer is incomplete.');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  const shadowTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadowTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 4096, 4096, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const shadowFramebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTexture, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The sun shadow framebuffer is incomplete.');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const canopyTexture = gl.createTexture();
  let treeData;
  let treeLodState;
  let standTexture;
  const startCamera=getCamera().position;
  let grassCenter=[startCamera[0],startCamera[2]];
  let grassData = createGrassInstances(180000,...grassCenter,0.4);
  let farGrassCenter=[...grassCenter];
  function farGrassInstances(center) {
    const data=createGrassInstances(65536,...center,1.6);
    return data;
  }
  let farGrassData=farGrassInstances(farGrassCenter);
  const nearEnvelope=meadowEnvelope([...meadowGeometry,closeGeometry]);
  const farEnvelope=meadowEnvelope(meadowGeometry.map(mesh=>mesh.far),true);
  let nearGrassBank=makeMeadowBank(grassData,nearEnvelope);
  let farGrassBank=makeMeadowBank(farGrassData,farEnvelope);
  const grassPlanes=new Float64Array(24);
  const farGrassBuckets=meadowGeometry.map(()=>new Float32Array(farGrassData.length));
  let grassWorker=null,grassPending=false,farGrassPending=false;
  let nearGrassGeneration=0,farGrassGeneration=0;
  if(typeof Worker!=='undefined') {
    grassWorker=new Worker(new URL('./stream-worker.js',import.meta.url),{type:'module'});
    grassWorker.onmessage=({data})=>{
      if(data.type!=='grass')return;
      if(data.kind==='far') {
        if(data.generation!==farGrassGeneration)return;
        farGrassData=data.grass;farGrassBank=makeMeadowBank(farGrassData,farEnvelope,data.boxes);farGrassCenter=data.center;farGrassPending=false;
      } else {
        if(data.generation!==nearGrassGeneration)return;
        grassData=data.grass;nearGrassBank=makeMeadowBank(grassData,nearEnvelope,data.boxes);grassCenter=data.center;grassPending=false;
      }
      renderer.volumeDirty=true;
    };
    grassWorker.onerror=()=>{grassWorker.terminate();grassWorker=null;grassPending=false;farGrassPending=false;};
  }
  const grassBuckets = meadowGeometry.map(()=>new Float32Array(grassData.length));
  const closeGrassBucket=new Float32Array(8192*8);
  const plantShadowBucket=new Float32Array(8192*8);
  const herbShadowBuckets=herbShadowMeshes.map(()=>new Float32Array(8192*8));
  const emptyVAO = gl.createVertexArray();
  let lastCull = -Infinity;
  let lastCullCamera = null;
  let lastCullQuality = '';
  let shadowDirty = true;
  let lastStats = 0;
  let lightProjection = new Float32Array(16);
  let previousSun = '';
  let previousShadowAnchor = [Infinity, Infinity];

  function uploadInstances(mesh, data, count) {
    mesh.visible = count;
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceBuffer);
    const byteLength = count * 32;
    if (mesh.instanceCapacity < byteLength) {
      mesh.instanceCapacity = 2 ** Math.ceil(Math.log2(Math.max(32, byteLength)));
      gl.bufferData(gl.ARRAY_BUFFER, mesh.instanceCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 8);
  }

  function copyInstance(destination, sourceOffset, destinationOffset, source) {
    for (let component = 0; component < 8; component++) {
      destination[destinationOffset + component] = source[sourceOffset + component];
    }
  }

  function rebuildPopulation(count) {
    treeData = createTreeInstances(count);
    treeLodState=new Uint8Array(treeData.length/8);
    gl.activeTexture(gl.TEXTURE0+11);
    standTexture=getGLStandTexture(gl);
    gl.activeTexture(gl.TEXTURE0);
    for(const group of treeGroups) {
      group.buckets=treeLevels.map(()=>new Float32Array(treeData.length));
      group.shadowBucket=new Float32Array(treeData.length);
      group.detailShadowBucket=new Float32Array(treeData.length);
    }
    const canopy = new Uint8Array(256 * 256);
    for (let i = 0; i < treeData.length; i += 8) {
      const x = Math.floor((treeData[i] / 4000 + 0.5) * 256);
      const z = Math.floor((treeData[i + 2] / 4000 + 0.5) * 256);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx, pz = z + dz;
        if (px >= 0 && px < 256 && pz >= 0 && pz < 256) {
          const index = pz * 256 + px;
          canopy[index] = Math.min(245, canopy[index] + (dx === 0 && dz === 0 ? 100 : 42));
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, canopyTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 256, 0, gl.RED, gl.UNSIGNED_BYTE, canopy);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    telemetry.total = count;
    telemetry.volumeUpdates++;
    lastCull = -Infinity;
    shadowDirty = true;
    renderer.volumeDirty = true;
  }

  function meadowVariant(data,index) {
    return Math.min(3, Math.floor(data[index+7]*4));
  }

  function cull(camera, now, viewProjection) {
    const [cx, cy, cz] = camera.position;
    const cameraChanged = !lastCullCamera
      || Math.abs(cx - lastCullCamera[0]) > 0.002
      || Math.abs(cy - lastCullCamera[1]) > 0.002
      || Math.abs(cz - lastCullCamera[2]) > 0.002
      || Math.abs(camera.yaw - lastCullCamera[3]) > 0.00002
      || Math.abs(camera.pitch - lastCullCamera[4]) > 0.00002;
    if (!cameraChanged && lastCullQuality === settings.quality && !renderer.volumeDirty && lastCull !== -Infinity) return;
    const counts = [0, 0, 0, 0];
    for(const group of treeGroups){group.counts=[0,0,0,0];group.shadows=0;group.detailShadows=0;group.impostorCount=0;}
    const forwardX = Math.sin(camera.yaw) * Math.cos(camera.pitch);
    const forwardY = Math.sin(camera.pitch);
    const forwardZ = -Math.cos(camera.yaw) * Math.cos(camera.pitch);
    const aspect = canvas.width / canvas.height;
    const viewCosine = Math.cos(Math.atan(Math.tan(50 * Math.PI / 360) * Math.hypot(aspect, 1)) + 0.20);
    const nearDistance = settings.quality === 'high' ? 90 : settings.quality === 'low' ? 25 : 65;
    const middleDistance = settings.quality === 'high' ? 280 : settings.quality === 'low' ? 100 : 180;
    for (let index = 0; index < treeData.length; index += 8) {
      const dx = treeData[index] - cx;
      const dy = treeData[index + 1] + 8 * treeData[index + 3] - cy;
      const dz = treeData[index + 2] - cz;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const group=treeGroups[(index/8)%5<2?1:0];
      if (shadowDirty && dx * dx + dz * dz < SHADOW_CASTER_DISTANCE ** 2) {
        if(dx*dx+dz*dz<LEAF_CASTER_DISTANCE**2){
          copyInstance(group.detailShadowBucket,index,group.detailShadows*8,treeData);group.detailShadows++;
        }else{copyInstance(group.shadowBucket,index,group.shadows*8,treeData);group.shadows++;}
      }
      if (distanceSquared > 3500 * 3500) continue;
      const distance = Math.sqrt(distanceSquared);
      if (distance > 25 && (dx * forwardX + dy * forwardY + dz * forwardZ) < distance * viewCosine - 15 * treeData[index+3]) continue;
      if(treeBehindTerrain(occlusionTerrain,camera.position,treeData,index))continue;
      const treeIndex=index/8,scale=treeData[index+3];
      const crownDistance=Math.sqrt(dx*dx+(dy+scale)*(dy+scale)+dz*dz);
      const state=treeDetailLevel(crownDistance,scale,treeData[index+6],treeIndex<8,nearDistance,middleDistance,treeLodState[treeIndex]);
      treeLodState[treeIndex]=state;
      const level=state-1;
      if(level<2)copyInstance(group.buckets[level],index,group.counts[level]*8,treeData);
      else {copyInstance(group.buckets[2],index,group.impostorCount*8,treeData);group.impostorCount++;}
      group.counts[level]++;
      counts[level]++;
    }
    for(const group of treeGroups) {
      for(let index=0;index<2;index++)uploadInstances(group.meshes[treeLevels[index]],group.buckets[index],group.counts[index]);
      group.impostors.upload(group.buckets[2],group.impostorCount);
      if(shadowDirty){
        uploadInstances(group.shadowMesh,group.shadowBucket,group.shadows);
        uploadInstances(group.detailShadowMesh,group.detailShadowBucket,group.detailShadows);
      }
    }
    if (!grassPending && Math.hypot(cx - grassCenter[0], cz - grassCenter[1]) > 7) {
      const center=[Math.floor(cx/3.2)*3.2,Math.floor(cz/3.2)*3.2];
      if(grassWorker) {grassPending=true;grassWorker.postMessage({type:'grass',kind:'near',generation:++nearGrassGeneration,spacing:0.4,center,count:180000,envelope:nearEnvelope});}
      else {grassCenter=center;grassData=createGrassInstances(180000,...center,0.4);nearGrassBank=makeMeadowBank(grassData,nearEnvelope);}
    }
    if(!farGrassPending&&Math.hypot(cx-farGrassCenter[0],cz-farGrassCenter[1])>20) {
      const center=[Math.round(cx/16)*16,Math.round(cz/16)*16];
      if(grassWorker) {
        farGrassPending=true;
        grassWorker.postMessage({type:'grass',kind:'far',generation:++farGrassGeneration,spacing:1.6,center,count:65536,envelope:farEnvelope});
      } else {farGrassCenter=center;farGrassData=farGrassInstances(center);farGrassBank=makeMeadowBank(farGrassData,farEnvelope);}
    }
    const farCounts=[0,0,0,0],nearCounts=[0,0,0,0];
    meadowPlanes(viewProjection,grassPlanes);
    let farGrassCount=0;
    const farCandidates=visitMeadow(farGrassBank,camera.position,grassPlanes,index=>{
      const variant=meadowVariant(farGrassData,index);
      copyInstance(farGrassBuckets[variant],index,farCounts[variant]++*8,farGrassData);
      farGrassCount++;
    });
    for(let variant=0;variant<4;variant++)uploadInstances(farMeadowMeshes[variant],farGrassBuckets[variant],farCounts[variant]);
    let grassCount=0,closeGrassCount=0,plantShadowCount=0;
    const herbShadowCounts=[0,0,0,0];
    const nearCandidates=visitMeadow(nearGrassBank,camera.position,grassPlanes,(index,distanceSquared)=>{
      if(distanceSquared<144&&closeGrassCount<8192)copyInstance(closeGrassBucket,index,closeGrassCount++*8,grassData);
      const variant=meadowVariant(grassData,index);
      copyInstance(grassBuckets[variant],index,nearCounts[variant]++*8,grassData);
      grassCount++;
    },index=>{
      if(plantShadowCount>=8192)return;
      copyInstance(plantShadowBucket,index,plantShadowCount++*8,grassData);
      const variant=meadowVariant(grassData,index);
      copyInstance(herbShadowBuckets[variant],index,herbShadowCounts[variant]++*8,grassData);
    });
    telemetry.grassCandidates=nearCandidates+farCandidates;
    for(let variant=0;variant<4;variant++)uploadInstances(nearMeadowMeshes[variant],grassBuckets[variant],nearCounts[variant]);
    uploadInstances(closeMeadowMesh,closeGrassBucket,closeGrassCount);
    uploadInstances(plantShadowMesh,plantShadowBucket,plantShadowCount);
    for(let v=0;v<herbShadowMeshes.length;v++)uploadInstances(herbShadowMeshes[v],herbShadowBuckets[v],herbShadowCounts[v]);
    telemetry.closeGrass=closeGrassCount;
    telemetry.counts = counts;
    telemetry.triangles = hedgerow.update(camera.position,viewProjection)+closeGrassCount*closeMeadowMesh.count/3+(meshes.terrain.count+meshes.canopy.count) / 3 + treeGroups.reduce((total,group)=>total+group.counts.reduce((sum,value,index)=>sum+value*(index<2?group.meshes[treeLevels[index]].count/3:2),0),0) + nearCounts.reduce((sum,count,index)=>sum+count*nearMeadowMeshes[index].count/3,0)+farCounts.reduce((sum,count,index)=>sum+count*farMeadowMeshes[index].count/3,0);
    telemetry.species=treeGroups.map(group=>({name:group.name,counts:group.counts}));
    telemetry.grass=grassCount;telemetry.farGrass=farGrassCount;telemetry.meadowNear=nearCounts;telemetry.meadowFar=farCounts;
    lastCull = now;
    lastCullCamera = [cx, cy, cz, camera.yaw, camera.pitch];
    lastCullQuality = settings.quality;
    renderer.volumeDirty = false;
  }

  function drawMesh(mesh, instanced) {
    gl.bindVertexArray(mesh.vao);
    if (instanced && mesh.visible) gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0, mesh.visible);
    if (!instanced) gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  }

  const renderer = {
    volumeDirty: true,
    rebuildPopulation,
    refreshStats() {
      const counts = telemetry.counts;
      updateStats({ fps: telemetry.fps, trees: counts.reduce((sum, value) => sum + value, 0), near: counts[0], mid: counts[1], far: (counts[2] || 0) + (counts[3] || 0), total: telemetry.total, triangles: telemetry.triangles });
    },
    render(time) {
      const now = time;
      const camera = getCamera();
      const pixelRatio = Math.min(devicePixelRatio || 1, settings.quality === 'high' ? 1.75 : settings.quality === 'low' ? 0.8 : 1.15);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; lastCull = -Infinity; }
      coverageTarget.resize(width,height);
      telemetry.rasterSamples=coverageTarget.samples;
      telemetry.resolution = [width, height];
      const elevation = settings.sunElevation * Math.PI / 180;
      const azimuth = settings.sunAzimuth * Math.PI / 180;
      const sun = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
      const direction = [Math.sin(camera.yaw) * Math.cos(camera.pitch), Math.sin(camera.pitch), -Math.cos(camera.yaw) * Math.cos(camera.pitch)];
      const target = camera.position.map((value, index) => value + direction[index]);
      const view = lookAt(camera.position, target);
      const projection = webGLProjection(perspective(50 * Math.PI / 180, width / height, 0.15, 14000));
      const viewProjection = multiply(projection, view);
      const sunKey = settings.sunElevation + ',' + settings.sunAzimuth;
      const shadowAnchor = [Math.floor(camera.position[0] / 32) * 32, Math.floor(camera.position[2] / 32) * 32];
      shadowDirty ||= sunKey !== previousSun
        || shadowAnchor[0] !== previousShadowAnchor[0]
        || shadowAnchor[1] !== previousShadowAnchor[1];
      if (shadowDirty) renderer.volumeDirty = true;
      cull(camera, now,viewProjection);
      if (shadowDirty) {
        const center = [shadowAnchor[0], terrainHeight(shadowAnchor[0], shadowAnchor[1]) + 15, shadowAnchor[1]];
        const eye = center.map((value, index) => value + sun[index] * 1200);
        lightProjection = multiply(webGLProjection(orthographic(-SHADOW_HALF_WIDTH, SHADOW_HALF_WIDTH, -SHADOW_HALF_WIDTH, SHADOW_HALF_WIDTH, 1, 2600)), lookAt(eye, center));
        // Align the light-space origin to shadow texels so cache recentering is stable.
        lightProjection[12] = Math.round(lightProjection[12] * 2048) / 2048;
        lightProjection[13] = Math.round(lightProjection[13] * 2048) / 2048;
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
        gl.viewport(0, 0, 4096, 4096);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.useProgram(depthProgram);
        gl.uniform1f(uniform(depthProgram,'uTime'),now);gl.uniform1f(uniform(depthProgram,'uWind'),0);
        gl.uniform3fv(uniform(depthProgram,'uCamera'),camera.position);gl.uniform3fv(uniform(depthProgram,'uSun'),sun);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY,albedoTexture);
        gl.uniform1i(uniform(depthProgram,'uAlbedo'),2);
        gl.uniformMatrix4fv(uniform(depthProgram, 'uViewProjection'), false, lightProjection);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2, 2);
        gl.uniform1i(uniform(depthProgram, 'uInstanced'), 0);
        drawMesh(meshes.terrain, false);
        gl.uniform1i(uniform(depthProgram, 'uInstanced'), 1);
        for(const group of treeGroups){drawMesh(group.shadowMesh,true);drawMesh(group.detailShadowMesh,true);}
        hedgerow.draw('wide');
        gl.disable(gl.POLYGON_OFFSET_FILL);
        previousShadowAnchor = shadowAnchor;
        previousSun = sunKey;
        shadowDirty = false;
      }

      const plantCenter=[camera.position[0],terrainSurfaceHeight(camera.position[0],camera.position[2])+.4,camera.position[2]];
      const plantEye=plantCenter.map((value,index)=>value+sun[index]*50);
      const plantProjection=multiply(webGLProjection(orthographic(-16,16,-16,16,1,110)),lookAt(plantEye,plantCenter));
      plantProjection[12]=Math.round(plantProjection[12]*1024)/1024;plantProjection[13]=Math.round(plantProjection[13]*1024)/1024;
      gl.bindFramebuffer(gl.FRAMEBUFFER,plantShadowFramebuffer);gl.viewport(0,0,2048,2048);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(depthProgram);gl.uniformMatrix4fv(uniform(depthProgram,'uViewProjection'),false,plantProjection);
      gl.uniform1i(uniform(depthProgram,'uInstanced'),1);gl.uniform1f(uniform(depthProgram,'uTime'),now);
      gl.uniform1f(uniform(depthProgram,'uWind'),settings.wind);gl.uniform3fv(uniform(depthProgram,'uCamera'),camera.position);
      gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D_ARRAY,albedoTexture);gl.uniform1i(uniform(depthProgram,'uAlbedo'),2);
      gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(.5,.5);drawMesh(plantShadowMesh,true);
      for(const mesh of herbShadowMeshes)drawMesh(mesh,true);
      hedgerow.draw('close');gl.disable(gl.POLYGON_OFFSET_FILL);
      coverageTarget.bindScene(width,height);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.useProgram(skyProgram);
      gl.bindVertexArray(emptyVAO);
      gl.uniformMatrix4fv(uniform(skyProgram, 'uInverseProjection'), false, inverse(viewProjection));
      gl.uniform3fv(uniform(skyProgram, 'uCamera'), camera.position);
      gl.uniform3fv(uniform(skyProgram, 'uSun'), sun);
      gl.uniform1f(uniform(skyProgram, 'uTime'), now);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D,photographicSky);
      gl.uniform1i(uniform(skyProgram,'uPhotographicSky'),4);
      gl.activeTexture(gl.TEXTURE0+5);
      gl.bindTexture(gl.TEXTURE_2D,skyDetail);
      gl.uniform1i(uniform(skyProgram,'uPhotographicCloudDetail'),5);
      gl.uniform1i(uniform(skyProgram,'uSkyMode'),settings.sky==='volumetric'?1:0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      if(multisampled)gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.useProgram(sceneProgram);
      gl.activeTexture(gl.TEXTURE0+15);gl.bindTexture(gl.TEXTURE_2D,standRelief);gl.uniform1i(uniform(sceneProgram,'uStandRelief'),15);
      gl.activeTexture(gl.TEXTURE0+14);gl.bindTexture(gl.TEXTURE_2D,surfaceDFG);gl.uniform1i(uniform(sceneProgram,'uSurfaceDFG'),14);
      gl.uniformMatrix4fv(uniform(sceneProgram, 'uViewProjection'), false, viewProjection);
      gl.uniformMatrix4fv(uniform(sceneProgram, 'uLightProjection'), false, lightProjection);
      gl.uniform3fv(uniform(sceneProgram, 'uCamera'), camera.position);
      gl.uniform3fv(uniform(sceneProgram, 'uSun'), sun);
      gl.uniformMatrix4fv(uniform(sceneProgram,'uPlantLightProjection'),false,plantProjection);
      gl.activeTexture(gl.TEXTURE0+12);gl.bindTexture(gl.TEXTURE_2D,plantShadowTexture);gl.uniform1i(uniform(sceneProgram,'uPlantShadow'),12);
      gl.uniform1f(uniform(sceneProgram, 'uTime'), now);
      gl.uniform1f(uniform(sceneProgram, 'uWind'), settings.wind);
      gl.uniform1i(uniform(sceneProgram, 'uDebug'), ['beauty', 'lod', 'normal', 'ao'].indexOf(settings.debug));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTexture);
      gl.uniform1i(uniform(sceneProgram, 'uShadow'), 0);
      gl.activeTexture(gl.TEXTURE0+11);
      gl.bindTexture(gl.TEXTURE_2D,standTexture);
      gl.uniform1i(uniform(sceneProgram,'standEnvelope'),11);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, canopyTexture);
      gl.uniform1i(uniform(sceneProgram, 'uCanopy'), 1);
      gl.activeTexture(gl.TEXTURE0+10);
      gl.bindTexture(gl.TEXTURE_2D, photoCloudMask);
      gl.uniform1i(uniform(sceneProgram,'uCloudCover'),10);
      gl.uniform1i(uniform(sceneProgram,'uUsePhotoCloud'),+(settings.sky==='photographic'));
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, albedoTexture);
      gl.uniform1i(uniform(sceneProgram, 'uAlbedo'), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, normalTexture);
      gl.uniform1i(uniform(sceneProgram, 'uSurfaceNormal'), 3);
      gl.uniform1i(uniform(sceneProgram, 'uInstanced'), 0);
      drawMesh(meshes.terrain, false);
      drawMesh(meshes.canopy, false);
      gl.uniform1i(uniform(sceneProgram, 'uInstanced'), 1);
      for(const group of treeGroups)treeLevels.slice(0,2).forEach((name,index)=>{
        gl.uniform1i(uniform(sceneProgram,'uDetail'),Math.min(index,2));
        drawMesh(group.meshes[name],true);
      });
      hedgerow.draw('near');hedgerow.draw('far');
      drawMesh(closeMeadowMesh,true);
      for(const mesh of [...farMeadowMeshes,...nearMeadowMeshes])drawMesh(mesh,true);
      for(const group of treeGroups)group.impostors.draw({
        viewProjection,lightProjection,camera:camera.position,sun,shadowTexture,photoCloud:settings.sky==='photographic',
        debug:['beauty','lod','normal','ao'].indexOf(settings.debug)
      });
      if(multisampled)gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      coverageTarget.present(width,height);
      const error = gl.getError();
      if (error && telemetry.gpuErrors.length < 10) telemetry.gpuErrors.push('WebGL error ' + error);
      if (now - lastStats > 0.5) { renderer.refreshStats(); lastStats = now; }
    }
  };
  rebuildPopulation(settings.density);
  telemetry.status = 'running';
  const mode = document.createElement('span');
  mode.textContent = 'WebGL 2';
  mode.style.cssText = 'position:absolute;top:76px;left:34px;font:9px Arial,sans-serif;letter-spacing:1px;color:#f5f3e980;pointer-events:none';
  document.getElementById('interface').append(mode);
  setLoading('Opening the landscape…', 0.96);
  options.onReady?.();
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    telemetry.status = 'device-lost';
    setError('The graphics context was lost. Reload to restart the forest.');
  });
  return renderer;
}
