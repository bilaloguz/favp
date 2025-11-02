// Server-side HLS mode: uploads video, generates HLS segments, plays via hls.js

let currentSession = null;
let hlsPlayer = null;
let currentIndex = 0;
let isSeeking = false;
let seekTargetFrame = null; // Track target frame during seek to prevent UI jumps
let lastKnownGoodTime = 0; // Track last known valid video time to prevent seeking to 0
let playbackStartTime = 0; // Track when playback started
let lastPlaybackTime = 0; // Track last playback position to detect jumps
let jumpMonitorInterval = null; // Monitor interval for detecting jumps to 0
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
        // Disable automatic level switching since we only have one quality
        abrEwmaDefaultEstimate: 500000, // Very high estimate to prevent switching
        maxBufferLength: 30, // Maximum buffer length
        maxMaxBufferLength: 60, // Maximum max buffer length
      });
      
      hlsPlayer.loadSource(playlistUrl);
      hlsPlayer.attachMedia(elements.video);
      
      // Set up HLS event handlers
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[FAVP] HLS manifest parsed, ready to play');
        
        // Lock to level 0 (first/only level) since we only generate one quality
        const levels = hlsPlayer.levels;
        if (levels && levels.length > 0) {
          console.log('[FAVP] Locking HLS to level 0 (single quality)', levels.length, 'level(s) available');
          hlsPlayer.currentLevel = 0; // Lock to first level
          hlsPlayer.loadLevel = 0; // Also lock load level
        }
        
        if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Play'; }
        
        // Set video dimensions if not set
        elements.video.addEventListener('loadedmetadata', () => {
          if (!sharedState.width && elements.video.videoWidth) {
            sharedState.width = elements.video.videoWidth;
            sharedState.height = elements.video.videoHeight;
          }
          
          // Only initialize if we're not currently seeking and video is truly at start
          if (!isSeeking && elements.video.currentTime < 0.1) {
            // Initialize frame index and timeline
            currentIndex = 0;
            sharedState.frameIndex = 0;
            
            // Update timeline
            if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
              elements.timelineProgress.style.width = '0%';
            }
            
            updateHUD();
          }
        }, { once: true });
      });
      
      hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
        console.warn('[FAVP] HLS error event:', data.type, data.details, 'fatal:', data.fatal);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('[FAVP] HLS network error, trying to recover...');
              // Store current position before recovery to restore after
              const networkErrorTime = elements.video.currentTime || 0;
              if (networkErrorTime > 0.01) {
                lastKnownGoodTime = networkErrorTime;
                lastPlaybackTime = networkErrorTime;
                console.log('[FAVP] Stored position before network recovery:', networkErrorTime);
              }
              hlsPlayer.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('[FAVP] HLS media error, trying to recover...');
              // Store current position before recovery
              const mediaErrorTime = elements.video.currentTime || 0;
              if (mediaErrorTime > 0.01) {
                lastKnownGoodTime = mediaErrorTime;
                lastPlaybackTime = mediaErrorTime;
                console.log('[FAVP] Stored position before media recovery:', mediaErrorTime);
              }
              hlsPlayer.recoverMediaError();
              break;
            default:
              console.error('[FAVP] HLS fatal error:', data);
              hlsPlayer.destroy();
              throw new Error('HLS playback error');
          }
        } else {
          // Non-fatal errors - might cause buffering which could lead to jumps
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            const errorTime = elements.video.currentTime || 0;
            if (errorTime > 0.01) {
              lastKnownGoodTime = errorTime;
              lastPlaybackTime = errorTime;
            }
          }
        }
      });
      
      // Monitor for buffering events that might cause jumps
      hlsPlayer.on(Hls.Events.BUFFER_RESET, () => {
        console.warn('[FAVP] HLS buffer reset - may cause position jump');
        const resetTime = elements.video.currentTime || 0;
        if (resetTime > 0.01) {
          lastKnownGoodTime = resetTime;
          lastPlaybackTime = resetTime;
          console.log('[FAVP] Stored position before buffer reset:', resetTime);
          
          // Monitor for jump after buffer reset
          setTimeout(() => {
            if (elements.video) {
              const afterResetTime = elements.video.currentTime || 0;
              if (afterResetTime === 0 && resetTime > 0.01 && isPlaying) {
                console.error('[FAVP] HLS buffer reset caused jump to 0! Restoring to', resetTime);
                elements.video.currentTime = resetTime;
                lastKnownGoodTime = resetTime;
                lastPlaybackTime = resetTime;
              }
            }
          }, 100);
        }
      });
      
      hlsPlayer.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        console.warn('[FAVP] HLS level switched to level', data.level, '- may cause position jump');
        
        // If level switched to something other than 0, lock it back to 0
        if (data.level !== 0) {
          console.warn('[FAVP] Unexpected level switch to', data.level, ', locking back to level 0');
          hlsPlayer.currentLevel = 0;
          hlsPlayer.loadLevel = 0;
        }
        
        const switchTime = elements.video.currentTime || 0;
        if (switchTime > 0.01) {
          lastKnownGoodTime = switchTime;
          lastPlaybackTime = switchTime;
          console.log('[FAVP] Stored position before level switch:', switchTime);
          
          // Monitor for jump after level switch - check multiple times
          let checkCount = 0;
          const checkAfterSwitch = () => {
            checkCount++;
            if (elements.video && checkCount <= 5) {
              const afterSwitchTime = elements.video.currentTime || 0;
              if (afterSwitchTime === 0 && switchTime > 0.01 && isPlaying) {
                console.error('[FAVP] HLS level switch caused jump to 0! Restoring to', switchTime, '(attempt', checkCount, ')');
                isSeeking = true;
                elements.video.currentTime = switchTime;
                lastKnownGoodTime = switchTime;
                lastPlaybackTime = switchTime;
                
                // Restore currentIndex
                const restoredIndex = Math.round(switchTime * fps);
                if (restoredIndex >= 0) {
                  currentIndex = restoredIndex;
                  sharedState.frameIndex = currentIndex;
                  if (updateHUD) updateHUD();
                }
                
                // Check again after a delay
                setTimeout(checkAfterSwitch, 100);
              } else if (afterSwitchTime > 0.01) {
                // Restore successful
                console.log('[FAVP] Position restored after level switch, time:', afterSwitchTime);
                lastKnownGoodTime = afterSwitchTime;
                lastPlaybackTime = afterSwitchTime;
                isSeeking = false;
              } else {
                // Continue checking
                setTimeout(checkAfterSwitch, 100);
              }
            } else {
              isSeeking = false;
            }
          };
          setTimeout(checkAfterSwitch, 50);
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
          
          // If seeking, use target frame to avoid showing 0
          if (isSeeking && seekTargetFrame !== null) {
            currentIndex = seekTargetFrame;
            sharedState.frameIndex = seekTargetFrame;
          } else {
            currentIndex = Math.round(videoTime * fps);
            sharedState.frameIndex = currentIndex;
          }
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
          return;
        }
        
        // Skip update if we're currently seeking
        if (isSeeking) {
          // During seek, use target frame to prevent showing frame 0
          if (seekTargetFrame !== null) {
            currentIndex = seekTargetFrame;
            sharedState.frameIndex = seekTargetFrame;
            
            // Update timeline
            if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
              const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
              elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            }
            
            updateHUD();
          }
          // Continue loop but skip frame calculation from video time
          hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
          return;
        }
        
        // Video is playing, update frame
        let videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        
        // Detect backward jumps: only if video time actually decreased significantly
        // Don't use expected time based on wall clock - HLS can have variable playback speeds
        if (isPlaying && videoTime > 0.01 && lastPlaybackTime > 0.01 && videoTime < lastPlaybackTime - 0.2) {
          // Video actually went backwards by more than 0.2 seconds
          console.error('[FAVP] DETECTED: Video jumped backwards during playback (updateFrameFromVideo)!', 'videoTime:', videoTime, 'lastPlaybackTime:', lastPlaybackTime, 'difference:', lastPlaybackTime - videoTime);
          
          // Restore to last known good position
          const restoreTime = lastPlaybackTime;
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            videoTime = restoreTime;
            // Update lastPlaybackTime after restore so we don't keep detecting the same jump
            lastPlaybackTime = restoreTime;
          }
        } else if (isPlaying && videoTime > 0.01 && lastPlaybackTime > 0.01 && Math.abs(videoTime - lastPlaybackTime) < 0.01) {
          // Video is stuck at the same time - might be buffering
          // Update lastPlaybackTime to current time to avoid false positives
          lastPlaybackTime = videoTime;
        }
        
        // CRITICAL: Detect jumps to 0 - must be first check before any other logic
        // If video is at 0 but we were playing from a non-zero position, it's a jump
        if (videoTime === 0 && isPlaying && (lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01 || currentIndex > 0)) {
          console.error('[FAVP] DETECTED JUMP TO 0 during playback!', {
            videoTime: videoTime,
            lastPlaybackTime: lastPlaybackTime,
            lastKnownGoodTime: lastKnownGoodTime,
            currentIndex: currentIndex,
            isPlaying: isPlaying
          });
          
          // Restore video position immediately
          const restoreTime = lastPlaybackTime > 0.01 ? lastPlaybackTime : (lastKnownGoodTime > 0.01 ? lastKnownGoodTime : (currentIndex / fps));
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            lastPlaybackTime = restoreTime;
            videoTime = restoreTime;
            // Don't update currentIndex, keep it
            hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
            return;
          } else {
            console.error('[FAVP] Cannot restore - invalid restoreTime:', restoreTime, 'duration:', videoDuration);
          }
        }
        
        const newIndex = Math.round(videoTime * fps);
        
        // Also detect if newIndex is 0 but we should be further
        if (newIndex === 0 && isPlaying && (currentIndex > 0 || lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01)) {
          console.error('[FAVP] DETECTED: newIndex is 0 but we should be further!', {
            newIndex: newIndex,
            videoTime: videoTime,
            currentIndex: currentIndex,
            lastPlaybackTime: lastPlaybackTime,
            lastKnownGoodTime: lastKnownGoodTime
          });
          
          // Use last known good position
          const restoreTime = lastPlaybackTime > 0.01 ? lastPlaybackTime : (lastKnownGoodTime > 0.01 ? lastKnownGoodTime : (currentIndex / fps));
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position (newIndex check) to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            lastPlaybackTime = restoreTime;
            // Don't update currentIndex
            hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
            return;
          }
        }
        
        // Update last playback time if video time is valid and progressing forward
        if (videoTime > 0.01) {
          if (videoTime >= lastPlaybackTime || lastPlaybackTime === 0) {
            lastPlaybackTime = videoTime;
            lastKnownGoodTime = videoTime;
          }
        }
        
        // Ignore updates to frame 0 if video time suggests we should be further
        // (this prevents showing frame 0 during HLS segment loading)
        if (newIndex === 0 && videoTime < 0.1 && sharedState.duration && sharedState.duration > 1 && currentIndex > 0) {
          // Video might be buffering/loading, keep current index
          hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
          return;
        }
        
        if (newIndex !== currentIndex || videoTime > 0) {
          // CRITICAL: Never update currentIndex to 0 during playback unless we're truly at the start
          // This prevents the update loop from setting it to 0 before the monitor can restore
          if (newIndex === 0 && isPlaying && (lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01 || currentIndex > 0)) {
            console.warn('[FAVP] Update loop (updateFrameFromVideo): Preventing update to 0 during playback', {
              newIndex: newIndex,
              videoTime: videoTime,
              currentIndex: currentIndex,
              lastPlaybackTime: lastPlaybackTime,
              isPlaying: isPlaying
            });
            // Don't update currentIndex - let the monitor handle it
            hudUpdateRaf = requestAnimationFrame(updateFrameFromVideo);
            return;
          }
          
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
        
        // Only initialize if we're not currently seeking and video is truly at start
        if (!isSeeking && elements.video.currentTime < 0.1) {
          // Initialize frame index and timeline
          currentIndex = 0;
          sharedState.frameIndex = 0;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            elements.timelineProgress.style.width = '0%';
          }
          
          updateHUD();
        }
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
  if (!sharedState.totalFrames || !elements.video) {
    console.warn('[FAVP] stepExact: Missing requirements', 'totalFrames:', sharedState.totalFrames, 'video:', !!elements.video);
    return;
  }
  
  // Check if video is ready and has valid duration
  if (elements.video.readyState < 2 || !elements.video.duration || elements.video.duration <= 0) {
    console.warn('[FAVP] Video not ready for stepping, currentTime:', elements.video.currentTime, 'readyState:', elements.video.readyState, 'duration:', elements.video.duration);
    return;
  }
  
  // Prevent seeking while already seeking
  if (isSeeking) {
    console.log('[FAVP] Already seeking, ignoring step request');
    return;
  }
  
  const fps = sharedState.fps || 30;
  const duration = elements.video.duration;
  
  // Use stored currentIndex instead of calculating from video time
  // Video time can be unreliable during HLS buffering/loading
  // Validate currentIndex is reasonable
  if (currentIndex < 0 || currentIndex >= sharedState.totalFrames) {
    // If currentIndex is invalid, try to calculate from video time as fallback
    let currentVideoTime = elements.video.currentTime || 0;
    if (currentVideoTime === 0 && lastKnownGoodTime > 0.01) {
      currentVideoTime = lastKnownGoodTime;
    }
    if (currentVideoTime > 0.01) {
      currentIndex = Math.round(currentVideoTime * fps);
      currentIndex = Math.min(Math.max(0, currentIndex), sharedState.totalFrames - 1);
      lastKnownGoodTime = currentVideoTime;
      console.warn('[FAVP] Recalculated currentIndex from video time:', currentIndex);
    } else {
      console.warn('[FAVP] Invalid currentIndex and no valid video time, using 0');
      currentIndex = 0;
    }
  }
  
  // Step from currentIndex
  const target = Math.min(Math.max(0, currentIndex + delta), sharedState.totalFrames - 1);
  
  // Validate target is reasonable
  if (target === 0 && currentIndex > 0 && delta > 0) {
    console.error('[FAVP] ERROR: target is 0 but currentIndex is', currentIndex, 'and delta is positive');
    return;
  }
  if (target === 0 && currentIndex > 0 && delta < 0) {
    // Going backward to frame 0 is valid
    // But let's make sure we're actually at frame 0
  }
  
  const targetTime = target / fps;
  const clampedTime = Math.max(0, Math.min(targetTime, duration));
  
  // CRITICAL: Never seek to frame 0 unless currentIndex is also 0
  if (target === 0 && currentIndex > 0) {
    console.error('[FAVP] FATAL: Attempting to seek to frame 0 from frame', currentIndex);
    return;
  }
  
  // Verify clampedTime is reasonable
  if (clampedTime === 0 && target > 0) {
    console.error('[FAVP] ERROR: clampedTime is 0 but target frame is', target);
    return;
  }
  
  // Validate clamped time
  if (isNaN(clampedTime) || clampedTime < 0 || clampedTime > duration) {
    console.error('[FAVP] Invalid clamped time:', clampedTime, 'targetTime:', targetTime, 'duration:', duration);
    return;
  }
  
  // Get current video time for comparison (but don't use it for calculation)
  const currentVideoTime = elements.video.currentTime || 0;
  
  // Prevent seeking if target is too close to current (avoids unnecessary seeks)
  // But don't use video time for this check - use frames
  if (target === currentIndex) {
    console.log('[FAVP] Target frame equals current frame, skipping seek');
    return;
  }
  
  console.log('[FAVP] stepExact: delta', delta, 'current frame', currentIndex, 'current time', currentVideoTime.toFixed(3), 'target frame', target, 'target time', clampedTime.toFixed(3), 'fps', fps);
  
  // Final validation before seeking
  if (clampedTime === 0 && currentIndex > 0) {
    console.error('[FAVP] ABORT: Attempted to seek to 0 when current frame is', currentIndex, '->', target);
    return;
  }
  
  if (target === 0 && currentIndex > 0) {
    console.error('[FAVP] ABORT: Target frame is 0 but current frame is', currentIndex);
    return;
  }
  
  // Set seeking flag to prevent update loop interference
  isSeeking = true;
  seekTargetFrame = target; // Store target to prevent showing frame 0 during seek
  currentIndex = target;
  
  // Seek the video
  try {
    // Store previous time for verification
    const previousTime = elements.video.currentTime;
    
    // Verify clampedTime is valid one more time
    if (clampedTime === 0 && previousTime > 0.01) {
      console.error('[FAVP] ABORT: clampedTime is 0 but previousTime is', previousTime);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    // Only seek if the time is significantly different
    if (Math.abs(clampedTime - previousTime) < 0.001) {
      console.log('[FAVP] Skip seek - already at target position');
      isSeeking = false;
      seekTargetFrame = null;
      currentIndex = target;
      sharedState.frameIndex = target;
      updateHUD();
      return;
    }
    
    // Set currentTime and mark as seeking
    // Use seeked event for HLS to ensure seek completes
    const seekHandler = () => {
      if (elements.video) {
        const actualTime = elements.video.currentTime;
        const actualFrame = Math.round(actualTime * fps);
        
        // If we jumped to 0 unexpectedly, restore immediately
        if (actualTime === 0 && clampedTime > 0.01 && previousTime > 0.01) {
          console.error('[FAVP] CRITICAL: Seek jumped to 0 unexpectedly! Restoring immediately', 'target was:', clampedTime, 'previous:', previousTime);
          // Keep isSeeking true and use target frame during restore
          elements.video.currentTime = clampedTime;
          currentIndex = target;
          sharedState.frameIndex = target;
          
          // Verify again after restore with multiple attempts
          let restoreAttempts = 0;
          const verifyRestore = () => {
            restoreAttempts++;
            if (elements.video) {
              const restoredTime = elements.video.currentTime;
              if (restoredTime === 0 && clampedTime > 0.01 && restoreAttempts < 5) {
                console.error('[FAVP] Restore attempt', restoreAttempts, 'failed, trying again...');
                elements.video.currentTime = clampedTime;
                setTimeout(verifyRestore, 50);
              } else {
                if (restoredTime === 0 && clampedTime > 0.01) {
                  console.error('[FAVP] Restore failed after', restoreAttempts, 'attempts. HLS may be broken.');
                } else {
                  currentIndex = Math.round(restoredTime * fps);
                  sharedState.frameIndex = currentIndex;
                  console.log('[FAVP] Restore successful after', restoreAttempts, 'attempts, time:', restoredTime);
                }
                isSeeking = false;
                seekTargetFrame = null;
                updateHUD();
              }
            } else {
              isSeeking = false;
              seekTargetFrame = null;
            }
          };
          setTimeout(verifyRestore, 50);
        } else {
          // Update with actual position (may be slightly different due to frame boundaries)
          currentIndex = actualFrame;
          sharedState.frameIndex = actualFrame;
          isSeeking = false;
          seekTargetFrame = null;
          
          // Update timeline
          if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
            const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
            elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          }
          
          updateHUD();
        }
        
        elements.video.removeEventListener('seeked', seekHandler);
      }
    };
    
    // CRITICAL: Validate clampedTime is NOT 0 before setting
    if (clampedTime === 0 && previousTime > 0.01) {
      console.error('[FAVP] FATAL ERROR: Attempting to seek to 0 when previous time was', previousTime);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    // Monitor for jumps to 0 during seek
    let monitorInterval = null;
    const startMonitoring = () => {
      let checkCount = 0;
      monitorInterval = setInterval(() => {
        if (!elements.video || !isSeeking) {
          if (monitorInterval) clearInterval(monitorInterval);
          return;
        }
        
        checkCount++;
        const actualTime = elements.video.currentTime;
        
        // Update last known good time
        if (actualTime > 0.01) {
          lastKnownGoodTime = actualTime;
        }
        
        // If video jumped to 0, restore immediately
        if (actualTime === 0 && clampedTime > 0.01 && previousTime > 0.01) {
          console.error('[FAVP] MONITOR detected jump to 0 at check', checkCount, '- restoring immediately');
          if (monitorInterval) clearInterval(monitorInterval);
          monitorInterval = null;
          
          // Use last known good time or clampedTime, whichever is better
          const restoreTime = lastKnownGoodTime > 0.01 && lastKnownGoodTime < clampedTime ? lastKnownGoodTime : clampedTime;
          elements.video.currentTime = restoreTime;
          
          // Continue monitoring after restore
          setTimeout(() => {
            if (elements.video && elements.video.currentTime === 0 && clampedTime > 0.01) {
              console.error('[FAVP] Restore failed, trying again...');
              elements.video.currentTime = clampedTime;
              if (clampedTime > 0.01) {
                lastKnownGoodTime = clampedTime;
              }
            }
          }, 50);
        }
        
        // Stop monitoring after 1 second
        if (checkCount > 20) {
          if (monitorInterval) clearInterval(monitorInterval);
          monitorInterval = null;
        }
      }, 50);
    };
    
    // Wrap seekHandler to clear monitor
    const wrappedSeekHandler = () => {
      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
      seekHandler();
    };
    
    elements.video.addEventListener('seeked', wrappedSeekHandler, { once: true });
    
    // Set currentTime - this is the critical line
    console.log('[FAVP] Setting currentTime to', clampedTime, 'from', previousTime, 'target frame', target);
    
    // Start monitoring before seeking
    startMonitoring();
    
    // Double-check before setting - NEVER seek to 0 unless we're already at 0
    if (clampedTime === 0 && previousTime > 0.001) {
      console.error('[FAVP] FATAL: clampedTime is 0 at last check, aborting seek', 'previousTime:', previousTime, 'currentFrame:', currentFrameFromVideo, 'validFrame:', validCurrentFrame, 'target:', target);
      if (monitorInterval) clearInterval(monitorInterval);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    // Final check: never set to 0 if previous time suggests we should be past 0
    if (clampedTime === 0 && previousTime > 0.001) {
      console.error('[FAVP] FATAL ABORT: Refusing to set currentTime to 0');
      if (monitorInterval) clearInterval(monitorInterval);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    // ONE MORE CHECK: ensure clampedTime is reasonable
    if (clampedTime < 0.001 && target > 0) {
      console.error('[FAVP] FATAL: clampedTime too small for target frame', 'clampedTime:', clampedTime, 'target:', target);
      if (monitorInterval) clearInterval(monitorInterval);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    // Verify one final time that we're not about to seek to 0 inappropriately
    const finalCheck = elements.video.currentTime || 0;
    if (clampedTime === 0 && finalCheck > 0.001) {
      console.error('[FAVP] FATAL: Last chance check failed - video time changed to', finalCheck, 'but clampedTime is 0');
      if (monitorInterval) clearInterval(monitorInterval);
      isSeeking = false;
      seekTargetFrame = null;
      return;
    }
    
    console.log('[FAVP] PROCEEDING with seek - clampedTime:', clampedTime, 'previousTime:', previousTime, 'target frame:', target);
    elements.video.currentTime = clampedTime;
    sharedState.frameIndex = target;
    
    // Fallback timeout in case seeked event doesn't fire
    setTimeout(() => {
      if (isSeeking && elements.video) {
        const actualTime = elements.video.currentTime;
        const actualFrame = Math.round(actualTime * fps);
        
        // If we jumped to 0 unexpectedly, restore
        if (actualTime === 0 && clampedTime > 0.1 && previousTime > 0.1) {
          console.warn('[FAVP] Seek jumped to 0 (timeout fallback), restoring to', clampedTime, 'previous:', previousTime);
          elements.video.currentTime = clampedTime;
          currentIndex = target;
          sharedState.frameIndex = target;
          isSeeking = false;
          seekTargetFrame = null;
        } else if (Math.abs(actualTime - clampedTime) > 0.5 && previousTime > 0.1) {
          // If we jumped far away from target (more than 0.5 seconds), try to restore
          console.warn('[FAVP] Seek jumped far from target (timeout), restoring to', clampedTime, 'actual:', actualTime, 'previous:', previousTime);
          elements.video.currentTime = clampedTime;
          currentIndex = target;
          sharedState.frameIndex = target;
          isSeeking = false;
          seekTargetFrame = null;
        } else {
          // Update with actual position (may be slightly different due to frame boundaries)
          currentIndex = actualFrame;
          sharedState.frameIndex = actualFrame;
          isSeeking = false;
          seekTargetFrame = null;
        }
        
        // Update timeline
        if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
          const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
          elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
        
        updateHUD();
      }
    }, 300);
    
    // Update timeline immediately
    if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
      const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
      elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
    
    updateHUD();
  } catch (e) {
    console.error('[FAVP] Error in stepExact:', e);
  }
}

export function setExactFrame(targetFrame) {
  if (!elements.video) {
    console.error('[FAVP] setExactFrame: No video element');
    return;
  }
  
  if (!sharedState.totalFrames) {
    console.error('[FAVP] setExactFrame: No totalFrames set');
    return;
  }
  
  const target = Math.min(Math.max(0, Math.floor(targetFrame)), sharedState.totalFrames - 1);
  const fps = sharedState.fps || 30;
  const targetTime = target / fps;
  
  console.log('[FAVP] setExactFrame: target frame:', target, 'target time:', targetTime, 'fps:', fps, 'totalFrames:', sharedState.totalFrames);
  console.log('[FAVP] Video readyState:', elements.video.readyState, 'duration:', elements.video.duration);
  
  // Check if video is ready for seeking
  if (elements.video.readyState < 2 || !elements.video.duration || elements.video.duration <= 0) {
    console.warn('[FAVP] Video not ready for seeking, waiting...', 'readyState:', elements.video.readyState, 'duration:', elements.video.duration);
    return;
  }
  
  // Clamp targetTime to valid range
  const duration = elements.video.duration;
  const clampedTime = Math.max(0, Math.min(targetTime, duration));
  
  // Validate clamped time
  if (isNaN(clampedTime) || clampedTime < 0 || clampedTime > duration) {
    console.error('[FAVP] Invalid clamped time:', clampedTime, 'targetTime:', targetTime, 'duration:', duration);
    return;
  }
  
  // Validate clamped time - if it's 0 but we're not at the start, something's wrong
  if (clampedTime === 0 && targetTime > 0.1) {
    console.warn('[FAVP] Clamped time is 0 but target was', targetTime, 'frame', target);
    return;
  }
  
  const currentVideoTime = elements.video.currentTime || 0;
  console.log('[FAVP] Seeking to time:', clampedTime, 'duration:', duration, 'target frame:', target, 'current time:', currentVideoTime);
  
  // Set seeking flag to prevent update loop interference
  isSeeking = true;
  seekTargetFrame = target; // Store target to prevent showing frame 0 during seek
  currentIndex = target;
  
  // Pause video if playing for more accurate seeking
  const wasPlaying = !elements.video.paused;
  if (wasPlaying) {
    elements.video.pause();
  }
  
  // Seek the video
  try {
    const previousTime = elements.video.currentTime;
    
    // Set currentTime directly
    elements.video.currentTime = clampedTime;
    
    // Verify the seek worked
    setTimeout(() => {
      if (elements.video) {
        const actualTime = elements.video.currentTime;
        const actualFrame = Math.round(actualTime * fps);
        
        // If we jumped to 0 unexpectedly, try to restore
        if (actualTime === 0 && clampedTime > 0.1 && previousTime > 0.1) {
          console.warn('[FAVP] Seek jumped to 0 unexpectedly, trying to restore to', clampedTime);
          elements.video.currentTime = clampedTime;
          currentIndex = target;
          sharedState.frameIndex = target;
          
          // Verify again after restore
          setTimeout(() => {
            if (elements.video) {
              const restoredTime = elements.video.currentTime;
              if (restoredTime === 0 && clampedTime > 0.1) {
                console.error('[FAVP] Restore failed, video still at 0. This may be an HLS buffering issue.');
              } else {
                currentIndex = Math.round(restoredTime * fps);
                sharedState.frameIndex = currentIndex;
              }
            }
            isSeeking = false;
            seekTargetFrame = null;
            updateHUD();
          }, 100);
        } else if (Math.abs(actualTime - clampedTime) > 0.5 && previousTime > 0.1) {
          // If we jumped far away from target, try to restore
          console.warn('[FAVP] Seek jumped far from target, restoring to', clampedTime, 'actual:', actualTime, 'previous:', previousTime);
          elements.video.currentTime = clampedTime;
          currentIndex = target;
          sharedState.frameIndex = target;
          isSeeking = false;
          seekTargetFrame = null;
        } else {
          currentIndex = actualFrame;
          sharedState.frameIndex = actualFrame;
          isSeeking = false;
          seekTargetFrame = null;
        }
        
        // Update timeline
        if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
          const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
          elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
        
        updateHUD();
        
        // Resume if it was playing
        if (wasPlaying && elements.video.paused) {
          elements.video.play();
        }
      } else {
        isSeeking = false;
        seekTargetFrame = null;
      }
    }, 150);
    
    // Also update immediately
    sharedState.frameIndex = target;
    
    // Update timeline immediately
    if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
      const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
      elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
    
    updateHUD();
    
  } catch (e) {
    console.error('[FAVP] Error setting currentTime:', e);
    isSeeking = false;
    seekTargetFrame = null;
    if (wasPlaying) {
      elements.video.play();
    }
  }
}

export function playExact(shared) {
  if (!elements.video) return;
  
  console.log('[FAVP] playExact called, video.paused:', elements.video.paused);
  isPlaying = true;
  
  // Track playback start time and initial position
  playbackStartTime = Date.now();
  lastPlaybackTime = elements.video.currentTime || 0;
  if (lastPlaybackTime > 0.01) {
    lastKnownGoodTime = lastPlaybackTime;
  }
  console.log('[FAVP] Playback starting from time:', lastPlaybackTime, 'frame:', currentIndex);
  
  // Start a continuous monitor for jumps to 0 during playback
  const startJumpMonitor = () => {
    // Clear existing monitor
    if (jumpMonitorInterval) {
      clearInterval(jumpMonitorInterval);
      jumpMonitorInterval = null;
    }
    
    jumpMonitorInterval = setInterval(() => {
      if (!elements.video || !isPlaying) {
        if (jumpMonitorInterval) {
          clearInterval(jumpMonitorInterval);
          jumpMonitorInterval = null;
        }
        return;
      }
      
      const checkTime = elements.video.currentTime || 0;
      const checkIndex = Math.round(checkTime * (sharedState.fps || 30));
      
      // Check if video jumped to 0 or near 0
      // Must be playing and have had a previous position
      if (checkTime === 0 && isPlaying && (lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01)) {
        console.error('[FAVP] MONITOR: Detected jump to 0!', {
          checkTime: checkTime,
          checkIndex: checkIndex,
          lastPlaybackTime: lastPlaybackTime,
          lastKnownGoodTime: lastKnownGoodTime,
          currentIndex: currentIndex,
          isPlaying: isPlaying,
          videoPaused: elements.video.paused,
          videoEnded: elements.video.ended
        });
        
        // Restore immediately - use lastPlaybackTime or lastKnownGoodTime
        // Don't use currentIndex/fps because currentIndex might already be 0
        const restoreTime = lastPlaybackTime > 0.01 ? lastPlaybackTime : lastKnownGoodTime;
        const videoDuration = elements.video.duration || sharedState.duration || 0;
        const fps = sharedState.fps || 30;
        
        if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
          console.error('[FAVP] MONITOR: Restoring video position to', restoreTime, 'from 0');
          
          // Set seeking flag to prevent update loop interference
          isSeeking = true;
          
          // Restore video position first
          elements.video.currentTime = restoreTime;
          lastKnownGoodTime = restoreTime;
          lastPlaybackTime = restoreTime;
          
          // ALWAYS restore currentIndex based on restored time (even if it was 0)
          const restoredIndex = Math.round(restoreTime * fps);
          if (restoredIndex >= 0) {
            currentIndex = restoredIndex;
            sharedState.frameIndex = currentIndex;
            
            // Update timeline immediately
            if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
              const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
              elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            }
            
            // Update HUD
            if (updateHUD) {
              updateHUD();
            }
            
            console.error('[FAVP] MONITOR: Restored currentIndex to', currentIndex, 'frame from time', restoreTime);
          }
          
          // Verify restore worked and keep restoring if needed (multiple attempts)
          let restoreAttempts = 0;
          const verifyAndRestore = () => {
            restoreAttempts++;
            if (elements.video && isPlaying) {
              const verifyTime = elements.video.currentTime || 0;
              if (verifyTime === 0 && restoreTime > 0.01 && restoreAttempts < 10) {
                console.error('[FAVP] MONITOR: Video still at 0 after restore attempt', restoreAttempts, ', restoring again to', restoreTime);
                isSeeking = true;
                elements.video.currentTime = restoreTime;
                
                // Try again after a short delay
                setTimeout(verifyAndRestore, 100);
                return;
              } else if (verifyTime > 0.01) {
                // Restore successful
                console.log('[FAVP] MONITOR: Restore successful after', restoreAttempts, 'attempt(s), time:', verifyTime);
                lastPlaybackTime = verifyTime;
                lastKnownGoodTime = verifyTime;
                isSeeking = false;
                
                // Restore currentIndex
                const restoredIndex = Math.round(verifyTime * fps);
                if (restoredIndex >= 0) {
                  currentIndex = restoredIndex;
                  sharedState.frameIndex = currentIndex;
                }
              } else {
                isSeeking = false;
              }
            } else {
              isSeeking = false;
            }
          };
          setTimeout(verifyAndRestore, 100);
          
          // Also try to resume if video was paused - do this aggressively
          if (elements.video.paused && isPlaying) {
            console.log('[FAVP] MONITOR: Video was paused during jump, attempting to resume');
            // Try to resume multiple times if needed
            const tryResume = () => {
              if (elements.video && isPlaying && elements.video.paused) {
                elements.video.play().then(() => {
                  console.log('[FAVP] MONITOR: Successfully resumed playback');
                }).catch(e => {
                  console.error('[FAVP] MONITOR: Failed to resume playback:', e);
                  // Try again after a delay
                  if (restoreAttempts < 5) {
                    setTimeout(tryResume, 200);
                  }
                });
              }
            };
            tryResume();
          }
        } else {
          console.error('[FAVP] MONITOR: Cannot restore - invalid restoreTime:', restoreTime, 'duration:', videoDuration);
        }
      } else if (checkTime > 0.01) {
        // Update tracking if time is valid and progressing
        if (checkTime >= lastPlaybackTime || lastPlaybackTime === 0) {
          lastPlaybackTime = checkTime;
          lastKnownGoodTime = checkTime;
        }
      }
    }, 50); // Check every 50ms for faster detection
  };
  
  elements.video.play().then(() => {
    console.log('[FAVP] Video play() resolved, video.paused:', elements.video.paused);
    
    // Start jump monitor
    startJumpMonitor();
    
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
        let videoTime = elements.video.currentTime || 0;
        const fps = sharedState.fps || 30;
        
        // Detect backward jumps: only if video time actually decreased significantly
        // Don't use expected time based on wall clock - HLS can have variable playback speeds
        if (videoTime > 0.01 && lastPlaybackTime > 0.01 && videoTime < lastPlaybackTime - 0.2) {
          // Video actually went backwards by more than 0.2 seconds
          console.error('[FAVP] DETECTED: Video jumped backwards during playback!', 'videoTime:', videoTime, 'lastPlaybackTime:', lastPlaybackTime, 'difference:', lastPlaybackTime - videoTime);
          
          // Restore to last known good position
          const restoreTime = lastPlaybackTime;
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            videoTime = restoreTime;
            // Update lastPlaybackTime after restore so we don't keep detecting the same jump
            lastPlaybackTime = restoreTime;
          }
        } else if (videoTime > 0.01 && lastPlaybackTime > 0.01 && Math.abs(videoTime - lastPlaybackTime) < 0.01) {
          // Video is stuck at the same time - might be buffering or actually stuck
          // Update lastPlaybackTime to current time to avoid false positives
          lastPlaybackTime = videoTime;
        }
        
        // CRITICAL: Detect jumps to 0 - must be first check before any other logic
        // If video is at 0 but we were playing from a non-zero position, it's a jump
        if (videoTime === 0 && isPlaying && (lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01 || currentIndex > 0)) {
          console.error('[FAVP] DETECTED JUMP TO 0 during playback (playExact)!', {
            videoTime: videoTime,
            lastPlaybackTime: lastPlaybackTime,
            lastKnownGoodTime: lastKnownGoodTime,
            currentIndex: currentIndex,
            isPlaying: isPlaying
          });
          
          // Restore video position immediately
          const restoreTime = lastPlaybackTime > 0.01 ? lastPlaybackTime : (lastKnownGoodTime > 0.01 ? lastKnownGoodTime : (currentIndex / fps));
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position (playExact) to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            lastPlaybackTime = restoreTime;
            videoTime = restoreTime;
            // Don't update currentIndex
            hudUpdateRaf = requestAnimationFrame(startUpdate);
            return;
          } else {
            console.error('[FAVP] Cannot restore (playExact) - invalid restoreTime:', restoreTime, 'duration:', videoDuration);
          }
        }
        
        const newIndex = Math.round(videoTime * fps);
        
        // Also detect if newIndex is 0 but we should be further
        if (newIndex === 0 && isPlaying && (currentIndex > 0 || lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01)) {
          console.error('[FAVP] DETECTED: newIndex is 0 but we should be further (playExact)!', {
            newIndex: newIndex,
            videoTime: videoTime,
            currentIndex: currentIndex,
            lastPlaybackTime: lastPlaybackTime,
            lastKnownGoodTime: lastKnownGoodTime
          });
          
          // Use last known good position
          const restoreTime = lastPlaybackTime > 0.01 ? lastPlaybackTime : (lastKnownGoodTime > 0.01 ? lastKnownGoodTime : (currentIndex / fps));
          const videoDuration = elements.video.duration || sharedState.duration || 0;
          
          if (restoreTime > 0.01 && (videoDuration === 0 || restoreTime <= videoDuration)) {
            console.error('[FAVP] Restoring video position (newIndex check playExact) to', restoreTime);
            elements.video.currentTime = restoreTime;
            lastKnownGoodTime = restoreTime;
            lastPlaybackTime = restoreTime;
            // Don't update currentIndex
            hudUpdateRaf = requestAnimationFrame(startUpdate);
            return;
          }
        }
        
        // Update last playback time if video time is valid and progressing forward
        // Only update if time increased (not just if it's valid)
        if (videoTime > 0.01) {
          if (videoTime > lastPlaybackTime) {
            // Video progressed forward - update tracking
            lastPlaybackTime = videoTime;
            lastKnownGoodTime = videoTime;
          } else if (Math.abs(videoTime - lastPlaybackTime) < 0.05) {
            // Video time is close to last (might be buffering) - update to avoid false positives
            lastPlaybackTime = videoTime;
            lastKnownGoodTime = videoTime;
          }
        }
        
        // Always update if videoTime > 0 or index changed (but not if it's an invalid jump to 0)
        if (newIndex !== currentIndex || videoTime > 0) {
          // CRITICAL: Never update currentIndex to 0 during playback unless we're truly at the start
          // This prevents the update loop from setting it to 0 before the monitor can restore
          if (newIndex === 0 && isPlaying && (lastPlaybackTime > 0.01 || lastKnownGoodTime > 0.01 || currentIndex > 0)) {
            console.warn('[FAVP] Update loop: Preventing update to 0 during playback', {
              newIndex: newIndex,
              videoTime: videoTime,
              currentIndex: currentIndex,
              lastPlaybackTime: lastPlaybackTime,
              isPlaying: isPlaying
            });
            // Don't update currentIndex - let the monitor handle it
            hudUpdateRaf = requestAnimationFrame(startUpdate);
            return;
          }
          
          // Only update if not an invalid jump to 0
          if (!(newIndex === 0 && currentIndex > 10)) {
            currentIndex = newIndex;
            sharedState.frameIndex = currentIndex;
            
            if (elements.timelineProgress && sharedState.totalFrames && sharedState.totalFrames > 1) {
              const pct = (currentIndex / (sharedState.totalFrames - 1)) * 100;
              elements.timelineProgress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            }
            
            updateHUD();
          }
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
  
  // Clear jump monitor interval
  if (jumpMonitorInterval) {
    clearInterval(jumpMonitorInterval);
    jumpMonitorInterval = null;
  }
  
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

