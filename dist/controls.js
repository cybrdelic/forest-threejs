import {daylight} from './daylight.js';
const formatCount = value => Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';

export function updateStats(stats = {}) {
  const values = {
    fps: Number.isFinite(stats.fps) ? Math.round(stats.fps) : '—',
    treeCount: formatCount(stats.trees),
    nearCount: formatCount(stats.near),
    midCount: formatCount(stats.mid),
    farCount: formatCount(stats.far),
    totalCount: formatCount(stats.total),
    triangleCount: formatCount(stats.triangles)
  };
  for (const [id, value] of Object.entries(values)) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }
}

let loadingTimeout;
export function setLoading(text, progress = 0) {
  const screen = document.getElementById('loading');
  const label = document.getElementById('loadingText');
  if (label && text) label.textContent = text;
  document.getElementById('loadingProgress').style.width = `${Math.min(1, Math.max(0, progress)) * 100}%`;
  clearTimeout(loadingTimeout);
  if (progress >= 1) {
    screen.classList.add('finished');
    loadingTimeout = setTimeout(() => { screen.hidden = true; }, 700);
  } else {
    screen.hidden = false;
    screen.classList.remove('finished');
  }
}

export function setError(error) {
  const screen = document.getElementById('loading');
  if (screen) screen.hidden = true;
  const message = error instanceof Error ? error.message : String(error);
  document.getElementById('errorText').textContent = message;
  document.getElementById('errorPanel').hidden = false;
}

export function setupControls(canvas, callbacks = {}) {
  const keys = new Set();
  const interfaceElement = document.getElementById('interface');
  const settings = document.getElementById('settings');
  const toggle = document.getElementById('settingsToggle');
  const tourButton = document.getElementById('tour');
  const hint = document.getElementById('movementHint');
  let lookX = 0;
  let lookY = 0;
  let dragPointer = null;
  let previousX = 0;
  let previousY = 0;
  let movingPointer = null;
  let joystickX = 0;
  let joystickY = 0;
  let tourActive = false;
  const velocity = [0, 0, 0];
  let flyMode = false;

  function resetMotion() {
    lookX = 0;
    lookY = 0;
    velocity.fill(0);
  }

  function setTour(active, notify = true) {
    resetMotion();
    flyMode = false;
    tourActive = active;
    tourButton.setAttribute('aria-pressed', String(active));
    tourButton.setAttribute('aria-label', active ? 'Stop camera tour' : 'Start camera tour');
    tourButton.innerHTML = active
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4h3v12H6Zm5 0h3v12h-3Z"/></svg><span>Tour</span>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z"/></svg><span>Tour</span>';
    if (notify) callbacks.onTour?.(active);
  }

  function cancelTour() {
    if (tourActive) setTour(false);
  }

  function openSettings(open) {
    settings.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close renderer settings' : 'Open renderer settings');
  }

  toggle.addEventListener('click', () => openSettings(settings.hidden));
  document.getElementById('closeSettings').addEventListener('click', () => openSettings(false));

  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => {
      cancelTour();
      resetMotion();
      document.querySelectorAll('[data-view]').forEach(item => {
        const active = button === item;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      flyMode = false;
      callbacks.onView?.(button.dataset.view);
    });
  });

  const preset = document.getElementById('daylight');
  const elevation = document.getElementById('sunElevation');
  const azimuth = document.getElementById('sunAzimuth');
  preset.addEventListener('change', () => {
    const pair = daylight[preset.value];
    if (!pair) return;
    for (const [key,value] of Object.entries(pair)) {
      document.getElementById(key).value = value;
      document.getElementById(key+'Value').textContent = value+'°';
      callbacks.onSetting?.(key, value);
    }
  });
  for (const id of ['sunElevation', 'sunAzimuth', 'wind']) {
    document.getElementById(id).addEventListener('input', event => {
      const value = Number(event.target.value);
      document.getElementById(`${id}Value`).textContent = id === 'wind' ? value.toFixed(1) : `${value}°`;
      if (id !== 'wind') {
        const match = Object.keys(daylight).find(key => daylight[key].sunElevation===Number(elevation.value) && daylight[key].sunAzimuth===Number(azimuth.value));
        preset.value = match || 'custom';
      }
      callbacks.onSetting?.(id, value);
    });
  }
  for (const id of ['density', 'quality', 'debug', 'sky']) {
    document.getElementById(id).addEventListener('change', event => {
      callbacks.onSetting?.(id, id === 'density' ? Number(event.target.value) : event.target.value);
    });
  }

  tourButton.addEventListener('click', () => setTour(!tourActive));
  document.getElementById('screenshot').addEventListener('click', () => callbacks.onScreenshot?.());
  document.getElementById('fullscreen').addEventListener('click', async () => {
    if (callbacks.onFullscreen) {
      callbacks.onFullscreen();
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* Fullscreen availability depends on the embedding browser. */ }
  });
  document.getElementById('retry').addEventListener('click', () => location.reload());

  const isFormElement = target => target instanceof Element && Boolean(target.closest('input, select, textarea, button'));
  window.addEventListener('keydown', event => {
    if (isFormElement(event.target)) return;
    if (event.code === 'KeyH' && !event.repeat) interfaceElement.classList.toggle('hidden');
    if (event.code === 'Escape') openSettings(false);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault();
      keys.add(event.code);
      cancelTour();
    }
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => {
    keys.clear();
    resetMotion();
    joystickX = 0;
    joystickY = 0;
    movingPointer = null;
    dragPointer = null;
    knob.style.transform = '';
  });

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    cancelTour();
    dragPointer = event.pointerId;
    previousX = event.clientX;
    previousY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    if (event.pointerType !== 'touch' && !document.pointerLockElement && canvas.requestPointerLock) {
      try {
        const request = canvas.requestPointerLock();
        if (request?.catch) request.catch(() => {});
      } catch { /* Pointer dragging remains available when pointer lock is blocked. */ }
    }
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    resetMotion();
    if (hint) hint.innerHTML = locked ? 'WASD to move <span>·</span> Esc to release' : 'Click to explore <span>·</span> WASD to move';
  });

  canvas.addEventListener('pointermove', event => {
    if (document.pointerLockElement === canvas) {
      lookX += event.movementX;
      lookY += event.movementY;
      return;
    }
    if (dragPointer !== event.pointerId) return;
    lookX += event.clientX - previousX;
    lookY += event.clientY - previousY;
    previousX = event.clientX;
    previousY = event.clientY;
  });
  const stopLook = event => {
    if (dragPointer === event.pointerId) dragPointer = null;
  };
  canvas.addEventListener('pointerup', stopLook);
  canvas.addEventListener('pointercancel', stopLook);

  const joystick = document.getElementById('joystick');
  const knob = document.getElementById('joystickKnob');
  function moveJoystick(event) {
    const bounds = joystick.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.max(32, Math.hypot(x, y));
    joystickX = x / distance;
    joystickY = y / distance;
    knob.style.transform = `translate(${joystickX * 29}px, ${joystickY * 29}px)`;
  }
  joystick.addEventListener('pointerdown', event => {
    event.preventDefault();
    cancelTour();
    movingPointer = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    moveJoystick(event);
  });
  joystick.addEventListener('pointermove', event => {
    if (movingPointer === event.pointerId) moveJoystick(event);
  });
  function stopJoystick(event) {
    if (event.pointerId !== movingPointer) return;
    movingPointer = null;
    joystickX = 0;
    joystickY = 0;
    knob.style.transform = '';
  }
  joystick.addEventListener('pointerup', stopJoystick);
  joystick.addEventListener('pointercancel', stopJoystick);

  return {
    // Yaw zero looks along -Z. Positive pitch looks upward.
    update(dt, position, yaw, pitch, sampleGround) {
      const elapsed = Math.min(Math.max(dt, 0), 0.15);
      const nextPosition = [...position];
      // Consume a consistent fraction of pending pointer movement at any refresh rate.
      const lookResponse = 1 - Math.exp(-elapsed / 0.018);
      const horizontalLook = lookX * lookResponse;
      const verticalLook = lookY * lookResponse;
      lookX -= horizontalLook;
      lookY -= verticalLook;
      yaw += horizontalLook * 0.0022;
      pitch = Math.min(1.48, Math.max(-1.48, pitch - verticalLook * 0.0022));
      const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - joystickY;
      const sideways = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + joystickX;
      const vertical = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
      const normalization = Math.max(1, Math.hypot(forward, sideways, vertical));
      const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 65 : 12) / normalization;
      const targetVelocity = [
        (Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * speed,
        vertical * speed,
        (-Math.cos(yaw) * forward + Math.sin(yaw) * sideways) * speed
      ];
      const responseTime = forward || sideways || vertical ? 0.075 : 0.045;
      const decay = Math.exp(-elapsed / responseTime);
      for (let axis = 0; axis < 3; axis++) {
        // Integrate exponential velocity exactly, keeping travel independent of FPS.
        nextPosition[axis] += targetVelocity[axis] * elapsed
          + (velocity[axis] - targetVelocity[axis]) * responseTime * (1 - decay);
        velocity[axis] = targetVelocity[axis] + (velocity[axis] - targetVelocity[axis]) * decay;
      }
      if (sampleGround) {
        const minimumEyeHeight = 1.7;
        const ground = sampleGround(nextPosition[0], nextPosition[2]);
        if (vertical) flyMode = true;
        if (nextPosition[1] <= ground + minimumEyeHeight) {
          nextPosition[1] = ground + minimumEyeHeight;
          velocity[1] = Math.max(0, velocity[1]);
          flyMode = false;
        } else if (!flyMode && (nextPosition[0] !== position[0] || nextPosition[2] !== position[2])) {
          const previousGround = sampleGround(position[0], position[2]);
          const eyeClearance = position[1] - previousGround;
          if (eyeClearance <= minimumEyeHeight + 0.35) {
            nextPosition[1] = ground + Math.max(minimumEyeHeight, eyeClearance);
          }
        }
      }
      return { position: nextPosition, yaw, pitch };
    },
    setTour,
    setView(name) {
      resetMotion();
      flyMode = false;
      document.querySelectorAll('[data-view]').forEach(button => {
        const active = button.dataset.view === name;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
  };
}
