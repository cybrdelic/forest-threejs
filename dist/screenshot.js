// A canvas with a transient back buffer must be captured in the same task as its draw.
export function createScreenshotCapture({ encode, download, report, timeout = 12000, timers = globalThis }) {
  let pending;

  function settle(request, message, blob) {
    if (pending !== request) return;
    timers.clearTimeout(request.timer);
    pending = undefined;
    if (blob) {
      try { download(blob); }
      catch { message = 'The download could not start. Try capturing again.'; }
    }
    report(message, false);
  }

  return {
    request() {
      if (pending) return;
      const request = { encoding: false };
      pending = request;
      request.timer = timers.setTimeout(() => settle(request, 'Capture timed out. Try again when the scene is moving.'), timeout);
      report('Capturing this view…', true);
    },
    afterDraw() {
      const request = pending;
      if (!request || request.encoding) return;
      request.encoding = true;
      try {
        encode(blob => blob?.size
          ? settle(request, 'Screenshot ready.', blob)
          : settle(request, 'The frame could not be captured. Try again.'));
      } catch { settle(request, 'The frame could not be captured. Try again.'); }
    },
    cancel() {
      if (pending) settle(pending, 'Capture interrupted. Try again when the scene is ready.');
    }
  };
}

export function setupScreenshot(canvas) {
  const button = document.getElementById('screenshot');
  const status = document.getElementById('captureStatus');
  const message = document.getElementById('captureMessage');
  const link = document.getElementById('captureFile');
  let currentURL, dismissTimer;
  function dismiss() {
    clearTimeout(dismissTimer);
    status.hidden = true;
    link.hidden = true;
    link.removeAttribute('href');
    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = undefined;
  }
  const capture = createScreenshotCapture({
    encode: callback => canvas.toBlob(callback, 'image/png'),
    download(blob) {
      currentURL = URL.createObjectURL(blob);
      link.href = currentURL;
      link.hidden = false;
      link.click();
    },
    report(text, active) {
      if (active) dismiss();
      message.textContent = text;
      button.disabled = active;
      button.setAttribute('aria-busy', String(active));
      status.hidden = false;
      if (!active) dismissTimer = setTimeout(dismiss, 90000);
    }
  });
  document.getElementById('dismissCapture').addEventListener('click', () => {capture.cancel(); dismiss();});
  document.addEventListener('visibilitychange', () => { if (document.hidden) capture.cancel(); });
  window.addEventListener('pagehide', () => {capture.cancel(); dismiss();});
  return capture;
}
