import assert from 'node:assert/strict';
import { createScreenshotCapture } from '../../dist/screenshot.js';

const states = [], downloads = [], encodes = [], deadlines = new Set();
const timers = {
  setTimeout(callback) { deadlines.add(callback); return callback; },
  clearTimeout(callback) { deadlines.delete(callback); }
};
const capture = createScreenshotCapture({
  timers,
  report: (message, busy) => states.push({message, busy}),
  encode: callback => encodes.push(callback),
  download: blob => downloads.push(blob)
});
capture.request();
capture.request();
capture.afterDraw();
capture.afterDraw();
assert.equal(encodes.length, 1);
const frame = new Blob(['frame']);
encodes.shift()(frame);
assert.deepEqual(downloads, [frame]);
assert.equal(states.at(-1).busy, false);
assert.equal(deadlines.size, 0);
// No animation frame arrives, or the encoder completes after a timeout.
for (const encoding of [false, true]) {
  capture.request();
  if (encoding) capture.afterDraw();
  [...deadlines][0]();
  assert.match(states.at(-1).message, /timed out/);
  capture.request();
  encodes.shift()?.(frame);
  assert.equal(states.at(-1).busy, true);
  capture.cancel();
}
for (const result of [null, new Blob()]) {
  capture.request();capture.afterDraw();encodes.shift()(result);
  assert.equal(states.at(-1).busy, false);
  assert.match(states.at(-1).message, /could not be captured/);
}
assert.equal(downloads.length, 1);
assert.equal(deadlines.size, 0);
for (const failure of ['encode', 'download']) {
  const broken = createScreenshotCapture({timers,
    report: (message,busy) => states.push({message,busy}),
    encode: cb => { if (failure === 'encode') throw Error(); cb(frame); },
    download: () => { throw Error(); }
  });
  broken.request();broken.afterDraw();
  assert.equal(states.at(-1).busy,false);
  assert.match(states.at(-1).message,/could not/);
  assert.equal(deadlines.size,0);
}
console.log('Screenshot delivery, retry, interruption, timeout, empty frames, exceptions and duplicate requests passed.');
