import { uniforms } from './shaders.js';

const TRIANGLES_PER_CLUSTER = 64;
const VERTICES_PER_CLUSTER = TRIANGLES_PER_CLUSTER * 3;
const MAX_VISIBLE_CLUSTERS = 500000;

function makeBuffer(device, data, usage, label) {
  const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  new data.constructor(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function mortonCoordinate(value) {
  let bits = value & 1023;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  return (bits | (bits << 2)) & 0x09249249;
}

/** Spatial ordering keeps the leaf clusters small enough for useful culling. */
export function buildMeshletData(mesh) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < mesh.vertices.length; vertex += 12) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], mesh.vertices[vertex + axis]);
      maximum[axis] = Math.max(maximum[axis], mesh.vertices[vertex + axis]);
    }
  }
  const extent = maximum.map((value, axis) => Math.max(0.0001, value - minimum[axis]));
  const triangleCount = mesh.indices.length / 3;
  const keys = new Uint32Array(triangleCount);
  let order = new Uint32Array(triangleCount);
  let scratch = new Uint32Array(triangleCount);
  const quantized = new Uint32Array(3);
  const bins = new Uint32Array(1024);
  for (let t = 0; t < triangleCount; t++) {
    const first = t * 3;
    const a = mesh.indices[first] * 12;
    const b = mesh.indices[first + 1] * 12;
    const c = mesh.indices[first + 2] * 12;
    for (let axis = 0; axis < 3; axis++) {
      const center = (mesh.vertices[a+axis] + mesh.vertices[b+axis] + mesh.vertices[c+axis]) / 3;
      quantized[axis] = Math.max(0, Math.min(1023, (center - minimum[axis]) / extent[axis] * 1023));
    }
    keys[t] = mortonCoordinate(quantized[0]) | mortonCoordinate(quantized[1]) << 1 | mortonCoordinate(quantized[2]) << 2;
    order[t] = t;
  }
  // Three stable radix passes avoid a JavaScript object for every triangle.
  for (let shift = 0; shift < 30; shift += 10) {
    bins.fill(0);
    for (let i = 0; i < triangleCount; i++) bins[keys[order[i]] >>> shift & 1023]++;
    let prefix = 0;
    for (let bin = 0; bin < bins.length; bin++) {
      const count = bins[bin];
      bins[bin] = prefix;
      prefix += count;
    }
    for (let i = 0; i < triangleCount; i++) {
      const id = order[i];
      scratch[bins[keys[id] >>> shift & 1023]++] = id;
    }
    [order, scratch] = [scratch, order];
  }
  const orderedIndices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < triangleCount; t++) {
    const source = order[t] * 3;
    orderedIndices[t*3] = mesh.indices[source];
    orderedIndices[t*3+1] = mesh.indices[source+1];
    orderedIndices[t*3+2] = mesh.indices[source+2];
  }
  const count = Math.ceil(orderedIndices.length / VERTICES_PER_CLUSTER);
  const packed = new ArrayBuffer(count * 32);
  const floats = new Float32Array(packed);
  const integers = new Uint32Array(packed);
  for (let cluster = 0; cluster < count; cluster++) {
    const first = cluster * VERTICES_PER_CLUSTER;
    const end = Math.min(first + VERTICES_PER_CLUSTER, orderedIndices.length);
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i < end; i++) {
      const vertex = orderedIndices[i] * 12;
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], mesh.vertices[vertex + axis]);
        high[axis] = Math.max(high[axis], mesh.vertices[vertex + axis]);
      }
    }
    const center = low.map((value, axis) => (value + high[axis]) * 0.5);
    let radius = 0;
    for (let i = first; i < end; i++) {
      const vertex = orderedIndices[i] * 12;
      const x = mesh.vertices[vertex] - center[0];
      const y = mesh.vertices[vertex+1] - center[1];
      const z = mesh.vertices[vertex+2] - center[2];
      radius = Math.max(radius, x*x+y*y+z*z);
    }
    floats.set([...center, Math.sqrt(radius) + 0.001], cluster * 8);
    integers[cluster * 8 + 4] = first;
    integers[cluster * 8 + 5] = end - first;
  }
  return { indices: orderedIndices, clusters: new Uint32Array(packed), count };
}

export const meshletCullShader = uniforms + /* wgsl */`
struct TreeTransform { position:vec4<f32>, variation:vec4<f32> };
struct ClusterBounds { center:vec3<f32>, radius:f32, firstIndex:u32, indexCount:u32, padding:vec2<u32> };
struct DrawArguments { vertexCount:u32, instanceCount:atomic<u32>, firstVertex:u32, firstInstance:u32 };
@group(0) @binding(1) var<storage,read> treeTransforms:array<TreeTransform>;
@group(0) @binding(2) var<storage,read> nearTreeIds:array<u32>;
@group(0) @binding(3) var<storage,read> sourceArguments:array<u32>;
@group(0) @binding(4) var<storage,read> clusterBounds:array<ClusterBounds>;
@group(0) @binding(5) var<storage,read_write> compactedClusters:array<vec2<u32>>;
@group(0) @binding(6) var<storage,read_write> outputArguments:DrawArguments;

fn outsidePlane(plane:vec4<f32>, center:vec3<f32>, radius:f32)->bool {
  return dot(plane,vec4<f32>(center,1.0)) < -radius*length(plane.xyz);
}

@compute @workgroup_size(64)
fn cullMeshlets(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.y >= sourceArguments[1] || id.x >= arrayLength(&clusterBounds)) {return;}
  let treeId=nearTreeIds[id.y];
  let tree=treeTransforms[treeId];
  let cs=cos(tree.variation.x);
  let sn=sin(tree.variation.x);
  let row0=vec4<f32>(u.vp[0].x,u.vp[1].x,u.vp[2].x,u.vp[3].x);
  let row1=vec4<f32>(u.vp[0].y,u.vp[1].y,u.vp[2].y,u.vp[3].y);
  let row2=vec4<f32>(u.vp[0].z,u.vp[1].z,u.vp[2].z,u.vp[3].z);
  let row3=vec4<f32>(u.vp[0].w,u.vp[1].w,u.vp[2].w,u.vp[3].w);
  let clusterId=id.x;
  let cluster=clusterBounds[clusterId];
  var local=cluster.center*tree.position.w;
  local.x*=0.78+tree.variation.z*0.48;local.z*=0.78+tree.variation.z*0.48;
  let center=vec3<f32>(local.x*cs+local.z*sn,local.y,-local.x*sn+local.z*cs)+tree.position.xyz;
  let radius=cluster.radius*tree.position.w*1.3+abs(u.resolution.w)*0.60;
  if(outsidePlane(row3+row0,center,radius) || outsidePlane(row3-row0,center,radius) ||
     outsidePlane(row3+row1,center,radius) || outsidePlane(row3-row1,center,radius) ||
     outsidePlane(row2,center,radius) || outsidePlane(row3-row2,center,radius)) {return;}
  let slot=atomicAdd(&outputArguments.instanceCount,1u);
  if(slot<arrayLength(&compactedClusters)) {
    compactedClusters[slot]=vec2<u32>(treeId,clusterId);
  } else {
    // Every overflow reservation is returned, so the final indirect count
    // stays within capacity even when multiple workgroups reach the limit.
    atomicSub(&outputArguments.instanceCount,1u);
  }
}
`;

export const meshletVertexShader = /* wgsl */`
struct MeshletCluster { center:vec3<f32>, radius:f32, firstIndex:u32, indexCount:u32, padding:vec2<u32> };
@group(3) @binding(0) var<storage,read> meshletVertices:array<f32>;
@group(3) @binding(1) var<storage,read> meshletIndices:array<u32>;
@group(3) @binding(2) var<storage,read> meshletClusters:array<MeshletCluster>;
@group(3) @binding(3) var<storage,read> meshletPairs:array<vec2<u32>>;

@vertex fn meshletVS(@builtin(vertex_index) vertexId:u32,@builtin(instance_index) instanceId:u32)->VertexOut {
  let pair=meshletPairs[instanceId];
  let cluster=meshletClusters[pair.y];
  var out:VertexOut;
  if(vertexId>=cluster.indexCount) {
    out.clip=vec4<f32>(0.0,0.0,2.0,1.0);
    out.world=vec3<f32>(0.0);out.normal=vec3<f32>(0.0,1.0,0.0);
    out.color=vec3<f32>(0.0);out.extra=vec3<f32>(0.0);out.crownLight=vec2<f32>(1.0);
    return out;
  }
  let offset=meshletIndices[cluster.firstIndex+vertexId]*12u;
  let position=vec3<f32>(meshletVertices[offset],meshletVertices[offset+1u],meshletVertices[offset+2u]);
  let normal=vec3<f32>(meshletVertices[offset+3u],meshletVertices[offset+4u],meshletVertices[offset+5u]);
  let color=vec3<f32>(meshletVertices[offset+6u],meshletVertices[offset+7u],meshletVertices[offset+8u]);
  let extra=vec3<f32>(meshletVertices[offset+9u],meshletVertices[offset+10u],meshletVertices[offset+11u]);
  let tree=instances[pair.x];
  let yaw=tree.variation.x;
  let cs=cos(yaw);let sn=sin(yaw);
  var local=position*tree.position.w;
  local.x*=0.78+tree.variation.z*0.48;local.z*=0.78+tree.variation.z*0.48;
  let wind=select(extra.y,0.5+local.y*0.02,extra.x>4.5);
  let presentBend=windOffset(tree.position.xyz,local.y,wind,u.resolution.z,u.resolution.w);
  let priorBend=windOffset(tree.position.xyz,local.y,wind,u.previousEyeTime.w,u.sun.w);
  local.xz+=presentBend;
  let bendDelta=priorBend-presentBend;
  let worldBend=vec3<f32>(bendDelta.x*cs+bendDelta.y*sn,0.0,-bendDelta.x*sn+bendDelta.y*cs);
  let world=vec3<f32>(local.x*cs+local.z*sn,local.y,-local.x*sn+local.z*cs)+tree.position.xyz;
  out.windMotion=projectedWindDelta(world,worldBend);
  out.world=world;out.clip=u.vp*vec4<f32>(world,1.0);
  out.normal=vec3<f32>(normal.x*cs+normal.z*sn,normal.y*(0.78+tree.variation.z*0.48),-normal.x*sn+normal.z*cs);
  out.color=color*mix(vec3<f32>(0.80,0.88,0.72),vec3<f32>(1.12,1.07,0.91),tree.variation.y);
  out.extra=extra;out.coveragePhase=shootPhase(tree.variation.w,position,extra.yz);
  out.crownLight=crownVisibilityForMaterial(position,tree.variation.x,extra.x);
  if(color.z>16000000.0) {
    out.crownLight=measuredCrownVisibility(color,u.sun.xyz,yaw,0.78+tree.variation.z*0.48);
    out.color=vec3<f32>(1.0);
  }
  if(extra.x>4.5 && extra.x<6.5) {out.color=treeLeafPigment(tree.variation.y,extra.x>5.5);}
  return out;
}
`;

async function compile(device, code, label) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length) throw new Error(label + '\n' + errors.map(error => `${error.lineNum}:${error.linePos} ${error.message}`).join('\n'));
  return module;
}

import { normalFormat, vegetationSampling } from './sample-coverage.js';

export async function createMeshletRenderer(device, { mesh, uniformBuffer, uniformLayout, instanceLayout, lightLayout, geometryShader, trees }) {
  const packed = buildMeshletData(mesh);
  const vertexBuffer = makeBuffer(device, mesh.vertices, GPUBufferUsage.STORAGE, 'Meshlet vertex attributes');
  const indexBuffer = makeBuffer(device, packed.indices, GPUBufferUsage.STORAGE, 'Spatially ordered meshlet indices');
  const clusterBuffer = makeBuffer(device, packed.clusters, GPUBufferUsage.STORAGE, 'Meshlet sphere bounds');
  const pairBuffer = device.createBuffer({ label:'Compacted visible tree and meshlet pairs', size:MAX_VISIBLE_CLUSTERS * 8, usage:GPUBufferUsage.STORAGE });
  const argumentsBuffer = makeBuffer(device, new Uint32Array([VERTICES_PER_CLUSTER, 0, 0, 0]), GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'Meshlet indirect draw');
  const [computeModule, renderModule] = await Promise.all([
    compile(device, meshletCullShader, 'GPU meshlet frustum culling'),
    compile(device, geometryShader + meshletVertexShader, 'Meshlet vertex pulling and forest lighting'),
  ]);
  const clusterLayout = device.createBindGroupLayout({ entries:[0, 1, 2, 3].map(binding => ({ binding, visibility:GPUShaderStage.VERTEX, buffer:{ type:'read-only-storage' } })) });
  const pipeline = await device.createRenderPipelineAsync({
    label:'Detailed foliage meshlets', multisample:vegetationSampling,
    layout:device.createPipelineLayout({ bindGroupLayouts:[uniformLayout, instanceLayout, lightLayout, clusterLayout] }),
    vertex:{ module:renderModule, entryPoint:'meshletVS' },
    fragment:{ module:renderModule, entryPoint:'geometryFS', constants:{nearTreePass:1}, targets:[{ format:'rgba16float' }, { format:normalFormat }] },
    primitive:{ topology:'triangle-list', cullMode:'none' },
    depthStencil:{ format:'depth32float', depthWriteEnabled:true, depthCompare:'less' },
  });
  const cullPipeline = await device.createComputePipelineAsync({ label:'Cull detailed tree meshlets', layout:'auto', compute:{ module:computeModule, entryPoint:'cullMeshlets' } });
  const geometryGroup = device.createBindGroup({ layout:clusterLayout, entries:[vertexBuffer, indexBuffer, clusterBuffer, pairBuffer].map((buffer, binding) => ({ binding, resource:{ buffer } })) });
  const dispatch = makeBuffer(device, new Uint32Array([Math.ceil(packed.count / 64), 0, 1]),
    GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, 'Meshlet batches by visible tree');
  const resetArguments = new Uint32Array([VERTICES_PER_CLUSTER, 0, 0, 0]);
  let population, cullGroup, instanceGroup;
  function setPopulation(nextTrees) {
    population = nextTrees;
    cullGroup = device.createBindGroup({
      layout:cullPipeline.getBindGroupLayout(0),
      entries:[uniformBuffer, population.instances, population.visible, population.indirect, clusterBuffer, pairBuffer, argumentsBuffer].map((buffer, binding) => ({ binding, resource:{ buffer } })),
    });
    instanceGroup = device.createBindGroup({ layout:instanceLayout, entries:[
      { binding:0, resource:{ buffer:population.instances } },
      { binding:1, resource:{ buffer:population.visible, offset:0, size:population.capacity * 4 } },
    ] });
  }
  setPopulation(trees);
  return {
    counterBuffer:argumentsBuffer,
    stats:{ clusters:packed.count, trianglesPerCluster:TRIANGLES_PER_CLUSTER },
    setPopulation,
    cull(encoder) {
      device.queue.writeBuffer(argumentsBuffer, 0, resetArguments);
      // Each Y row corresponds to one compacted near tree. X lanes test its
      // clusters in parallel. The previous tree pass produced the row count.
      encoder.copyBufferToBuffer(population.indirect, 4, dispatch, 4, 4);
      const pass = encoder.beginComputePass({ label:'Select visible near-tree meshlets' });
      pass.setPipeline(cullPipeline);
      pass.setBindGroup(0, cullGroup);
      pass.dispatchWorkgroupsIndirect(dispatch, 0);
      pass.end();
    },
    draw(pass, uniformGroup, lightGroup) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, uniformGroup);
      pass.setBindGroup(1, instanceGroup);
      pass.setBindGroup(2, lightGroup);
      pass.setBindGroup(3, geometryGroup);
      pass.drawIndirect(argumentsBuffer, 0);
    },
    destroy() {
      device.queue.onSubmittedWorkDone().then(() => {
        for (const buffer of [vertexBuffer, indexBuffer, clusterBuffer, pairBuffer, argumentsBuffer, dispatch]) buffer.destroy();
      });
    },
  };
}
