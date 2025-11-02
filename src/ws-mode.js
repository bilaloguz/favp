/**
 * Hybrid mode: HLS for video streaming, WebSocket for control commands
 * Provides reliable frame-accurate playback with strict level control
 */

export async function enableWebSocketMode(elements, sharedState, updateHUD) {
  console.log('[FAVP] Hybrid mode enabled (HLS + WebSocket control)');
  
  let ws = null;
  let hlsPlayer = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const reconnectDelay = 1000; // 1 second
  
  const video = elements.video;
  let isPlaying = false;
  let currentFrame = 0;
  let sessionId = null;
  let fps = sharedState?.fps || null;
  let totalFrames = sharedState?.totalFrames || 0;
  
  // Check if HLS.js is loaded
  if (typeof Hls === 'undefined') {
    throw new Error('HLS.js library not loaded');
  }
  
  /**
   * Connect to WebSocket endpoint for control
   */
  async function connect(sid) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[FAVP] WebSocket already connected');
      return;
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/${sid}`;
    
    return new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          console.log('[FAVP] WebSocket connected');
          reconnectAttempts = 0;
          resolve();
        };
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
          } catch (e) {
            console.error('[FAVP] Error parsing WebSocket message:', e);
          }
        };
        
        ws.onerror = (error) => {
          console.error('[FAVP] WebSocket error:', error);
          reject(error);
        };
        
        ws.onclose = (event) => {
          console.log('[FAVP] WebSocket closed', event.code, event.reason);
          if (isPlaying && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            console.log(`[FAVP] Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
            setTimeout(() => {
              connect(sessionId).catch(err => {
                console.error('[FAVP] Reconnection failed:', err);
                if (reconnectAttempts >= maxReconnectAttempts) {
                  console.error('[FAVP] Max reconnection attempts reached');
                  isPlaying = false;
                  if (updateHUD) updateHUD();
                }
              });
            }, reconnectDelay);
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Handle WebSocket messages (control state updates)
   */
  function handleWebSocketMessage(data) {
    if (data.type === 'state') {
      // Update state from server
      if (data.current_frame !== undefined) {
        currentFrame = data.current_frame;
        sharedState.frameIndex = data.current_frame;
      }
      if (data.is_playing !== undefined) {
        isPlaying = data.is_playing;
        // Sync video element with WebSocket state
        if (video) {
          if (isPlaying && video.paused) {
            video.play().catch(e => console.error('[FAVP] Error playing video:', e));
          } else if (!isPlaying && !video.paused) {
            video.pause();
          }
        }
      }
      if (updateHUD) updateHUD();
    } else if (data.type === 'error') {
      console.error('[FAVP] WebSocket error:', data.message);
      isPlaying = false;
      if (updateHUD) updateHUD();
    }
  }
  
  /**
   * Send control command via WebSocket
   */
  function sendCommand(action, data = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...data }));
    } else {
      console.warn('[FAVP] WebSocket not connected, cannot send command:', action);
    }
  }
  
  /**
   * Initialize HLS and WebSocket
   */
  async function init(sid) {
    sessionId = sid;
    
    // Store fps and totalFrames from sharedState
    if (sharedState.fps) fps = sharedState.fps;
    if (sharedState.totalFrames) totalFrames = sharedState.totalFrames;
    
    try {
      // First, connect WebSocket for control
      await connect(sid);
      
      // Make video visible, hide canvas
      if (video) video.classList.remove('hidden');
      if (elements.canvas) elements.canvas.classList.add('hidden');
      
      // Update fps and totalFrames from sharedState if available
      if (sharedState.fps) fps = sharedState.fps;
      if (sharedState.totalFrames) totalFrames = sharedState.totalFrames;
      
      // Show loading placeholder while HLS generates
      if (elements.canvas) {
        const canvas = elements.canvas;
        const ctx = canvas.getContext('2d');
        canvas.width = 960;
        canvas.height = 540;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Generating video stream...', canvas.width / 2, canvas.height / 2);
        canvas.classList.remove('hidden');
        video.classList.add('hidden');
      }
      
      // Generate HLS segments in background (POST request, async)
      console.log('[FAVP] Starting HLS generation...');
      const generateResp = await fetch(`/api/generate-hls/${sid}?segment_duration=1.0`, {
        method: 'POST'
      });
      if (!generateResp.ok) {
        throw new Error(`HLS generation failed: ${generateResp.status}`);
      }
      
      const generateResult = await generateResp.json();
      const playlistUrl = `/api/hls/${sid}/playlist.m3u8`;
      
      console.log('[FAVP] HLS generated, setting up player...');
      
      // Hide canvas, show video now that HLS is ready
      if (elements.canvas) elements.canvas.classList.add('hidden');
      if (video) video.classList.remove('hidden');
      
      // Setup HLS player with strict level control
      if (Hls.isSupported()) {
        hlsPlayer = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 10,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          // Strict level control - disable automatic switching
          abrEwmaDefaultEstimate: 500000, // Very high estimate to prevent switching
          abrEwmaSlowVoD: 3.0,
          abrEwmaFastVoD: 9.0,
          abrBandWidthFactor: 0.95,
          abrBandWidthUpFactor: 0.7,
          // Force single level
          startLevel: 0,
          capLevelToPlayerSize: false,
          autoStartLoad: false,
        });
        
        hlsPlayer.loadSource(playlistUrl);
        hlsPlayer.attachMedia(video);
        
        // Lock to level 0 immediately and keep it locked
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('[FAVP] HLS manifest parsed');
          
          // Lock to level 0 (single quality)
          const levels = hlsPlayer.levels;
          if (levels && levels.length > 0) {
            console.log('[FAVP] Locking HLS to level 0 (strict control)', levels.length, 'level(s) available');
            hlsPlayer.currentLevel = 0;
            hlsPlayer.loadLevel = 0;
            hlsPlayer.nextLevel = 0;
          }
        });
        
        // Prevent level switching
        hlsPlayer.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
          if (data.level !== 0) {
            console.warn('[FAVP] HLS attempted to switch to level', data.level, '- forcing back to level 0');
            hlsPlayer.currentLevel = 0;
            hlsPlayer.loadLevel = 0;
            hlsPlayer.nextLevel = 0;
          }
        });
        
        // Handle HLS errors
        hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error('[FAVP] HLS fatal error:', data);
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.error('[FAVP] Network error, trying to recover...');
                hlsPlayer.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.error('[FAVP] Media error, trying to recover...');
                hlsPlayer.recoverMediaError();
                break;
              default:
                console.error('[FAVP] Fatal error, cannot recover');
                hlsPlayer.destroy();
                break;
            }
          }
        });
        
        // Track video time for frame calculation and continuous timeline updates
        let lastUpdateTime = 0;
        let updateAnimationFrame = null;
        
        // Use requestAnimationFrame for smooth timeline updates during playback
        function updateFrameFromVideo() {
          if (!fps || !totalFrames || !video) {
            updateAnimationFrame = null;
            return;
          }
          
          // Skip if seeking (handled by seeked event)
          if (window.isSeeking) {
            updateAnimationFrame = requestAnimationFrame(updateFrameFromVideo);
            return;
          }
          
          const videoTime = video.currentTime || 0;
          const newFrame = Math.floor(videoTime * fps);
          
          if (newFrame >= 0 && newFrame < totalFrames && newFrame !== currentFrame) {
            currentFrame = newFrame;
            sharedState.frameIndex = newFrame;
            
            // Send frame update to server via WebSocket (non-blocking, throttled)
            const now = Date.now();
            if (now - lastUpdateTime > 100) { // Throttle to every 100ms
              if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                  ws.send(JSON.stringify({ action: 'update_frame', frame: newFrame }));
                  lastUpdateTime = now;
                } catch (e) {
                  // Ignore send errors (non-critical)
                }
              }
            }
            
            if (updateHUD) updateHUD();
          }
          
          // Continue updating during playback
          if (!video.paused) {
            updateAnimationFrame = requestAnimationFrame(updateFrameFromVideo);
          } else {
            updateAnimationFrame = null;
          }
        }
        
        // Start continuous frame tracking when video starts playing
        video.addEventListener('play', () => {
          if (!updateAnimationFrame) {
            updateFrameFromVideo();
          }
        });
        
        // Stop updating when paused
        video.addEventListener('pause', () => {
          if (updateAnimationFrame) {
            cancelAnimationFrame(updateAnimationFrame);
            updateAnimationFrame = null;
          }
        });
        
        // Also use timeupdate for fallback (throttled by browser, but more reliable)
        video.addEventListener('timeupdate', () => {
          if (fps && totalFrames && !window.isSeeking) {
            const videoTime = video.currentTime || 0;
            const newFrame = Math.floor(videoTime * fps);
            if (newFrame >= 0 && newFrame < totalFrames && newFrame !== currentFrame) {
              currentFrame = newFrame;
              sharedState.frameIndex = newFrame;
              if (updateHUD) updateHUD();
            }
          }
        });
        
        // Handle seeking completion
        video.addEventListener('seeked', () => {
          window.isSeeking = false;
          if (fps && totalFrames) {
            const videoTime = video.currentTime || 0;
            const newFrame = Math.floor(videoTime * fps);
            if (newFrame >= 0 && newFrame < totalFrames) {
              currentFrame = newFrame;
              sharedState.frameIndex = newFrame;
              if (updateHUD) updateHUD();
            }
          }
        });
        
        // Handle video ended
        video.addEventListener('ended', () => {
          isPlaying = false;
          currentFrame = totalFrames - 1;
          sharedState.frameIndex = totalFrames - 1;
          sendCommand('pause');
          if (updateHUD) updateHUD();
        });
        
        // Handle video loaded
        video.addEventListener('loadedmetadata', () => {
          if (!sharedState.width && video.videoWidth) {
            sharedState.width = video.videoWidth;
            sharedState.height = video.videoHeight;
          }
          if (updateHUD) updateHUD();
        });
        
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = playlistUrl;
        console.log('[FAVP] Using native HLS support');
      } else {
        throw new Error('HLS not supported in this browser');
      }
      
      console.log('[FAVP] HLS player initialized');
      
    } catch (e) {
      console.error('[FAVP] Failed to initialize HLS + WebSocket mode:', e);
      throw e;
    }
  }
  
  /**
   * Play video
   */
  function play() {
    if (video && !video.paused) return;
    
    sendCommand('play');
    
    if (hlsPlayer) {
      hlsPlayer.startLoad();
    }
    
    if (video) {
      video.play().catch(e => {
        console.error('[FAVP] Error playing video:', e);
      });
    }
    
    isPlaying = true;
    if (updateHUD) updateHUD();
  }
  
  /**
   * Pause video
   */
  function pause() {
    if (video && video.paused) return;
    
    sendCommand('pause');
    
    if (video) {
      video.pause();
    }
    
    isPlaying = false;
    if (updateHUD) updateHUD();
  }
  
  /**
   * Seek to specific frame
   */
  async function setFrame(targetFrame) {
    if (!fps || !video || totalFrames === 0) return;
    
    targetFrame = Math.max(0, Math.min(targetFrame, totalFrames - 1));
    const targetTime = targetFrame / fps;
    
    sendCommand('seek', { frame: targetFrame });
    
    if (video) {
      // Set seeking flag to prevent timeupdate from interfering
      if (typeof window.isSeeking === 'undefined') {
        window.isSeeking = false;
      }
      window.isSeeking = true;
      
      // Pause video first to prevent timeupdate during seek
      const wasPlaying = !video.paused && isPlaying;
      if (wasPlaying) {
        video.pause();
      }
      
      // Update frame immediately before seeking
      currentFrame = targetFrame;
      sharedState.frameIndex = targetFrame;
      if (updateHUD) updateHUD();
      
      // Seek to target time
      video.currentTime = targetTime;
      
      // Wait for seek to complete
      await new Promise((resolve) => {
        if (video.readyState >= 2) { // HAVE_CURRENT_DATA
          const onSeeked = () => {
            window.isSeeking = false;
            resolve();
          };
          video.addEventListener('seeked', onSeeked, { once: true });
          // Timeout fallback (in case seeked doesn't fire)
          setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            window.isSeeking = false;
            resolve();
          }, 200);
        } else {
          window.isSeeking = false;
          resolve();
        }
      });
      
      // Update frame after seek completes
      const finalTime = video.currentTime || 0;
      const finalFrame = Math.floor(finalTime * fps);
      if (finalFrame >= 0 && finalFrame < totalFrames) {
        currentFrame = finalFrame;
        sharedState.frameIndex = finalFrame;
      }
      
      // Restore playing state if it was playing
      if (wasPlaying && isPlaying) {
        video.play().catch(e => console.error('[FAVP] Error resuming playback:', e));
      }
      
      if (updateHUD) updateHUD();
    }
  }
  
  /**
   * Step frames
   */
  function step(delta) {
    const targetFrame = Math.max(0, Math.min(currentFrame + delta, totalFrames - 1));
    setFrame(targetFrame);
  }
  
  /**
   * Next frame
   */
  function next() {
    if (!fps || !video || totalFrames === 0) return;
    
    const nextFrame = Math.min(currentFrame + 1, totalFrames - 1);
    if (nextFrame > currentFrame) {
      sendCommand('next_frame');
      setFrame(nextFrame);
    }
  }
  
  /**
   * Previous frame
   */
  function prev() {
    if (!fps || !video || totalFrames === 0) return;
    
    const prevFrame = Math.max(currentFrame - 1, 0);
    if (prevFrame < currentFrame) {
      sendCommand('prev_frame');
      setFrame(prevFrame);
    }
  }
  
  /**
   * Disconnect
   */
  function disconnect() {
    isPlaying = false;
    
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
    
    if (ws) {
      ws.close();
      ws = null;
    }
  }
  
  // Return API
  return {
    init,
    play,
    pause,
    setFrame,
    step,
    next,
    prev,
    getCurrentFrame: () => currentFrame,
    isPlaying: () => isPlaying,
    disconnect,
  };
}