import {makeHedgerow} from './hedgerow.js';
self.onmessage=()=>{
 const models=makeHedgerow();
 const buffers=models.flatMap(m=>[m.near.vertices.buffer,m.near.indices.buffer,m.far.vertices.buffer,m.far.indices.buffer,m.data.buffer,m.previous.buffer]);
 self.postMessage(models,buffers);
};
