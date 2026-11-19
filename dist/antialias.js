/** Quality FXAA for the gamma-encoded LDR image produced by the tone-map pass. */
export const fxaaShader = /* wgsl */`
@group(0) @binding(0) var sourceTexture:texture_2d<f32>;
@group(0) @binding(1) var linearSampler:sampler;

struct VertexOutput {
  @builtin(position) position:vec4<f32>,
  @location(0) uv:vec2<f32>
};

@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOutput {
  let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  var out:VertexOutput;
  out.position=vec4<f32>(positions[index],0.0,1.0);
  out.uv=positions[index]*vec2<f32>(0.5,-0.5)+0.5;
  return out;
}

fn sampleColor(uv:vec2<f32>)->vec3<f32> {
  return textureSampleLevel(sourceTexture,linearSampler,uv,0.0).rgb;
}

fn luminance(color:vec3<f32>)->f32 {
  return dot(color,vec3<f32>(0.299,0.587,0.114));
}

fn sampleLuminance(uv:vec2<f32>)->f32 {
  return luminance(sampleColor(uv));
}

@fragment fn fs(v:VertexOutput)->@location(0) vec4<f32> {
  let texel=1.0/vec2<f32>(textureDimensions(sourceTexture));
  let color=sampleColor(v.uv);
  let middle=luminance(color);
  let north=sampleLuminance(v.uv+vec2<f32>(0.0,-texel.y));
  let south=sampleLuminance(v.uv+vec2<f32>(0.0,texel.y));
  let west=sampleLuminance(v.uv+vec2<f32>(-texel.x,0.0));
  let east=sampleLuminance(v.uv+vec2<f32>(texel.x,0.0));
  let minimum=min(middle,min(min(north,south),min(west,east)));
  let maximum=max(middle,max(max(north,south),max(west,east)));
  let contrast=maximum-minimum;
  if(contrast<max(0.0312,maximum*0.125)) {return vec4<f32>(color,1.0);}

  let northwest=sampleLuminance(v.uv+texel*vec2<f32>(-1.0,-1.0));
  let northeast=sampleLuminance(v.uv+texel*vec2<f32>(1.0,-1.0));
  let southwest=sampleLuminance(v.uv+texel*vec2<f32>(-1.0,1.0));
  let southeast=sampleLuminance(v.uv+texel*vec2<f32>(1.0,1.0));
  let horizontal=abs(northwest+southwest-2.0*west)
    +2.0*abs(north+south-2.0*middle)+abs(northeast+southeast-2.0*east);
  let vertical=abs(northwest+northeast-2.0*north)
    +2.0*abs(west+east-2.0*middle)+abs(southwest+southeast-2.0*south);
  let horizontalEdge=horizontal>=vertical;

  let negativeLuma=select(west,north,horizontalEdge);
  let positiveLuma=select(east,south,horizontalEdge);
  let negativeGradient=negativeLuma-middle;
  let positiveGradient=positiveLuma-middle;
  let negativeSteeper=abs(negativeGradient)>=abs(positiveGradient);
  let gradientThreshold=max(abs(negativeGradient),abs(positiveGradient))*0.25;
  let localAverage=0.5*(middle+select(positiveLuma,negativeLuma,negativeSteeper));
  let perpendicularStep=select(texel.x,texel.y,horizontalEdge)*select(1.0,-1.0,negativeSteeper);
  var edgeUV=v.uv;
  if(horizontalEdge) {edgeUV.y+=perpendicularStep*0.5;}
  else {edgeUV.x+=perpendicularStep*0.5;}
  let alongEdge=select(vec2<f32>(0.0,texel.y),vec2<f32>(texel.x,0.0),horizontalEdge);
  var negativeUV=edgeUV-alongEdge;
  var positiveUV=edgeUV+alongEdge;
  var negativeDelta=sampleLuminance(negativeUV)-localAverage;
  var positiveDelta=sampleLuminance(positiveUV)-localAverage;
  var negativeDone=abs(negativeDelta)>=gradientThreshold;
  var positiveDone=abs(positiveDelta)>=gradientThreshold;

  // Search farther along each edge, preserving the first detected endpoint.
  let searchSteps=array<f32,8>(1.5,2.0,2.0,2.0,2.0,2.0,4.0,8.0);
  for(var step=0u;step<8u;step++) {
    if(negativeDone && positiveDone) {break;}
    if(!negativeDone) {
      negativeUV-=alongEdge*searchSteps[step];
      negativeDelta=sampleLuminance(negativeUV)-localAverage;
      negativeDone=abs(negativeDelta)>=gradientThreshold;
    }
    if(!positiveDone) {
      positiveUV+=alongEdge*searchSteps[step];
      positiveDelta=sampleLuminance(positiveUV)-localAverage;
      positiveDone=abs(positiveDelta)>=gradientThreshold;
    }
  }
  let negativeDistance=select(v.uv.y-negativeUV.y,v.uv.x-negativeUV.x,horizontalEdge);
  let positiveDistance=select(positiveUV.y-v.uv.y,positiveUV.x-v.uv.x,horizontalEdge);
  let negativeCloser=negativeDistance<positiveDistance;
  let closestDelta=select(positiveDelta,negativeDelta,negativeCloser);
  let validEdge=(closestDelta<0.0)!=(middle<localAverage);
  let span=max(negativeDistance+positiveDistance,0.000001);
  let edgeOffset=select(0.0,0.5-min(negativeDistance,positiveDistance)/span,validEdge);

  // The neighborhood average also catches leaves narrower than one pixel.
  let average=(2.0*(north+south+west+east)+northwest+northeast+southwest+southeast)/12.0;
  let subpixel=clamp(abs(average-middle)/max(contrast,0.00001),0.0,1.0);
  let smoothSubpixel=subpixel*subpixel*(3.0-2.0*subpixel);
  let subpixelOffset=smoothSubpixel*smoothSubpixel*0.75;
  let finalOffset=max(edgeOffset,subpixelOffset);
  var finalUV=v.uv;
  if(horizontalEdge) {finalUV.y+=finalOffset*perpendicularStep;}
  else {finalUV.x+=finalOffset*perpendicularStep;}
  return vec4<f32>(sampleColor(finalUV),1.0);
}
`;
