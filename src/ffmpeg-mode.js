// Lazy-loaded exact mode (stub): decode frames with ffmpeg.wasm and render to canvas.
// This file wires the mode switch and provides stepExact implementation.

let ffmpeg; // loaded on demand
let elements;
let sharedState;
let updateHUD;

let decodedFrames = []; // Array of ImageBitmap or ImageData
let currentIndex = 0;
let decoding = false;
let isPlaying = false;
let rafId = null;
let lastTs = 0;
let accMs = 0;

async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;
  // Lightweight loader via ESM CDN. Heavy files are fetched on demand by the lib.
  const { createFFmpeg, fetchFile } = await import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10');
  ffmpeg = createFFmpeg({ log: false });
  return ffmpeg;
}

async function decodeAllFrames(file) {
  if (decoding) return;
  decoding = true;
  const { fetchFile } = await import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10');
  if (!ffmpeg.isLoaded()) {
    console.log('[FAVP] Loading ffmpeg.wasm...');
    await ffmpeg.load();
  }

  await ffmpeg.FS('writeFile', 'input', await fetchFile(file));
  // Extract frames as PNG sequence for simplicity. This is slow for long videos.
  // For proofs-of-concept or short clips.
  console.log('[FAVP] Decoding frames...');
  await ffmpeg.run('-i', 'input', '-vsync', '0', 'frame_%08d.png');

  // Read back frames
  decodedFrames = [];
  const ctx = elements.canvas.getContext('2d');
  let stageW = elements.video.videoWidth || 0;
  let stageH = elements.video.videoHeight || 0;

  // Enumerate files - naive: try up to 20000 frames until fail
  for (let i = 1; i <= 20000; i++) {
    const name = `frame_${String(i).padStart(8, '0')}.png`;
    try {
      const data = ffmpeg.FS('readFile', name);
      const blob = new Blob([data.buffer], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      if (!stageW || !stageH) {
        stageW = bmp.width;
        stageH = bmp.height;
        elements.canvas.width = stageW;
        elements.canvas.height = stageH;
        sharedState.width = stageW;
        sharedState.height = stageH;
      }
      decodedFrames.push(bmp);
    } catch {
      break;
    }
  }

  decoding = false;
  console.log('[FAVP] Decoded frames:', decodedFrames.length);
}

function renderFrame(index) {
  const bmp = decodedFrames[index];
  if (!bmp) return;
  const ctx = elements.canvas.getContext('2d');
  ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  ctx.drawImage(bmp, 0, 0);
  sharedState.frameIndex = index;
  updateHUD();
  // Directly update timeline progress for robustness
  if (elements.timelineProgress && decodedFrames.length > 1) {
    const pct = (index / (decodedFrames.length - 1)) * 100;
    elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

export async function enableExactMode(els, st, onHUDUpdate) {
  console.log('[FAVP] enableExactMode called');
  elements = els;
  sharedState = st;
  updateHUD = onHUDUpdate;
  // Refresh timeline refs in case not present on initial els creation
  elements.timeline = document.getElementById('timeline');
  elements.timelineProgress = document.getElementById('timelineProgress');

  try {
    await loadFFmpeg();
    console.log('[FAVP] ffmpeg loaded');
  } catch (e) {
    console.error('[FAVP] Failed to load ffmpeg:', e);
    return;
  }

  // Switch to canvas rendering mode
  elements.video.pause();
  elements.video.classList.add('hidden');
  elements.canvas.classList.remove('hidden');
  sharedState.usingExactMode = true;

  // Indicate decoding in UI
  const btn = elements.btnPlayPause;
  const prevLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Decoding...'; btn.disabled = true; }

  // Decode frames from current file if provided via input element
  const file = elements.fileInput.files && elements.fileInput.files[0];
  if (!file) {
    console.error('[FAVP] No file selected');
    alert('Open a local file first to enable exact mode.');
    return;
  }
  try {
    await decodeAllFrames(file);
  } catch (e) {
    console.error('[FAVP] Decoding error:', e);
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }
    alert('Decoding failed: ' + e.message);
    return;
  }

  // Estimate FPS from count and duration if available
  if (!sharedState.fps && elements.video.duration && decodedFrames.length > 0) {
    sharedState.fps = decodedFrames.length / elements.video.duration;
  }

  sharedState.totalFrames = decodedFrames.length;
  renderFrame(0);
  updateHUD();

  // Restore play button
  if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }

  if (!decodedFrames.length) {
    alert('Decoding failed or produced zero frames. Try a different short clip.');
  }
}

export async function stepExact(delta) {
  if (!decodedFrames.length) return;
  currentIndex = Math.min(Math.max(0, currentIndex + delta), decodedFrames.length - 1);
  renderFrame(currentIndex);
}

export function getExactTotalFrames() {
  return decodedFrames.length;
}

export async function setExactFrame(index) {
  if (!decodedFrames.length) return;
  currentIndex = Math.min(Math.max(0, index), decodedFrames.length - 1);
  renderFrame(currentIndex);
}

export function playExact(shared) {
  if (!decodedFrames.length) return;
  if (isPlaying) return;
  isPlaying = true;
  lastTs = 0;
  accMs = 0;
  const fps = Number(shared.fps) || 30;
  const frameMs = 1000 / fps;
  const tick = (ts) => {
    if (!isPlaying) return;
    if (!lastTs) lastTs = ts;
    const delta = ts - lastTs;
    lastTs = ts;
    accMs += delta;
    while (accMs >= frameMs) {
      accMs -= frameMs;
      if (currentIndex >= decodedFrames.length - 1) {
        pauseExact();
        return;
      }
      currentIndex += 1;
      renderFrame(currentIndex);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function pauseExact() {
  isPlaying = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

export function seekExactToFraction(ratio) {
  if (!decodedFrames.length) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  const idx = Math.round(clamped * (decodedFrames.length - 1));
  currentIndex = idx;
  renderFrame(currentIndex);
}


