// The full RGB HDR is sampled separately. This linear-filtered stop gain recovers
// the original high-resolution luminance without a second RGB float panorama.
const SKY_DETAIL_URL = new URL('./assets/sky-detail.bin', import.meta.url);

async function readSkyDetail(maximumWidth) {
  if (typeof DecompressionStream === 'undefined') {
    return [{ width: 1, height: 1, bytes: new Uint8Array([128]) }];
  }
  const fixture = globalThis.forestMaterialBytes?.['sky-detail'];
  const response = fixture ? null : await fetch(SKY_DETAIL_URL);
  if (response && !response.ok) throw new Error('Unable to load high-resolution cloud detail.');
  const bytes = fixture || new Uint8Array(await response.arrayBuffer());
  const table = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (table.getUint32(0) !== 0x534b5947 || table.getUint16(4, true) !== 1) {
    throw new Error('Unrecognized cloud detail texture.');
  }
  const count = table.getUint16(6, true);
  const levels = [];
  for (let mip = 0; mip < count; mip++) {
    const entry = 8 + 16 * mip;
    const width = table.getUint32(entry, true);
    const height = table.getUint32(entry + 4, true);
    const start = table.getUint32(entry + 8, true);
    const length = table.getUint32(entry + 12, true);
    if (width > maximumWidth) continue;
    const stream = new Blob([bytes.subarray(start, start + length)]).stream();
    const decoded = await new Response(stream.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    if (decoded.byteLength !== width * height) throw new Error('Incomplete cloud detail mip.');
    levels.push({ width, height, bytes: new Uint8Array(decoded) });
  }
  if (!levels.length) throw new Error('No supported cloud detail resolution.');
  return levels;
}

export async function gpuSkyDetail(device) {
  const levels = await readSkyDetail(device.limits.maxTextureDimension2D);
  const texture = device.createTexture({
    label: 'Photographic sky luminance detail',
    size: [levels[0].width, levels[0].height],
    mipLevelCount: levels.length,
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  levels.forEach(({ width, height, bytes }, mipLevel) => {
    device.queue.writeTexture({ texture, mipLevel }, bytes, { bytesPerRow: width }, [width, height]);
  });
  return texture;
}

export async function glSkyDetail(gl) {
  const maximum = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 8192;
  const levels = await readSkyDetail(maximum);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  levels.forEach(({ width, height, bytes }, mip) => {
    gl.texImage2D(gl.TEXTURE_2D, mip, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  });
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
