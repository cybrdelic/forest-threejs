const SIZE=512,LAYERS=9,LEVELS=10;
const BYTE_LENGTH=4*LAYERS*(4**LEVELS-1)/3;

// This layout puts true leaf coverage into the normal array's alpha channel.
// A versioned URL separates it from older, equally sized opaque normal maps.
export async function materialBytes(name) {
 const fixture=globalThis.forestMaterialBytes?.[name];
 let bytes=fixture;
 if(!bytes) {
  const url=new URL('./assets/'+name+'.bin',import.meta.url);
  url.searchParams.set('layout','foliage-normal-moment-3');
  const response=await fetch(url,{cache:'no-cache'});
  if(!response.ok) throw new Error('Unable to load the forest '+name+' material array.');
  bytes=new Uint8Array(await response.arrayBuffer());
 }
 if(bytes.byteLength!==BYTE_LENGTH) throw new Error('Invalid '+name+' material mip chain.');
 return bytes;
}

export async function loadMaterialTextures(device) {
 const usage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST;
 const textures=[];
 for(const name of ['albedo','normal']) {
  const bytes=await materialBytes(name);
  const texture=device.createTexture({label:'Forest '+name+' materials',size:[SIZE,SIZE,LAYERS],mipLevelCount:LEVELS,format:name==='albedo'?'rgba8unorm-srgb':'rgba8unorm',usage});
  let offset=0;
  for(let level=0;level<LEVELS;level++) {
   const side=Math.max(1,SIZE>>level),length=side*side*4*LAYERS;
   device.queue.writeTexture({texture,mipLevel:level},bytes.subarray(offset,offset+length),{bytesPerRow:side*4,rowsPerImage:side},[side,side,LAYERS]);
   offset+=length;
  }
  textures.push(texture);
 }
 return textures;
}
