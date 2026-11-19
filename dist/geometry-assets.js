// Packed close meshes expand once into the existing GPU vertex layout. Far
// geometry and previous source bundles keep their original float32 format.
export function decodeTreeVertices(bytes) {
 const buffer = bytes.buffer;
 const offset = bytes.byteOffset;
 if (bytes[0] !== 84 || bytes[1] !== 82 || bytes[2] !== 86 || bytes[3] !== 54) {
  return new Float32Array(buffer, offset, bytes.byteLength / 4);
 }
 const header = new DataView(buffer, offset, 32);
 const count = header.getUint32(4, true);
 if (bytes.byteLength !== 32 + count * 22) throw new Error('Incomplete packed tree mesh');
 const lower = [8,12,16].map(i => header.getFloat32(i, true));
 const scale = [20,24,28].map(i => header.getFloat32(i, true) / 65535);
 const words = new Uint16Array(buffer, offset + 32, count * 11);
 const signed = new Int8Array(buffer, offset + 32, count * 22);
 const data = bytes.subarray(32);
 const vertices = new Float32Array(count * 12);
 for (let i = 0; i < count; i++) {
  const word = i * 11, b = i * 22, vertex = i * 12;
  for (let axis = 0; axis < 3; axis++) {
   vertices[vertex + axis] = lower[axis] + words[word + axis] * scale[axis];
   const c = b + 8 + 3 * axis;
   // Float32 represents all integers through 2^24 exactly.
   vertices[vertex + 6 + axis] = data[c] + 256 * data[c + 1] + 65536 * data[c + 2];
  }
  let x = signed[b + 6] / 127, y = signed[b + 7] / 127;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
   const oldX = x;
   x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
   y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  const inverseLength = 1 / Math.sqrt(x*x + y*y + z*z);
  vertices[vertex + 3] = x * inverseLength;
  vertices[vertex + 4] = y * inverseLength;
  vertices[vertex + 5] = z * inverseLength;
  vertices[vertex + 9] = data[b + 17];
  vertices[vertex + 10] = words[word + 9] / 65535;
  vertices[vertex + 11] = words[word + 10] / 65535;
 }
 return vertices;
}

export async function loadRealTreeGeometry(directory='trees') {
 const entries=await Promise.all(['near','mid','canopy','far'].map(async level=>{
  const arrays=await Promise.all(['vertices','indices'].map(async part=>{
   const name=level+'-'+part+'.bin';
   const supplied=globalThis.forestGeometryBytes?.[directory+'/'+name]||(directory==='trees'?globalThis.forestGeometryBytes?.[name]:undefined);
   let bytes;
   if(supplied) {
    bytes=new Uint8Array(supplied);
   } else {
    const response=await fetch(new URL('./assets/'+directory+'/'+name,import.meta.url));
    if(!response.ok) throw new Error('Unable to load '+directory+'/'+name);
    bytes=new Uint8Array(await response.arrayBuffer());
   }
   return part==='vertices'?decodeTreeVertices(bytes):new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  }));
  return [level,{vertices:arrays[0],indices:arrays[1]}];
 }));
 return Object.fromEntries(entries);
}
