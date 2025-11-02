// Lightweight wrapper around MediaInfo.js (WASM) to extract FPS from a File
// Use the official ESM factory from the package.
// ESM paths (served via FastAPI):
//   JS:   /vendor/mediainfo/esm/mediaInfoFactory.js
//   WASM: /vendor/mediainfo/MediaInfoModule.wasm

let mediaInfoInstance = null;

function injectUMDScript(src) {
  return new Promise((resolve, reject) => {
    if (window.MediaInfo) { resolve(); return; }
    const existing = document.querySelector('script[data-mediainfo]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject());
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.setAttribute('data-mediainfo', '');
    s.onload = () => resolve();
    s.onerror = () => reject();
    document.head.appendChild(s);
  });
}

async function loadMediaInfo() {
  if (mediaInfoInstance) return mediaInfoInstance;
  // Load ESM factory
  try {
    const mod = await import('/vendor/mediainfo/esm/mediaInfoFactory.js');
    const factory = mod?.default || mod;
    if (typeof factory === 'function') {
      mediaInfoInstance = await factory({
        format: 'object',
        locateFile: () => '/vendor/mediainfo/MediaInfoModule.wasm',
      });
      return mediaInfoInstance;
    }
  } catch (_) {}
  return null;
}

function toFixedNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseFPSFromTrack(track) {
  // Try rational first
  const num = toFixedNumber(track.FrameRate_Num);
  const den = toFixedNumber(track.FrameRate_Den);
  if (num && den && den !== 0) return num / den;
  // Then try float string
  const fr = toFixedNumber(track.FrameRate);
  if (fr) return fr;
  // Some files report "23.976 (24000/1001)" in FrameRate/String
  const str = track["FrameRate/String"] || track.FrameRate_String;
  if (typeof str === 'string') {
    const m = str.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const n = Number(m[1]);
      const d = Number(m[2]);
      if (n && d) return n / d;
    }
    const f = Number(str);
    if (Number.isFinite(f)) return f;
  }
  return undefined;
}

export async function getFPSFromFile(file) {
  try {
    const mi = await loadMediaInfo();
    if (!mi) return undefined;
    const result = await mi.analyzeData(() => file.size, (chunkSize, offset) => file.slice(offset, offset + chunkSize).arrayBuffer());
    const videoTrack = (result?.media?.track || []).find(t => t['@type'] === 'Video');
    if (!videoTrack) return undefined;
    const fps = parseFPSFromTrack(videoTrack);
    return fps;
  } catch (_) {
    return undefined;
  }
}


