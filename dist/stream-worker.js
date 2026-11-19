import {buildMeadowTiles} from './meadow-cull.js';
import { buildStreamingData } from './streaming.js';
import { createGrassInstances } from './landscape.js';

let treeData = new Float32Array(0);
let currentGeneration = 0;

self.onmessage = ({ data }) => {
  if(data.type==='grass') {
    const grass=createGrassInstances(data.count,data.center[0],data.center[1],data.spacing||0.4);
    const boxes=data.envelope?buildMeadowTiles(grass,data.envelope):undefined;
    self.postMessage({type:'grass',center:data.center,kind:data.kind,generation:data.generation,grass,boxes},boxes?[grass.buffer,boxes.buffer]:[grass.buffer]);
    return;
  }
  if (data.type === 'trees') {
    treeData = data.data;
    currentGeneration = data.generation;
    return;
  }
  if (data.type !== 'stream' || data.generation !== currentGeneration) return;
  try {
    const result = buildStreamingData({
      camera: data.camera,
      treeData,
      grassCenter: data.grassCenter,
      grassCount: data.grassCount,
      force: data.force,
    });
    const transfers = [result.voxels.buffer];
    if (result.grass) transfers.push(result.grass.buffer);
    self.postMessage({ type: 'stream', generation: currentGeneration, ...result }, transfers);
  } catch (error) {
    self.postMessage({ type: 'error', generation: currentGeneration, message: error.message });
  }
};
