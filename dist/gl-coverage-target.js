// Some WebGL2 contexts ignore the requested default-framebuffer antialiasing.
// Resolve first into a matching single-sample RGBA8 buffer. The final blit
// can then scale and convert to the browser's RGB or RGBA drawing buffer.
export function createCoverageTarget(gl,width,height) {
  const defaultSamples=gl.getParameter(gl.SAMPLES);
  let surface=null,requestedWidth=0,requestedHeight=0;
  let available=[];
  if(defaultSamples<2) {
    const color=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA8,gl.SAMPLES);
    for(const depth of [gl.DEPTH_COMPONENT24,gl.DEPTH_COMPONENT16]) {
      const depths=gl.getInternalformatParameter(gl.RENDERBUFFER,depth,gl.SAMPLES);
      for(const count of color)if(count>=2&&count<=4&&depths.includes(count))available.push({count,depth});
    }
    available.sort((a,b)=>b.count-a.count);
  }
  function release(s) {
    gl.deleteFramebuffer(s.draw);
    gl.deleteFramebuffer(s.resolve);
    gl.deleteRenderbuffer(s.color);
    gl.deleteRenderbuffer(s.depthBuffer);
    gl.deleteRenderbuffer(s.single);
  }
  function allocate(w,h,format) {
    const s={width:w,height:h,samples:format.count,draw:gl.createFramebuffer(),resolve:gl.createFramebuffer(),
      color:gl.createRenderbuffer(),depthBuffer:gl.createRenderbuffer(),single:gl.createRenderbuffer()};
    let complete=false;
    try {
      if(!s.draw||!s.resolve||!s.color||!s.depthBuffer||!s.single)return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER,s.draw);
      for(const [buffer,internal,attachment] of [
        [s.color,gl.RGBA8,gl.COLOR_ATTACHMENT0],[s.depthBuffer,format.depth,gl.DEPTH_ATTACHMENT]
      ]) {
        gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER,s.samples,internal,w,h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,attachment,gl.RENDERBUFFER,buffer);
      }
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER,s.resolve);
      gl.bindRenderbuffer(gl.RENDERBUFFER,s.single);
      gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGBA8,w,h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,s.single);
      complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      return complete?s:null;
    } finally {
      gl.bindRenderbuffer(gl.RENDERBUFFER,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(!complete)release(s);
    }
  }
  function resize(w,h) {
    if(!available.length||(w===requestedWidth&&h===requestedHeight))return;
    requestedWidth=w;requestedHeight=h;
    const maximum=gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const fit=Math.min(1,maximum/w,maximum/h);
    // The shader's coverage mode is chosen once at startup. If a larger
    // allocation fails later, retain the complete old surface and scale it.
    for(const fraction of surface?[1]:[1,.75,.5]) {
      for(const format of available) {
        const replacement=allocate(Math.max(1,Math.floor(w*fit*fraction)),Math.max(1,Math.floor(h*fit*fraction)),format);
        if(!replacement)continue;
        if(surface)release(surface);
        surface=replacement;
        return;
      }
    }
    if(!surface)available=[];
  }
  resize(width,height);
  return {
    get samples(){return surface?.samples||defaultSamples;},
    resize,
    bindScene(w,h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,surface?.draw||null);
      gl.viewport(0,0,surface?.width||w,surface?.height||h);
    },
    present(w,h) {
      if(!surface)return;
      const sw=surface.width,sh=surface.height;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,surface.draw);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,surface.resolve);
      gl.blitFramebuffer(0,0,sw,sh,0,0,sw,sh,gl.COLOR_BUFFER_BIT,gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,surface.resolve);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
      gl.blitFramebuffer(0,0,sw,sh,0,0,w,h,gl.COLOR_BUFFER_BIT,sw===w&&sh===h?gl.NEAREST:gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    },
    dispose(){if(surface)release(surface);surface=null;available=[];}
  };
}
