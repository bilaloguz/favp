// Server-side HLS mode: uploads video, generates HLS segments, plays via hls.js

let currentSession = null;
let hlsPlayer = null;
let currentIndex = 0;
let isPlaying = false;
let hudUpdateRaf = null; // Track animation frame globally

let elements;
let sharedState;
let updateHUD;

async function uploadAndProbe(file) {
  console.log(`[FAVP] Starting upload for file: ${file.name}, size: ${file.size}`);
  
  if (!file || !(file instanceof File || file instanceof Blob)) {
    throw new Error('Invalid file object');
  }
  
  const formData = new FormData();
  formData.append('file', file, file.name);

  console.log('[FAVP] Sending POST to /api/upload...');
  try {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
      // Don't set Content-Type - browser will set it with boundary
    });

    console.log(`[FAVP] Upload response status: ${resp.status}`);
    
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        errMsg = err.detail || err.message || JSON.stringify(err);
      } catch (e) {
        try {
          const text = await resp.text();
          if (text) errMsg = text;
        } catch (e2) {
          // Ignore
        }
      }
      console.error('[FAVP] Upload failed:', errMsg);
      throw new Error(`Upload failed: ${errMsg}`);
    }

    console.log('[FAVP] Parsing response JSON...');
    const result = await resp.json();
    console.log('[FAVP] Upload response:', result);
    
    currentSession = result.session_id;
    sharedState.totalFrames = result.total_frames || 0;
    sharedState.fps = result.fps;
    if (result.width) sharedState.width = result.width;
    if (result.height) sharedState.height = result.height;
    
    console.log(`[FAVP] Session: ${currentSession}, Frames: ${sharedState.totalFrames}, FPS: ${sharedState.fps}`);
    
    return result;
  } catch (e) {
    console.error('[FAVP] Upload error:', e);
    throw e;
  }
}

async function generateHLS() {
  if (!currentSession) throw new Error('No session');
  
  console.log('[FAVP] Generating HLS segments...');
  try {
    const resp = await fetch(`/api/generate-hls/${currentSession}?segment_duration=1.0`, {
      method: 'POST',
    });
    
    console.log(`[FAVP] HLS generation response status: ${resp.status}`);
    
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        errMsg = err.detail || err.message || JSON.stringify(err);
      } catch (e) {
        // Response is not JSON, try to get text
        try {
          const text = await resp.text();
          if (text) errMsg = text;
          console.error('[FAVP] Non-JSON error response:', text);
        } catch (e2) {
          console.error('[FAVP] Failed to read error response:', e2);
        }
      }
      throw new Error(`HLS generation failed: ${errMsg}`);
    }
    
    // Read response as text first for better debugging
    const text = await resp.text();
    console.log('[FAVP] HLS generation response text:', text.substring(0, 200));
    
    if (!text) {
      throw new Error('Empty response from server');
    }
    
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error('[FAVP] Failed to parse JSON:', e);
      console.error('[FAVP] Response text:', text);
      throw new Error(`Failed to parse server response as JSON: ${e.message}`);
    }
    
    console.log(`[FAVP] Generated ${result.total_segments} HLS segments`);
    return result;
  } catch (e) {
    console.error('[FAVP] Error in generateHLS:', e);
    throw e;
  }
}

function frameToTime(frameIndex) {
  const fps = sharedState.fps || 30;
  return frameIndex / fps;
}

function timeToFrame(time) {
  const fps = sharedState.fps || 30;
  return Math.round(time * fps);
}

export async function enableServerMode(els, st, onHUDUpdate) {
  console.log('[FAVP] Server HLS mode enabled');
  elements = els;
  sharedState = st;
  updateHUD = onHUDUpdate;
  
  elements.timeline = document.getElementById('timeline');
  elements.timelineProgress = document.getElementById('timelineProgress');
  
  // Switch to video element (not canvas)
  elements.video.classList.remove('hidden');
  elements.canvas.classList.add('hidden');
  sharedState.usingExactMode = true;
  
  const file = elements.fileInput.files && elements.fileInput.files[0];
  if (!file) {
    console.error('[FAVP] No file selected');
    alert('Open a local file first.');
    return;
  }
  
  const btn = elements.btnPlayPause;
  const prevLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Processing...'; btn.disabled = true; }
  
  // Reset state
  currentIndex = 0;
  currentSession = null;
  
  // Cleanup old HLS player if exists
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  
  try {
    console.log('[FAVP] Uploading and probing video...');
    const result = await uploadAndProbe(file);
    console.log(`[FAVP] Probed: ${result.total_frames} frames, FPS: ${result.fps}, Size: ${result.width}x${result.height}`);
    
    // Set state values
    sharedState.fps = result.fps;
    sharedState.totalFrames = result.total_frames || 0;
    sharedState.duration = result.duration || 0;
    
    // Set video dimensions
    if (result.width && result.height) {
      sharedState.width = result.width;
      sharedState.height = result.height;
      console.log(`[FAVP] Video dimensions: ${result.width}x${result.height}`);
    }
    
    console.log(`[FAVP] State initialized - FPS: ${sharedState.fps}, TotalFrames: ${sharedState.totalFrames}, Duration: ${sharedState.duration}`);
    
    // Generate HLS segments
    console.log('[FAVP] Generating HLS segments...');
    const hlsResult = await generateHLS();
    
    // Setup HLS player
    const playlistUrl = `/api/hls/${currentSession}/playlist.m3u8`;
    console.log(`[FAVP] Loading HLS playlist: ${playlistUrl}`);
    
    if (typeof Hls === 'undefined') {
      throw new Error('HLS.js library not loaded');
    }
    
    if (Hls.isSupported()) {
      hlsPlayer = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 10, // Keep 10 seconds buffered
      });
      
      hlsPlayer.loadSource(playlistUrl);
      hlsPlayer.attachMedia(elements.video);
      
      // Set up HLS event handlers
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[FAVP] HLS manifest parsed, ready to play');
        if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }
        
        // Set video dimensions if not set
        elements.video.addEventListener('loadedmetadata', () => {
          if (!sharedState.width && elements.video.videoWidth) {
            sharedState.width = elements.video.videoWidth;
            sharedState.height = elements.video.videoHeight;
          }
          
          // Initialize frame index and timeline
          currentIndex = 0;
          sharedState.frameIndex = 0;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            elements.timelineProgress.style.width = '0%';
          }
          
          updateHUD();
        }, { once: true });
      });
      
      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('[FAVP] HLS network error, trying to recover...');
              hlsPlayer.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('[FAVP] HLS media error, trying to recover...');
              hlsPlayer.recoverMediaError();
              break;
            default:
              console.error('[FAVP] HLS fatal error:', data);
              hlsPlayer.destroy();
              throw new Error('HLS playback error');
          }
        }
      });
      
      // Update current frame index from video time using requestAnimationFrame for smooth updates
      // (timeupdate is throttled by browsers and not frequent enough for frame-accurate tracking)
      // Note: hudUpdateRaf is now global to work with playExact/pauseExact
      
      // Define update function that will be used by event listeners
      const updateFrameFromVideo = () => {
        if (!elements.video) {
          hudUpdateRaf = null;
          return;
        }
        
        if (elements.video.ended) {
          // Video ended, stop loop
          hudUpdateRaf = null;
          const fps = sharedState.fps || 30;
          const videoTime = elements.video.currentTime || 0;
          currentIndex = Math.round(videoTime * fps);
          sharedState.frameIndex = currentIndex;
          updateHUD();
          return;
        }
        
        if (elements.video.paused) {
          // Video paused, stop loop but update once
          hudUpdateRaf = null;
          const fps = sharedState.fps || 30;
          const videoTime = elements.video.currentTime || 0;
          currentIndex = Math.round(videoTime * fps);
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
          return;
        }
        
        // Video is playing, update frame
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        const newIndex = Math.round(videoTime * fps);
        
        if (newIndex !== currentIndex || videoTime > 0) {
          currentIndex = newIndex;
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
        
        // Continue loop
        hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
      };
      
      // Start the update loop when video starts playing
      elements.video.addEventListener('play', () => {
        console.log('[FAVP] Video play event, starting update loop');
        if (!hudUpdateRaf) {
          hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
        }
      });
      
      elements.video.addEventListener('pause', () => {
        console.log('[FAVP] Video pause event');
        if (hudUpdateRaf) {
          cancelAnimationFrame(hudUpdateRaf);
          hudUpdateRaf = null;
        }
        // Still update once on pause
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        currentIndex = Math.round(videoTime * fps);
        sharedState.frameIndex = currentIndex;
        
        // Update timeline
        if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
          const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
          elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
        
        updateHUD();
      });
      
      // Also update on timeupdate for slower updates (fallback)
      elements.video.addEventListener('timeupdate', () => {
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        const newIndex = Math.round(videoTime * fps);
        if (newIndex !== currentIndex) {
          currentIndex = newIndex;
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
      });
      
      // Update play/pause state
      elements.video.addEventListener('play', () => {
        isPlaying = true;
        if (btn) btn.textContent = 'Pause';
        updateHUD();
      });
      
      elements.video.addEventListener('pause', () => {
        isPlaying = false;
        if (btn) btn.textContent = 'Play';
        updateHUD();
      });
      
      elements.video.addEventListener('ended', () => {
        isPlaying = false;
        if (btn) btn.textContent = 'Play';
        updateHUD();
      });
      
      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HLS loading timeout')), 30000);
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
          clearTimeout(timeout);
          resolve();
        });
        hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            clearTimeout(timeout);
            reject(new Error('HLS loading error'));
          }
        });
      });
      
    } else if (elements.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      console.log('[FAVP] Using native HLS support');
      elements.video.src = playlistUrl;
      
      elements.video.addEventListener('loadedmetadata', () => {
        if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }
        if (!sharedState.width && elements.video.videoWidth) {
          sharedState.width = elements.video.videoWidth;
          sharedState.height = elements.video.videoHeight;
        }
        
        // Initialize frame index and timeline
        currentIndex = 0;
        sharedState.frameIndex = 0;
        
        // Update timeline
        if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
          elements.timelineProgress.style.width = '0%';
        }
        
        updateHUD();
      }, { once: true });
      
      // Update current frame index from video time using requestAnimationFrame for smooth updates
      let hudUpdateRafNative = null;
      
      const updateFrameFromVideo = () => {
        if (!elements.video) {
          hudUpdateRafNative = null;
          return;
        }
        
        if (elements.video.ended) {
          // Video ended, stop loop
          hudUpdateRafNative = null;
          const fps = sharedState.fps || 30;
          const videoTime = elements.video.currentTime || 0;
          currentIndex = Math.round(videoTime * fps);
          sharedState.frameIndex = currentIndex;
          updateHUD();
          return;
        }
        
        if (elements.video.paused) {
          // Video paused, stop loop but update once
          hudUpdateRafNative = null;
          const fps = sharedState.fps || 30;
          const videoTime = elements.video.currentTime || 0;
          currentIndex = Math.round(videoTime * fps);
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
          return;
        }
        
        // Video is playing, update frame
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        const newIndex = Math.round(videoTime * fps);
        
        if (newIndex !== currentIndex || videoTime > 0) {
          currentIndex = newIndex;
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
        
        // Continue loop
        hudUpdateRafNative = requestAnimationFrame(updateFrameFromVideo);
      };
      
      // Start the update loop when video starts playing
      elements.video.addEventListener('play', () => {
        console.log('[FAVP] Video play event (native), starting update loop');
        if (!hudUpdateRafNative) {
          hudUpdateRafNative = requestAnimationFrame(updateFrameFromVideo);
        }
      });
      
      elements.video.addEventListener('pause', () => {
        console.log('[FAVP] Video pause event (native)');
        if (hudUpdateRafNative) {
          cancelAnimationFrame(hudUpdateRafNative);
          hudUpdateRafNative = null;
        }
        // Still update once on pause
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        currentIndex = Math.round(videoTime * fps);
        sharedState.frameIndex = currentIndex;
        
        // Update timeline
        if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
          const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
          elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
        
        updateHUD();
      });
      
      // Also update on timeupdate for slower updates (fallback)
      elements.video.addEventListener('timeupdate', () => {
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        const newIndex = Math.round(videoTime * fps);
        if (newIndex !== currentIndex) {
          currentIndex = newIndex;
          sharedState.frameIndex = currentIndex;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
      });
      
      elements.video.addEventListener('ended', () => {
        isPlaying = false;
        if (hudUpdateRafNative) {
          cancelAnimationFrame(hudUpdateRafNative);
          hudUpdateRafNative = null;
        }
        updateHUD();
      });
    } else {
      throw new Error('HLS is not supported in this browser');
    }
    
    console.log('[FAVP] HLS player ready');
    
  } catch (e) {
    console.error('[FAVP] Server HLS error:', e);
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }
    alert('HLS setup failed: ' + e.message);
  }
}

export async function stepExact(delta) {
  if (!sharedState.totalFrames || !elements.video) return;
  
  const target = Math.min(Math.max(0, currentIndex + delta), sharedState.totalFrames - 1);
  currentIndex = target;
  
  const targetTime = frameToTime(target);
  elements.video.currentTime = targetTime;
  sharedState.frameIndex = target;
  
  updateHUD();
}

export function playExact(shared) {
  if (!elements.video) return;
  
  console.log('[FAVP] playExact called, video.paused:', elements.video.paused);
  isPlaying = true;
  
  elements.video.play().then(() => {
    console.log('[FAVP] Video play() resolved, video.paused:', elements.video.paused);
    
    // Start update loop after play() resolves
    if (!hudUpdateRaf) {
      const startUpdate = () => {
        if (!elements.video || !sharedState) {
          hudUpdateRaf = null;
          return;
        }
        
        // Only stop if truly paused or ended (not just waiting to start)
        if (elements.video.ended) {
          hudUpdateRaf = null;
          isPlaying = false;
          // Update once when ended
          const videoTime = elements.video.currentTime || 0;
          const fps = sharedState.fps || 30;
          currentIndex = Math.round(videoTime * fps);
          sharedState.frameIndex = currentIndex;
          
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
          return;
        }
        
        // If paused but we think we're playing, check again
        if (elements.video.paused && isPlaying) {
          // Might be transitioning, continue loop but don't update if really paused
          hudUpdateRaf = requestAnimationFrame(startUpdate);
          return;
        }
        
        // Video is playing (or we're paused but that's ok)
        const videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        const newIndex = Math.round(videoTime * fps);
        
        // Always update if videoTime > 0 or index changed
        if (newIndex !== currentIndex || videoTime > 0) {
          currentIndex = newIndex;
          sharedState.frameIndex = currentIndex;
          
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
        
        // Continue loop
        hudUpdateRaf = requestAnimationFrame(startUpdate);
      };
      
      hudUpdateRaf = requestAnimationFrame(startUpdate);
    }
  }).catch(e => {
    console.error('[FAVP] Play failed:', e);
    isPlaying = false;
  });
}

export function pauseExact() {
  if (!elements.video) return;
  
  console.log('[FAVP] pauseExact called');
  isPlaying = false;
  elements.video.pause();
  
  // Stop update loop
  if (hudUpdateRaf) {
    cancelAnimationFrame(hudUpdateRaf);
    hudUpdateRaf = null;
  }
  
  // Update once on pause
  const videoTime = elements.video.currentTime || 0;
  const fps = sharedState.fps || 30;
  currentIndex = Math.round(videoTime * fps);
  sharedState.frameIndex = currentIndex;
  
  if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
    const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
    elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  
  updateHUD();
}

export function seekExactToFraction(ratio) {
  if (!sharedState.totalFrames || !elements.video) return;
  
  const clamped = Math.max(0, Math.min(1, ratio));
  const idx = Math.round(clamped * (sharedState.totalFrames - 1));
  currentIndex = idx;
  
  const targetTime = frameToTime(idx);
  elements.video.currentTime = targetTime;
  sharedState.frameIndex = idx;
  
  updateHUD();
}

export function getExactTotalFrames() {
  return sharedState.totalFrames || 0;
}

function renderFrameSync(index, bmp) {
  // Not used in HLS mode - video element handles rendering
}
