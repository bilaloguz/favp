# FAVP - Frame Accurate Video Player

A frame-accurate HTML5 video player with frame-by-frame navigation.

## Features

- **Frame-accurate playback**: Navigate frame by frame with precise timing
- **Hybrid architecture**: HLS streaming for efficient video delivery + WebSocket for control
- **Strict level control**: Prevents position jumps during playback
- **Frame navigation**: Previous/Next frame buttons and "Go to frame" functionality
- **Timeline seeking**: Click on timeline to jump to any frame
- **Keyboard shortcuts**: Space/K for play/pause, J/L or arrows for frame stepping

## Architecture

- **Frontend**: HTML5 video element with HLS.js for streaming
- **Backend**: FastAPI server with FFmpeg for video processing
- **Control**: WebSocket connection for play/pause/seek/next/prev commands
- **Streaming**: HLS segments generated on-demand with optimized encoding

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Install FFmpeg (required for video processing):
```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg
```

3. Run the server:
```bash
uvicorn backend.main:app --reload
```

4. Open `http://localhost:8000` in your browser

## Usage

1. Click "Open Video" and select a video file
2. Video loads with HLS streaming (first frame shown immediately)
3. Use controls or keyboard shortcuts to navigate frame by frame
4. Click timeline to seek to any position

## Technical Details

- HLS segments generated with 1-second duration using FFmpeg copy codec (fast encoding)
- WebSocket manages playback state and frame synchronization
- Strict HLS level locking prevents automatic quality switching
- Frame calculation based on video currentTime and FPS
