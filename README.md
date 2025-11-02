# FAVP - Frame Accurate Video Player

A frame-accurate HTML5 video player with HLS streaming support, designed for precise video frame analysis and playback.

## Features

- **Frame-accurate playback** - Navigate and play videos frame-by-frame with precision
- **HLS streaming** - Server-side video processing using FFmpeg with HLS (HTTP Live Streaming)
- **Real-time metadata** - Display file information, resolution, duration, timecode, and current frame
- **Keyboard shortcuts** - Full keyboard support for playback control
- **Seekable timeline** - Click on the timeline to jump to any position in the video
- **Modern UI** - Clean, dark-themed interface with responsive controls

## Requirements

- **Python 3.8+** with FastAPI
- **FFmpeg** - Must be installed and available in system PATH
- **Modern web browser** - Chrome, Firefox with HLS support

  **I intentionally do not care about Ap*le products like S**ari. If you like or praise such products, please leave this page immediatley.**

## Installation

1. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Install FFmpeg:**
   - Ubuntu/Debian: `sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

3. **No frontend build required** - The project uses vanilla JavaScript with ES modules

## Usage

1. **Start the backend server:**
   ```bash
   uvicorn backend.main:app --reload
   ```
   The server will run on `http://localhost:8000`

2. **Open in browser:**
   Navigate to `http://localhost:8000` in your web browser

3. **Load a video:**
   - Click "Open Video" and select a video file
   - The video will be uploaded and processed on the server
   - Wait for HLS segments to be generated

4. **Playback controls:**
   - **Play/Pause**: Space or K
   - **Previous Frame**: J or ←
   - **Next Frame**: L or →
   - **Seek**: Click on the timeline
   - **Go to Frame**: Enter frame number and click "Go"

## Architecture

- **Frontend**: Vanilla JavaScript (ES modules) with HLS.js for HLS playback
- **Backend**: FastAPI with FFmpeg for video processing and HLS segment generation
- **Storage**: Temporary files stored in `tmp/` directory (automatically cleaned up)

## Project Structure

```
FAVP/
├── backend/
│   ├── main.py          # FastAPI application
│   └── decoder.py       # FFmpeg video processing
├── src/
│   ├── player.js        # Main player logic
│   └── server-mode.js   # HLS playback implementation
├── index.html           # Main HTML page
├── styles.css           # UI styles
└── requirements.txt     # Python dependencies
```

## License

MIT

