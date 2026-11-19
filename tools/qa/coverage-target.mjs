import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createCoverageTarget} from '../../dist/gl-coverage-target.js';

const enums={SAMPLES:0x80a9,FRAMEBUFFER:0x8d40,READ_FRAMEBUFFER:0x8ca8,DRAW_FRAMEBUFFER:0x8ca9,
  RENDERBUFFER:0x8d41,RGBA8:0x8058,DEPTH_COMPONENT24:0x81a6,DEPTH_COMPONENT16:0x81a5,MAX_RENDERBUFFER_SIZE:0x84e8,
  FRAMEBUFFER_COMPLETE:0x8cd5,COLOR_ATTACHMENT0:0x8ce0,DEPTH_ATTACHMENT:0x8d00,COLOR_BUFFER_BIT:0x4000,
  LINEAR:0x2601,NEAREST:0x2600,SCISSOR_TEST:0x0c11};
const output=process.env.FOREST_GLES_OUTPUT;
for(const [name,base,support,failedResize] of [
  ['default-four',4,[4],false],['default-two',2,[4,2],false],['owned-four',0,[4,2],false],
  ['owned-two',0,[2],false],['preserve',0,[4],true],['single',0,[],false],
  ['no-allocation',0,[4],false]
]) {
  let id=1,complete=name!=='no-allocation',live=0;
  const commands=[];
  const gl=new Proxy(enums,{get(obj,k) {
    if(k in obj)return obj[k];
    if(k==='getParameter')return p=>p===enums.SAMPLES?base:16384;
    if(k==='getInternalformatParameter')return()=>Int32Array.from(support);
    if(k==='checkFramebufferStatus')return()=>complete?enums.FRAMEBUFFER_COMPLETE:0;
    return (...args)=>{
      const cmd={name:k,args};commands.push(cmd);
      if(k.startsWith('create')){live++;cmd.id=id++;return {ref:cmd.id};}
      if(k.startsWith('delete'))live--;
    };
  }});
  const target=createCoverageTarget(gl,16,16);
  const expected=base||(name==='no-allocation'?0:support[0])||0;
  assert.equal(target.samples,expected);
  if(failedResize)complete=false;
  target.resize(32,24);
  target.bindScene(32,24);
  const viewport=commands.findLast(c=>c.name==='viewport').args.slice(2);
  assert.deepEqual(viewport,failedResize?[16,16]:[32,24]);
  // A nonuniform native readback detects blank or incorrectly bound resolves.
  gl.disable(gl.SCISSOR_TEST);gl.clearColor(.1,.16,.21,1);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,viewport[0]>>>1,viewport[1]);gl.clearColor(.91,.61,.34,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
  target.present(32,24);
  const blits=commands.filter(c=>c.name==='blitFramebuffer');
  assert.equal(blits.length,!base&&expected?2:0);
  if(failedResize)assert.equal(blits[1].args.at(-1),gl.LINEAR);
  if(base)assert(!commands.some(c=>c.name==='createRenderbuffer'));
  target.dispose();assert.equal(live,0);
  console.log(name,JSON.stringify({samples:expected,blits:blits.length,viewport}));
  if(output&&name!=='no-allocation'&&!failedResize) {
    const dir=path.join(output,name);await fs.mkdir(dir,{recursive:true});
    const record={width:32,height:24,requestedSamples:base,scene:name,commands,frames:[{index:0,endCommand:commands.length}],
      telemetry:{samples:expected},frameRate:24,sourceHashes:{},fetchedAssets:{}};
    await fs.writeFile(path.join(dir,'commands.json'),JSON.stringify(record));
  }
}
