import {upperMeadow,closeMeadow} from './meadow-botany.js';

export const MEADOW_NAMES=['bermuda','grass','celandine','dandelion'];

async function basalPatch(name,index) {
  const arrays=await Promise.all(['vertices','indices'].map(async part=>{
    const filename=name+'-'+part+'.bin';
    const supplied=globalThis.forestGeometryBytes?.['meadow/'+filename];
    let bytes;
    if(supplied)bytes=new Uint8Array(supplied);
    else {
      const response=await fetch(new URL('./assets/meadow/'+filename,import.meta.url));
      if(!response.ok)throw new Error('Unable to load meadow specimen '+name+'.');
      bytes=new Uint8Array(await response.arrayBuffer());
    }
    if(bytes.byteLength%4)throw new Error('Invalid meadow geometry '+filename+'.');
    return part==='vertices'?new Float32Array(bytes.buffer):new Uint32Array(bytes.buffer);
  }));
  return {name,vertices:arrays[0],indices:arrays[1],material:7+index,arrayLayer:5+index};
}

export async function loadMeadowGeometry() {
  const bases=await Promise.all(MEADOW_NAMES.slice(0,2).map(basalPatch));
  return MEADOW_NAMES.map((_,index)=>{
    const base=bases[index%2];
    return {...upperMeadow(base,index),far:upperMeadow(base,index,true)};
  });
}

export {closeMeadow};
