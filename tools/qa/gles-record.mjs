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
const enums={TEXTURE_COMPARE_MODE:0x884c,COMPARE_REF_TO_TEXTURE:0x884e,MAX_TEXTURE_SIZE:0x0d33,SAMPLES:0x80a9,SAMPLE_BUFFERS:0x80a8,SAMPLE_ALPHA_TO_COVERAGE:0x809e,ARRAY_BUFFER:0x8892,CLAMP_TO_EDGE:0x812f,COMPILE_STATUS:0x8b81,DEPTH_ATTACHMENT:0x8d00,DEPTH_BUFFER_BIT:0x100,DEPTH_COMPONENT:0x1902,DEPTH_COMPONENT24:0x81a6,DEPTH_TEST:0xb71,DYNAMIC_DRAW:0x88e8,ELEMENT_ARRAY_BUFFER:0x8893,FLOAT:0x1406,FRAGMENT_SHADER:0x8b30,FRAMEBUFFER:0x8d40,FRAMEBUFFER_COMPLETE:0x8cd5,LINEAR:0x2601,LINEAR_MIPMAP_LINEAR:0x2703,LINK_STATUS:0x8b82,NEAREST:0x2600,NONE:0,POLYGON_OFFSET_FILL:0x8037,R11F_G11F_B10F:0x8c3a,R8:0x8229,RED:0x1903,RENDERER:0x1f01,REPEAT:0x2901,RGB:0x1907,RGBA:0x1908,RGBA8:0x8058,SRGB8_ALPHA8:0x8c43,STATIC_DRAW:0x88e4,TEXTURE0:0x84c0,TEXTURE1:0x84c1,TEXTURE2:0x84c2,TEXTURE3:0x84c3,TEXTURE4:0x84c4,TEXTURE_3D:0x806f,TEXTURE_WRAP_R:0x8072,TEXTURE_2D:0xde1,TEXTURE_2D_ARRAY:0x8c1a,TEXTURE_MAG_FILTER:0x2800,TEXTURE_MAX_LEVEL:0x813d,TEXTURE_MIN_FILTER:0x2801,TEXTURE_WRAP_S:0x2802,TEXTURE_WRAP_T:0x2803,TRIANGLES:4,UNSIGNED_BYTE:0x1401,UNSIGNED_INT:0x1405,UNSIGNED_INT_10F_11F_11F_REV:0x8c3b,UNSIGNED_SHORT:0x1403,VERTEX_SHADER:0x8b31};
Object.assign(enums,{RENDERBUFFER:0x8d41,COLOR_ATTACHMENT0:0x8ce0,DEPTH_COMPONENT16:0x81a5,MAX_RENDERBUFFER_SIZE:0x84e8,READ_FRAMEBUFFER:0x8ca8,DRAW_FRAMEBUFFER:0x8ca9});
let id=1;const commands=[],hashes=new Set();
function encode(v){if(ArrayBuffer.isView(v)){const b=Buffer.from(v.buffer,v.byteOffset,v.byteLength);const hash=crypto.createHash('sha1').update(b).digest('hex');if(!hashes.has(hash)){if(process.env.TEST_HASHES_ONLY!=='1')fs.writeFileSync(dir+'/'+hash+'.bin',b);hashes.add(hash);}return {data:hash+'.bin',bytes:b.length};}if(Array.isArray(v))return v.map(encode);return v;}
const gl=new Proxy(enums,{get(t,k){if(k in t)return t[k];if(k==='getShaderParameter'||k==='getProgramParameter')return()=>true;if(k==='getShaderInfoLog'||k==='getProgramInfoLog')return()=>'';if(k==='getInternalformatParameter')return()=>new Int32Array([4]);if(k==='getParameter')return parameter=>{if(parameter===enums.MAX_RENDERBUFFER_SIZE)return 16384;if(parameter===enums.RENDERER)return 'Native GLES replay';if(parameter===enums.MAX_TEXTURE_SIZE)return 16384;if(parameter===enums.SAMPLES)return requestedSamples;if(parameter===enums.SAMPLE_BUFFERS)return requestedSamples>0?1:0;throw new Error('Unsupported GLES record query '+parameter);};if(k==='getContextAttributes')return()=>({antialias:requestedSamples>0,alpha:false});if(k==='getError')return()=>0;if(k==='checkFramebufferStatus')return()=>enums.FRAMEBUFFER_COMPLETE;return (...args)=>{if(k==='bufferSubData'&&args.length>3){args=[...args.slice(0,2),args[2].subarray(args[3],args[3]+args[4])];}if(k.startsWith('create')||k==='getUniformLocation'){const result={ref:id++};commands.push({name:k,args:args.map(encode),id:result.ref});return result;}commands.push({name:k,args:args.map(encode)});};}});
const width=Number(process.env.TEST_WIDTH||1024),height=Number(process.env.TEST_HEIGHT||576);const noop=()=>{};
const canvas={width,height,clientWidth:width,clientHeight:height,getContext:()=>gl,addEventListener:noop};
const element=()=>({style:{},classList:{add:noop,remove:noop,toggle:noop},append:noop,setAttribute:noop,addEventListener:noop,textContent:''});const nodes=new Map();
globalThis.document={getElementById:n=>{if(!nodes.has(n))nodes.set(n,element());return nodes.get(n);},createElement:element};globalThis.devicePixelRatio=1;globalThis.requestAnimationFrame=fn=>setImmediate(fn);
globalThis.fetch=async url=>{const b=asset(url);return {ok:true,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),json:async()=>JSON.parse(b.toString())};};
globalThis.forestImpostorMetadata={};globalThis.forestImpostorBytes={};
for(const species of ['oak','jacaranda']){forestImpostorMetadata[species]=JSON.parse(asset(new URL('../../dist/assets/impostors/'+species+'.json',import.meta.url)));for(const kind of ['albedo','normal'])forestImpostorBytes[species+'-'+kind]=(await decodeRGBA8PNG(Uint8Array.from(asset(new URL('../../dist/assets/impostors/'+species+'-'+kind+'.png',import.meta.url))).buffer)).bytes;}
function vectorSetting(key,fallback) {
  if(process.env[key]===undefined)return fallback;
  const value=JSON.parse(process.env[key]);
  if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))throw Error(key+' must be a three-element position');
  return value;
}
const scene=process.argv[2]||'meadow';const preset=scene==='forest'?{position:[-345,terrainSurfaceHeight(-345,-75)+1.85,-75],target:[-425,terrainHeight(-425,-160)+8,-160]}
 :scene==='botany'?{position:[-170,terrainSurfaceHeight(-170,206)+.79,206],target:[-169.63,terrainSurfaceHeight(-169.63,204.89)+.35,204.89]}:CAMERA_START;
const start={position:vectorSetting('TEST_CAMERA_POSITION',preset.position),target:vectorSetting('TEST_CAMERA_TARGET',preset.target)};
const dx=start.target[0]-start.position[0],dy=start.target[1]-start.position[1],dz=start.target[2]-start.position[2];
const camera={position:[...start.position],yaw:Math.atan2(dx,-dz),pitch:Math.atan2(dy,Math.hypot(dx,dz))};
const {startFallback}=await import('../../dist/fallback.js');const telemetry={gpuErrors:[],volumeUpdates:0,counts:[0,0,0,0],fps:0};
globalThis.window={FOREST_TEST:true};
const {settings}=await import('../../dist/main.js');
for(const [key,variable] of [['wind','TEST_WIND'],['sunElevation','TEST_SUN_ELEVATION'],['sunAzimuth','TEST_SUN_AZIMUTH']]) {
  if(process.env[variable]===undefined)continue;
  const value=Number(process.env[variable]);
  if(!Number.isFinite(value))throw Error('Invalid '+variable);
  settings[key]=value;
}
const startTime=Number(process.env.TEST_TIME??1);
const renderer=await startFallback(canvas,{settings,telemetry,getCamera:()=>camera,setLoading:noop,setError:e=>{throw Error(e);}});
const frameCount=Number(process.env.TEST_FRAMES||1);
const frameRate=Number(process.env.TEST_FPS||24);
const travel=Number(process.env.TEST_TRAVEL||2.7);
const forwardTravel=Number(process.env.TEST_FORWARD||0);
const pan=Number(process.env.TEST_PAN||0)*Math.PI/180;
const startYaw=camera.yaw;
const frames=[];
const initialPosition=[...camera.position];
const clearance=initialPosition[1]-terrainSurfaceHeight(initialPosition[0],initialPosition[2]);
for(let index=0;index<frameCount;index++) {
  const seconds=index/frameRate;
  const progress=frameCount>1?index/(frameCount-1):0;
  const distance=travel*progress;
  camera.position[0]=initialPosition[0]+Math.cos(startYaw)*distance+Math.sin(startYaw)*forwardTravel*progress;
  camera.position[2]=initialPosition[2]+Math.sin(startYaw)*distance-Math.cos(startYaw)*forwardTravel*progress;
  camera.yaw=startYaw+pan*progress*progress*(3-2*progress);
  if(distance!==0||forwardTravel*progress!==0)camera.position[1]=terrainSurfaceHeight(camera.position[0],camera.position[2])+clearance;
  renderer.render(startTime+seconds);
  frames.push({index,seconds,camera:[...camera.position],yaw:camera.yaw,pitch:camera.pitch,endCommand:commands.length,triangles:telemetry.triangles});
}
if(JSON.stringify(sourceHashes)!==JSON.stringify(fingerprint()))throw Error('Application source changed during camera recording');
const record={scene,settings:{...settings},startTime,width:canvas.width,height:canvas.height,requestedSamples,frameRate,frames,commands,telemetry,sourceHashes,fetchedAssets};
fs.writeFileSync(dir+'/commands.json',JSON.stringify(record));
console.log('Recorded',frames.length,'frames,',commands.length,'commands and',hashes.size,'binary payloads');
