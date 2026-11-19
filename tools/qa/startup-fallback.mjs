// A partial WebGPU startup must leave WebGL a fresh canvas and the UI a usable fallback.
import assert from 'node:assert/strict';
const acquired = [];
let released = false, destroyed = false, nextCanvas;
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id,{ id, hidden:false, textContent:'', querySelectorAll:()=>[],pause() {} });
  return nodes.get(id);
};
const original = node('scene');
original.getContext = kind => {
  acquired.push([kind,'original']);
  return {configure() { throw Error('Unsupported canvas format'); },unconfigure() { released=true; }};
};
original.cloneNode = () => nextCanvas = {getContext(kind) { acquired.push([kind,'fresh']); return null; }};
original.replaceWith = next => {nodes.set('scene',next);};
const device = {addEventListener(){}, lost:new Promise(()=>{}), pushErrorScope(){},destroy(){destroyed=true;}};
Object.defineProperty(globalThis,'navigator',{value:{gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'rgba8unorm'}}});
globalThis.GPUTextureUsage = {RENDER_ATTACHMENT:1,COPY_SRC:2};
globalThis.document={getElementById:node};
globalThis.window={};globalThis.location={search:''};
await import('../../dist/main.js');
for(let i=0;i<100&&window.forestDiagnostics.status!=='recorded-views';i++) await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(window.forestDiagnostics.status,'recorded-views');
assert.equal(window.forestDiagnostics.webgpuStartupError,'Unsupported canvas format');
assert.deepEqual(acquired,[['webgpu','original'],['webgl2','fresh']]);
assert(released&&destroyed&&nextCanvas.hidden);
assert.equal(node('saveRendered').href,'./preview.jpg');
console.log('Released partial GPU initialization, retried on fresh WebGL canvas, and exposed a downloadable render.');
