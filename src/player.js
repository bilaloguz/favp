const els = {
  fileInput: document.getElementById('fileInput'),
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  btnPlayPause: document.getElementById('btnPlayPause'),
  btnPrevFrame: document.getElementById('btnPrevFrame'),
  btnNextFrame: document.getElementById('btnNextFrame'),
  btnGoFrame: document.getElementById('btnGoFrame'),
  frameInput: document.getElementById('frameInput'),
  fpsInput: document.getElementById('fpsInput'),
  timeline: document.getElementById('timeline'),
  timelineProgress: document.getElementById('timelineProgress'),
  tc: document.getElementById('tc'),
  frame: document.getElementById('frame'),
  fps: document.getElementById('fps'),
  mode: document.getElementById('mode'),
  metaName: document.getElementById('metaName'),
  metaRes: document.getElementById('metaRes'),
  metaDur: document.getElementById('metaDur'),
};

/**
 * Player state
 */
const state = {
  fps: undefined, // number | undefined (auto-estimated)
  duration: 0,
  width: 0,
  height: 0,
  frameIndex: 0,
  RAFHandle: null,
  usingExactMode: false,
  lastFrameMediaTime: null,
  lastFrameWallTime: null,
  // rVFC handle
  rVFCHandle: null,
  // for debounce when seeking
  pendingSeekTarget: null,
  fileName: undefined,
  totalFrames: undefined,
};

function formatTimecode(timeSeconds, fps) {
  const totalFrames = Math.max(0, Math.round(timeSeconds * (fps || 30)));
  const frames = totalFrames % (fps || 30);
  const totalSeconds = Math.floor(totalFrames / (fps || 30));
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const padF = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${padF(frames)}`;
}

function updateHUD() {
  const v = els.video;
  const fpsValue = state.fps ? Number(state.fps).toFixed(3) : 'auto';
  if (els.fps) els.fps.textContent = fpsValue;
  
  // Calculate timecode based on frame index in exact mode, or video currentTime otherwise
  let timecodeSeconds = 0;
  if (state.usingExactMode && state.fps && state.frameIndex !== undefined) {
    // Frame-based timecode: frameIndex / fps
    timecodeSeconds = state.frameIndex / state.fps;
  } else {
    timecodeSeconds = v.currentTime || 0;
  }
  
  if (els.tc) els.tc.textContent = formatTimecode(timecodeSeconds, state.fps || 30);
  if (els.frame) els.frame.textContent = state.frameIndex.toString();
  if (els.mode) els.mode.textContent = state.usingExactMode ? 'Exact (Server)' : 'Video Element';
  if (els.metaName) {
    els.metaName.textContent = state.fileName || '-';
    els.metaRes.textContent = state.width && state.height ? `${state.width}×${state.height}` : '-';
    els.metaDur.textContent = state.duration ? formatTimecode(state.duration, state.fps || 30) : '-';
  }
  if (els.timelineProgress && state.totalFrames && state.totalFrames > 1) {
    const pct = (state.frameIndex / (state.totalFrames - 1)) * 100;
    els.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

function setControlsEnabled(enabled) {
  els.btnPlayPause.disabled = !enabled;
  els.btnPrevFrame.disabled = !enabled;
  els.btnNextFrame.disabled = !enabled;
  els.btnGoFrame.disabled = !enabled;
}

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const v = els.video;
  v.src = url;
  v.preload = 'auto';
  v.load();
}

// rVFC-based FPS estimation removed; we rely on MediaInfo or decoded frames

function getFrameDuration() {
  const fps = Number(els.fpsInput.value) || state.fps || 30;
  return 1 / fps;
}

async function exactModeLazyLoad() {
  if (state.usingExactMode) return;
  const module = await import('./ffmpeg-mode.js');
  await module.enableExactMode(els, state, updateHUD);
}

async function goToFrame(targetFrame) {
  // In server mode, jump by stepping delta frames
  const module = await import('./server-mode.js');
  const delta = Math.floor(targetFrame) - state.frameIndex;
  if (delta !== 0) {
    await module.stepExact(delta);
    updateHUD();
  }
}

// Removed rVFC-based wait helper

async function stepFrames(delta) {
  if (state.usingExactMode) {
    // server mode module overrides stepping internally (renders to canvas)
    const module = await import('./server-mode.js');
    await module.stepExact(delta);
    updateHUD();
    return;
  }

  const target = Math.max(0, state.frameIndex + delta);
  await goToFrame(target);
}

function onPlayPause() {
  // Drive server mode playback instead of <video>
  (async () => {
    try {
      const module = await import('./server-mode.js');
      // Toggle state by checking button label
      const shouldPlay = els.btnPlayPause.textContent === 'Play';
      if (shouldPlay) {
        module.playExact(state);
        els.btnPlayPause.textContent = 'Pause';
      } else {
        module.pauseExact();
        els.btnPlayPause.textContent = 'Play';
      }
    } catch (_) {}
  })();
}

function attachVideoCallbacks() {
  const v = els.video;

  v.addEventListener('loadedmetadata', async () => {
    state.duration = v.duration || 0;
    state.width = v.videoWidth;
    state.height = v.videoHeight;

    setControlsEnabled(true);
    els.btnPlayPause.textContent = v.paused ? 'Play' : 'Pause';
    updateHUD();
  });

  v.addEventListener('error', () => {
    // If the media fails to load, keep controls enabled so user can pick another file
    setControlsEnabled(true);
    updateHUD();
  });

  // Remove timeupdate/rVFC hooks; exact mode owns rendering
}

function wireUI() {
  els.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // Enable controls immediately; metadata will refine state
    setControlsEnabled(true);
    state.fileName = file.name;

    // Start loading the video immediately so metadata fires ASAP
    loadFile(file);

    // In parallel, try to get FPS via MediaInfo (do not block UI)
    (async () => {
      try {
        const mi = await import('./mediainfo.js');
        const fps = await mi.getFPSFromFile(file);
        if (fps && Number.isFinite(fps)) {
          state.fps = fps;
          updateHUD();
        }
      } catch (_) {
        // noop; will fall back to rVFC after metadata
      }
    })();

    // Always enable server-side decoding automatically
    try {
      const module = await import('./server-mode.js');
      await module.enableServerMode(els, state, updateHUD);
      if (!state.totalFrames) {
        if (typeof module.getExactTotalFrames === 'function') {
          state.totalFrames = module.getExactTotalFrames();
          updateHUD();
        }
      }
    } catch (e) {
      console.error('[FAVP] Server mode failed:', e);
      // If server mode fails, keep UI usable
    }
  });

  els.btnPlayPause.addEventListener('click', onPlayPause);
  els.btnPrevFrame.addEventListener('click', () => stepFrames(-1));
  els.btnNextFrame.addEventListener('click', () => stepFrames(1));

  els.fpsInput.addEventListener('change', () => {
    // manual override
    if (Number(els.fpsInput.value)) {
      state.fps = Number(els.fpsInput.value);
    } else {
      // revert to auto
      // will re-estimate next time metadata loads, keep current
    }
    updateHUD();
  });

  els.btnGoFrame.addEventListener('click', async () => {
    const n = Number(els.frameInput.value);
    if (!Number.isFinite(n) || n < 0) return;
    await goToFrame(Math.floor(n));
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', async (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (ev.key) {
      case ' ': // Space
      case 'k':
      case 'K':
        ev.preventDefault();
        onPlayPause();
        break;
      case 'j':
      case 'J':
      case 'ArrowLeft':
        ev.preventDefault();
        await stepFrames(-1);
        break;
      case 'l':
      case 'L':
      case 'ArrowRight':
        ev.preventDefault();
        await stepFrames(1);
        break;
      default:
        break;
    }
  });

  // exact mode button removed; enabled automatically on file select
}

function init() {
  setControlsEnabled(false);
  wireUI();
  attachVideoCallbacks();
  // timeline click seeking
  if (els.timeline) {
    els.timeline.addEventListener('click', async (ev) => {
      if (!state.totalFrames || state.totalFrames <= 1) return;
      const rect = els.timeline.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      try {
        const module = await import('./server-mode.js');
        if (typeof module.seekExactToFraction === 'function') {
          module.seekExactToFraction(ratio);
        }
        updateHUD();
      } catch (_) {}
    });
  }
  // UI sync loop to ensure timeline reflects current frame
  const sync = () => {
    // If decoding finished but totalFrames not set, try to fetch it
    (async () => {
      if (!state.totalFrames) {
        try {
          const module = await import('./server-mode.js');
          if (typeof module.getExactTotalFrames === 'function') {
            const tf = module.getExactTotalFrames();
            if (tf && tf > 0) state.totalFrames = tf;
          }
        } catch (_) {}
      }
    })();
    updateHUD();
    requestAnimationFrame(sync);
  };
  requestAnimationFrame(sync);
}

init();


