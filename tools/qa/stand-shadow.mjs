import assert from 'node:assert/strict';
import {create, globals} from 'webgpu';
import {setStandPopulation, getGPUStandTexture, standLightingWGSL} from '../../dist/stand-envelope.js';
import {geometryShader} from '../../dist/shaders.js';

Object.assign(globalThis, globals);
const gpu = create(['backend=vulkan', 'enable-dawn-features=allow_unsafe_apis']);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('A native Vulkan adapter is required');
const device = await adapter.requestDevice();
device.pushErrorScope('validation');
const renderModule = device.createShaderModule({code: geometryShader});
const diagnostics = await renderModule.getCompilationInfo();
assert.deepEqual(diagnostics.messages.filter(message => message.type === 'error').map(message => message.message), []);

const tree = new Float32Array([0, 100, 0, 1, 0, 0.5, 0.5, 0.5]);
setStandPopulation(tree, () => 100);
const atlas = getGPUStandTexture(device);
const codes = [
  'standSunVisibility(vec3<f32>(-15.0,100.0,0.0),normalize(vec3<f32>(1.0,1.0,0.0)),0.0)',
  'standSunVisibility(vec3<f32>(15.0,100.0,0.0),normalize(vec3<f32>(1.0,1.0,0.0)),0.0)',
  'standSunVisibility(vec3<f32>(-15.0,100.0,0.0),normalize(vec3<f32>(-1.0,1.0,0.0)),0.0)',
  'standSunVisibility(vec3<f32>(15.0,100.0,0.0),normalize(vec3<f32>(-1.0,1.0,0.0)),0.0)',
  'standSunVisibility(vec3<f32>(0.0,126.0,0.0),vec3<f32>(0.0,1.0,0.0),0.0)',
  'standSunVisibility(vec3<f32>(-3.0,100.5,0.0),normalize(vec3<f32>(1.0,0.005,0.0)),0.0)',
];
const testModule = device.createShaderModule({code: `
  @group(0) @binding(0) var standEnvelope:texture_2d<f32>;
  @group(0) @binding(1) var standSampler:sampler;
  @group(0) @binding(2) var<storage,read_write> probes:array<f32>;
  ${standLightingWGSL}
  @compute @workgroup_size(1) fn main() {
    ${codes.map((code, i) => 'probes[' + i + ']=' + code + ';').join('\n')}
  }
`});
const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: testModule, entryPoint: 'main'}});
const bytes = codes.length * Float32Array.BYTES_PER_ELEMENT;
const output = device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
const readback = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
  {binding: 0, resource: atlas.createView()},
  {binding: 1, resource: device.createSampler({magFilter: 'linear', minFilter: 'linear'})},
  {binding: 2, resource: {buffer: output}},
]});
async function probe() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const values = Array.from(new Float32Array(readback.getMappedRange()));
  readback.unmap();
  return values;
}

const oneTree = await probe();
assert(oneTree[0] < 0.4 && oneTree[1] > 0.95, 'The receiver down-sun of the tree should be shaded');
assert(oneTree[2] > 0.95 && oneTree[3] < 0.4, 'The shadow must change sides when the sun reverses');
assert(oneTree[4] > 0.95, 'A receiver above the crown should see the sun');
assert(oneTree[5] > 0.9, 'Light below an isolated crown should pass through the gap above the ground');
setStandPopulation(new Float32Array(), () => 100);
assert.equal(getGPUStandTexture(device), atlas, 'Population rebuilds must preserve active bind groups');
const clearing = await probe();
assert(clearing.every(value => value > 0.99), 'Removing the tree must clear its shadow');
assert.equal(await device.popErrorScope(), null);
device.destroy();
console.log(JSON.stringify({oneTree, clearing, validationErrors: []}));
