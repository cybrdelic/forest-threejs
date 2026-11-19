import fs from 'node:fs';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CAMERA_START,terrainHeight,terrainSurfaceHeight} from '../../dist/landscape.js';
import {decodeRGBA8PNG} from '../../dist/impostors.js';
const dir=process.env.FOREST_GLES_OUTPUT||fileURLToPath(new URL('../../qa-output/gles/',import.meta.url));
fs.mkdirSync(dir,{recursive:true});
const distribution=fileURLToPath(new URL('../../dist/',import.meta.url));
function fingerprint(directory=distribution,prefix='') {
 const hashes={};
 for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const relative=prefix+entry.name;
  if(entry.isDirectory()) Object.assign(hashes,fingerprint(directory+'/'+entry.name,relative+'/'));
  else if(entry.isFile()&&entry.name.endsWith('.js')) hashes[relative]=crypto.createHash('sha256').update(fs.readFileSync(directory+'/'+entry.name)).digest('hex');
 }
 return hashes;
}
const sourceHashes=fingerprint();
const fetchedAssets={};
function asset(url) {
 const bytes=fs.readFileSync(url);
 const filename=url instanceof URL?fileURLToPath(url):url;
 fetchedAssets[filename.slice(distribution.length)]=crypto.createHash('sha256').update(bytes).digest('hex');
 return bytes;
}
const requestedSamples=Number(process.env.TEST_MSAA??4);
const enums={SAMPLES:0x80a9,SAMPLE_ALPHA_TO_COVERAGE:0x809e,TEXTURE_COMPARE_MODE:0x884c,COMPARE_REF_TO_TEXTURE:0x884e,COLOR_BUFFER_BIT:0x4000,ARRAY_BUFFER:0x8892,CLAMP_TO_EDGE:0x812f,COMPILE_STATUS:0x8b81,DEPTH_ATTACHMENT:0x8d00,DEPTH_BUFFER_BIT:0x100,DEPTH_COMPONENT:0x1902,DEPTH_COMPONENT24:0x81a6,DEPTH_TEST:0xb71,DYNAMIC_DRAW:0x88e8,ELEMENT_ARRAY_BUFFER:0x8893,FLOAT:0x1406,FRAGMENT_SHADER:0x8b30,FRAMEBUFFER:0x8d40,FRAMEBUFFER_COMPLETE:0x8cd5,LINEAR:0x2601,LINEAR_MIPMAP_LINEAR:0x2703,LINK_STATUS:0x8b82,NEAREST:0x2600,NONE:0,POLYGON_OFFSET_FILL:0x8037,R11F_G11F_B10F:0x8c3a,R8:0x8229,RED:0x1903,RENDERER:0x1f01,REPEAT:0x2901,RGB:0x1907,RGBA:0x1908,RGBA8:0x8058,SRGB8_ALPHA8:0x8c43,STATIC_DRAW:0x88e4,TEXTURE0:0x84c0,TEXTURE1:0x84c1,TEXTURE2:0x84c2,TEXTURE3:0x84c3,TEXTURE4:0x84c4,TEXTURE_3D:0x806f,TEXTURE_WRAP_R:0x8072,TEXTURE_2D:0xde1,TEXTURE_2D_ARRAY:0x8c1a,TEXTURE_MAG_FILTER:0x2800,TEXTURE_MAX_LEVEL:0x813d,TEXTURE_MIN_FILTER:0x2801,TEXTURE_WRAP_S:0x2802,TEXTURE_WRAP_T:0x2803,TRIANGLES:4,UNSIGNED_BYTE:0x1401,UNSIGNED_INT:0x1405,UNSIGNED_INT_10F_11F_11F_REV:0x8c3b,UNSIGNED_SHORT:0x1403,VERTEX_SHADER:0x8b31};
let id=1;const commands=[],hashes=new Set();
function encode(v){if(ArrayBuffer.isView(v)){const b=Buffer.from(v.buffer,v.byteOffset,v.byteLength);const hash=crypto.createHash('sha1').update(b).digest('hex');if(!hashes.has(hash)){fs.writeFileSync(dir+'/'+hash+'.bin',b);hashes.add(hash);}return {data:hash+'.bin',bytes:b.length};}if(Array.isArray(v))return v.map(encode);return v;}
const gl=new Proxy(enums,{get(t,k){if(k in t)return t[k];if(k==='getShaderParameter'||k==='getProgramParameter')return()=>true;if(k==='getShaderInfoLog'||k==='getProgramInfoLog')return()=>'';if(k==='getParameter')return parameter=>parameter===enums.SAMPLES?requestedSamples:'Native GLES replay';if(k==='getError')return()=>0;if(k==='checkFramebufferStatus')return()=>enums.FRAMEBUFFER_COMPLETE;return (...args)=>{if(k==='bufferSubData'&&args.length>3){args=[...args.slice(0,2),args[2].subarray(args[3],args[3]+args[4])];}if(k.startsWith('create')||k==='getUniformLocation'){const result={ref:id++};commands.push({name:k,args:args.map(encode),id:result.ref});return result;}commands.push({name:k,args:args.map(encode)});};}});
const width=Number(process.env.TEST_WIDTH||1024),height=Number(process.env.TEST_HEIGHT||576);const noop=()=>{};
const canvas={width,height,clientWidth:width,clientHeight:height,getContext:()=>gl,addEventListener:noop};
const element=()=>({style:{},classList:{add:noop,remove:noop,toggle:noop},append:noop,setAttribute:noop,addEventListener:noop,textContent:''});const nodes=new Map();
globalThis.document={getElementById:n=>{if(!nodes.has(n))nodes.set(n,element());return nodes.get(n);},createElement:element};globalThis.devicePixelRatio=1;globalThis.requestAnimationFrame=fn=>setImmediate(fn);
globalThis.fetch=async url=>{const b=asset(url);return {ok:true,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),json:async()=>JSON.parse(b.toString())};};
globalThis.forestImpostorMetadata={};globalThis.forestImpostorBytes={};
for(const species of ['oak','jacaranda']){forestImpostorMetadata[species]=JSON.parse(asset(new URL('../../dist/assets/impostors/'+species+'.json',import.meta.url)));for(const kind of ['albedo','normal'])forestImpostorBytes[species+'-'+kind]=(await decodeRGBA8PNG(Uint8Array.from(asset(new URL('../../dist/assets/impostors/'+species+'-'+kind+'.png',import.meta.url))).buffer)).bytes;}

const {createGLTreeImpostors}=await import('../../dist/impostors.js');
const {setStandPopulation}=await import('../../dist/stand-envelope.js');
const {multiply,perspective,lookAt}=await import('../../dist/math.js');
const tree=new Float32Array([0,0,0,1,0,.55,.6,.35]);setStandPopulation(tree,()=>-30);
const multisampled=gl.getParameter(gl.SAMPLES)>1;
if(multisampled)gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
const model=await createGLTreeImpostors(gl,{species:'oak',multisampled});model.upload(tree);
const white=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,white);
gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
gl.activeTexture(gl.TEXTURE0+10);gl.bindTexture(gl.TEXTURE_2D,white);
// The scene uses hardware depth comparison for the forest shadow map.
const shadow=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,shadow);
gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,1,1,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,new Uint32Array([0xffffffff]));
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_MODE,gl.COMPARE_REF_TO_TEXTURE);
gl.bindTexture(gl.TEXTURE_2D,white);
const frames=[];
for(let index=0;index<3;index++) {
 const azimuth=(22.5+(index-1)*.35)*Math.PI/180;
 const camera=[Math.sin(azimuth)*65,8,Math.cos(azimuth)*65];
 const pv=multiply(perspective(28*Math.PI/180,width/height,.1,400),lookAt(camera,[0,8,0]));
 const glPV=pv.slice();for(let c=0;c<4;c++)glPV[c*4+2]=2*pv[c*4+2]-pv[c*4+3];
 gl.viewport(0,0,width,height);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.clearColor(.18,.23,.3,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
 model.draw({viewProjection:glPV,lightProjection:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,5,5,5,1]),camera,sun:[.3,.8,.52],shadowTexture:shadow});
 frames.push({index,seconds:index/24,azimuthDegrees:azimuth*180/Math.PI,endCommand:commands.length});
}
fs.writeFileSync(dir+'/commands.json',JSON.stringify({scene:'impostor-seam',width,height,requestedSamples,frames,commands,telemetry:{},frameRate:24,sourceHashes,fetchedAssets}));
console.log('Recorded seam test');
