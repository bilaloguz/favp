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
  btnMarkIn: document.getElementById('btnMarkIn'),
  btnMarkOut: document.getElementById('btnMarkOut'),
  btnSubclip: document.getElementById('btnSubclip'),
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
  // Ensure timeSeconds is a valid number and round to prevent floating point errors
  const roundedTime = Number(timeSeconds) || 0;
  const fpsValue = Number(fps) || 30;
  
  // Calculate total frames (round to integer) - this is the absolute frame number
  const totalFrames = Math.max(0, Math.round(roundedTime * fpsValue));
  
  // Calculate total seconds (integer)
  const totalSeconds = Math.floor(totalFrames / fpsValue);
  
  // Extract frame number within current second
  // Calculate frames as: totalFrames - (seconds * fps)
  // IMPORTANT: Use integer arithmetic to avoid floating point precision issues
  const fpsInt = Math.floor(fpsValue);
  const frameInSecond = totalFrames - (totalSeconds * fpsInt);
  
  // Calculate frame number - must be integer
  let frames = Math.round(frameInSecond);
  
  // Clamp to valid range (0 to fps-1)
  if (frames < 0) {
    frames = 0;
  } else if (frames >= fpsInt) {
    frames = frames % fpsInt;
  }
  
  // Convert to integer using multiple methods to ensure no decimals
  frames = Math.floor(Math.abs(frames));
  // Force integer by converting to string and parsing integer part
  const framesInt = parseInt(String(frames).split('.')[0], 10);
  const finalFrames = isNaN(framesInt) ? 0 : Math.floor(framesInt);
  
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  
  const pad = (n) => {
    const num = Math.floor(Math.abs(Number(n)));
    const str = String(num);
    return str.split('.')[0].padStart(2, '0');
  };
  
  // Format frame number - ensure it's absolutely an integer string with no decimals
  const framesFormatted = (() => {
    // Convert finalFrames to integer multiple ways
    const intVal = Math.floor(Math.abs(finalFrames));
    const intStr = String(intVal).split('.')[0];
    const intNum = parseInt(intStr, 10);
    const finalInt = isNaN(intNum) ? 0 : Math.floor(intNum);
    // Return as zero-padded string with exactly 2 digits
    return String(finalInt).padStart(2, '0');
  })();
  
  // Build timecode string explicitly - no template interpolation for frame part
  const hStr = pad(h);
  const mStr = pad(m);
  const sStr = pad(s);
  
  return hStr + ':' + mStr + ':' + sStr + ':' + framesFormatted;
}

function updateHUD() {
  const v = els.video;
  const fpsValue = state.fps ? Number(state.fps).toFixed(3) : 'auto';
  if (els.fps) els.fps.textContent = fpsValue;
  
  // Calculate timecode based on frame index if available (WebSocket mode or exact mode), or video currentTime otherwise
  let timecodeSeconds = 0;
  let frameIndex = 0;
  
  if ((state.usingExactMode || state.wsModule) && state.fps && state.frameIndex !== undefined) {
    // Frame-based timecode: frameIndex / fps (round frame index to integer)
    frameIndex = Math.max(0, Math.round(state.frameIndex));
    timecodeSeconds = frameIndex / state.fps;
  } else if (v && v.currentTime !== undefined) {
    timecodeSeconds = Number(v.currentTime) || 0;
    // Calculate frame from video time (round to nearest frame)
    if (state.fps) {
      frameIndex = Math.max(0, Math.round(timecodeSeconds * state.fps));
      // Recalculate timecode from rounded frame to ensure consistency
      timecodeSeconds = frameIndex / state.fps;
    }
  } else if (state.fps && state.frameIndex !== undefined) {
    // Fallback: use frame index if available
    frameIndex = Math.max(0, Math.round(state.frameIndex));
    timecodeSeconds = frameIndex / state.fps;
  }
  
  // Ensure frameIndex is always an integer for display
  const displayFrame = Math.max(0, Math.round(frameIndex));
  
  if (els.tc) els.tc.textContent = formatTimecode(timecodeSeconds, state.fps || 30);
  if (els.frame) els.frame.textContent = displayFrame.toString();
  if (els.mode) els.mode.textContent = state.usingExactMode ? 'Exact (Server)' : (state.wsModule ? 'WebSocket' : 'Video Element');
  if (els.metaName) {
    els.metaName.textContent = state.fileName || '-';
    els.metaRes.textContent = state.width && state.height ? `${state.width}×${state.height}` : '-';
    els.metaDur.textContent = state.duration ? formatTimecode(state.duration, state.fps || 30) : '-';
  }
  if (els.timelineProgress && state.totalFrames && state.totalFrames > 1) {
    const frameIndex = state.frameIndex !== undefined ? state.frameIndex : 0;
    const pct = (frameIndex / (state.totalFrames - 1)) * 100;
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
  const fps = state.fps || 30;
  return 1 / fps;
}

async function exactModeLazyLoad() {
  if (state.usingExactMode) return;
  const module = await import('./ffmpeg-mode.js');
  await module.enableExactMode(els, state, updateHUD);
}

async function stepFrames(delta) {
  if (state.wsModule) {
    state.wsModule.step(delta);
  } else {
    const target = Math.max(0, state.frameIndex + delta);
    await goToFrame(target);
  }
}

async function goToFrame(target) {
  if (state.wsModule) {
    state.wsModule.setFrame(target);
  }
}

function onPlayPause() {
  // Drive WebSocket mode playback instead of <video>
  if (state.wsModule) {
    const shouldPlay = els.btnPlayPause.textContent === 'Play';
    if (shouldPlay) {
      state.wsModule.play();
      els.btnPlayPause.textContent = 'Pause';
    } else {
      state.wsModule.pause();
      els.btnPlayPause.textContent = 'Play';
    }
  } else {
    // Fallback - should not happen if init worked
    console.warn('[FAVP] WebSocket module not initialized');
  }
}

function attachVideoCallbacks() {
  const v = els.video;

  v.addEventListener('loadedmetadata', async () => {
    state.duration = v.duration || 0;
    state.width = v.videoWidth;
    state.height = v.videoHeight;

    setControlsEnabled(true);
    // Ensure subclip controls are enabled once media is ready
    if (els.btnMarkIn) els.btnMarkIn.disabled = false;
    if (els.btnMarkOut) els.btnMarkOut.disabled = false;
    if (els.btnSubclip) els.btnSubclip.disabled = false;
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

    // Optimistically enable subclip controls immediately on file select
    if (els.btnMarkIn) els.btnMarkIn.disabled = false;
    if (els.btnMarkOut) els.btnMarkOut.disabled = false;
    if (els.btnSubclip) els.btnSubclip.disabled = false;

    // Always enable WebSocket mode automatically
    try {
      const module = await import('./ws-mode.js');
      const wsModule = await module.enableWebSocketMode(els, state, updateHUD);
      
      // Upload file to server
      const formData = new FormData();
      formData.append('file', file, file.name);
      
      const uploadResp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      
      if (!uploadResp.ok) {
        throw new Error(`Upload failed: ${uploadResp.status}`);
      }
      
      const uploadResult = await uploadResp.json();
      console.log('[FAVP] Upload result:', uploadResult);
      
      // Update state from upload result
      state.totalFrames = uploadResult.total_frames || 0;
      state.fps = uploadResult.fps;
      state.duration = uploadResult.duration || 0;
      if (uploadResult.width) state.width = uploadResult.width;
      if (uploadResult.height) state.height = uploadResult.height;
      
      // Initialize WebSocket connection
      await wsModule.init(uploadResult.session_id);
      // Enable new subclip controls once session is initialized
      if (els.btnMarkIn) els.btnMarkIn.disabled = false;
      if (els.btnMarkOut) els.btnMarkOut.disabled = false;
      if (els.btnSubclip) els.btnSubclip.disabled = false;
      
      // Store module reference for controls
      state.wsModule = wsModule;
      
      updateHUD();
    } catch (e) {
      console.error('[FAVP] WebSocket mode failed:', e);
      // If WebSocket mode fails, keep UI usable
    }
  });

  els.btnPlayPause.addEventListener('click', onPlayPause);
  els.btnPrevFrame.addEventListener('click', () => stepFrames(-1));
  els.btnNextFrame.addEventListener('click', () => stepFrames(1));
  // In/Out/Subclip buttons
  if (els.btnMarkIn) els.btnMarkIn.addEventListener('click', () => {
    if (state.wsModule && state.wsModule.markIn) state.wsModule.markIn();
  });
  if (els.btnMarkOut) els.btnMarkOut.addEventListener('click', () => {
    if (state.wsModule && state.wsModule.markOut) state.wsModule.markOut();
  });
  if (els.btnSubclip) els.btnSubclip.addEventListener('click', async () => {
    if (!state.wsModule) return;
    if (state.wsModule.createSubclip) {
      await state.wsModule.createSubclip();
    }
  });

  // FPS input removed from UI, but keep code in case we add it back
  if (els.fpsInput) {
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
  }

  els.btnGoFrame.addEventListener('click', async () => {
    const n = Number(els.frameInput.value);
    if (!Number.isFinite(n) || n < 0) {
      console.warn('[FAVP] Invalid frame number:', els.frameInput.value);
      return;
    }
    const targetFrame = Math.floor(n);
    console.log('[FAVP] Going to frame:', targetFrame);
    await goToFrame(targetFrame);
  });
  
  // Also support Enter key in frame input
  els.frameInput.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const n = Number(els.frameInput.value);
      if (Number.isFinite(n) && n >= 0) {
        const targetFrame = Math.floor(n);
        console.log('[FAVP] Going to frame (Enter):', targetFrame);
        await goToFrame(targetFrame);
      }
    }
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
      case 'i':
      case 'I':
        ev.preventDefault();
        if (state.wsModule && state.wsModule.markIn) state.wsModule.markIn();
        break;
      case 'o':
      case 'O':
        ev.preventDefault();
        if (state.wsModule && state.wsModule.markOut) state.wsModule.markOut();
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
      
      // Calculate target frame based on click position
      const targetFrame = Math.floor(ratio * (state.totalFrames - 1));
      
      // Use WebSocket mode if available
      if (state.wsModule) {
        state.wsModule.setFrame(targetFrame);
        updateHUD();
      } else {
        // Fallback to server-mode if ws-mode not available
        try {
          const module = await import('./server-mode.js');
          if (typeof module.seekExactToFraction === 'function') {
            module.seekExactToFraction(ratio);
          }
          updateHUD();
        } catch (_) {}
      }
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


