import uuid
import os
import shutil
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
import json
import base64
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor

from backend.decoder import (
    probe_video, decode_video, get_frame_path, get_session_info, cleanup_session, decode_frame_range,
    generate_hls_segments, get_hls_info, decode_frame_to_jpeg, decode_frames_progressive, _playback_state
)


BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "tmp" / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True, parents=True)

# Set TMPDIR to project tmp directory to avoid /tmp partition issues
PROJECT_TMP = BASE_DIR / "tmp"
PROJECT_TMP.mkdir(exist_ok=True, parents=True)
os.environ["TMPDIR"] = str(PROJECT_TMP)
os.environ["TMP"] = str(PROJECT_TMP)
os.environ["TEMP"] = str(PROJECT_TMP)

app = FastAPI(title="FAVP Server")

# Setup logging
logger = logging.getLogger(__name__)

# Thread pool executor for running blocking decode operations (optimized)
executor = ThreadPoolExecutor(max_workers=5)  # More workers for aggressive parallel buffering

# Cleanup old temp files (older than 1 hour)
def cleanup_old_sessions(max_age_seconds: int = 3600):
    """Clean up old session temp directories"""
    try:
        tmp_base = BASE_DIR / "tmp"
        if not tmp_base.exists():
            return
        
        current_time = time.time()
        cleaned = 0
        
        # Only clean up session directories, not the uploads directory or tmp itself
        sessions_dir = tmp_base / "sessions"
        if sessions_dir.exists():
            for item in sessions_dir.iterdir():
                if item.is_dir():
                    try:
                        # Check if directory is old (based on modification time)
                        mtime = item.stat().st_mtime
                        if current_time - mtime > max_age_seconds:
                            shutil.rmtree(item, ignore_errors=True)
                            cleaned += 1
                            logger.info(f"Cleaned up old session: {item.name}")
                    except Exception as e:
                        logger.warning(f"Failed to clean up {item}: {e}")
        
        # Also clean old uploaded files (only files, not the directory itself)
        if UPLOAD_DIR.exists():
            for item in UPLOAD_DIR.iterdir():
                if item.is_file():  # Only clean files, not directories
                    try:
                        mtime = item.stat().st_mtime
                        if current_time - mtime > max_age_seconds:
                            item.unlink(missing_ok=True)
                            cleaned += 1
                            logger.info(f"Cleaned up old upload: {item.name}")
                    except Exception as e:
                        logger.warning(f"Failed to clean up {item}: {e}")
        
        if cleaned > 0:
            logger.info(f"Cleaned up {cleaned} old items")
    except Exception as e:
        logger.warning(f"Error during cleanup: {e}")

def check_disk_space(path: Path) -> tuple:
    """Check available disk space. Returns (available_bytes, total_bytes) or (None, None) if unable to check"""
    try:
        statvfs = os.statvfs(path)
        available = statvfs.f_bavail * statvfs.f_frsize
        total = statvfs.f_blocks * statvfs.f_frsize
        return available, total
    except Exception:
        return None, None

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)) -> JSONResponse:
    """Upload video file and probe metadata (fast, no frame decoding)"""
    try:
        logger.info(f"Received upload request, filename: {file.filename}, content_type: {file.content_type}")
        
        # Check if file was received
        if not file:
            raise HTTPException(status_code=400, detail="No file provided")
        
        # Get filename safely and sanitize
        filename = file.filename or "video.mp4"
        if not filename:
            filename = "video.mp4"
        
        # Sanitize filename to avoid path issues
        import re
        filename = re.sub(r'[^\w\.-]', '_', filename)
        if not filename:
            filename = "video.mp4"
        
        session_id = str(uuid.uuid4())
        upload_path = UPLOAD_DIR / f"{session_id}_{filename}"
        
        # Clean up old sessions before uploading
        cleanup_old_sessions()
        
        # Ensure upload directory exists first
        try:
            UPLOAD_DIR.mkdir(exist_ok=True, parents=True)
        except OSError as e:
            logger.error(f"Failed to create upload directory: {e} (errno: {e.errno})")
            if e.errno == 28:  # No space left on device
                cleanup_old_sessions(max_age_seconds=0)  # Clean all old sessions
                try:
                    UPLOAD_DIR.mkdir(exist_ok=True, parents=True)
                except OSError as e2:
                    raise HTTPException(status_code=507, detail=f"Insufficient storage space (errno {e2.errno}). Please free up disk space.")
            else:
                raise
        
        # Check disk space before uploading
        available, total = check_disk_space(UPLOAD_DIR)
        if available is not None:
            available_mb = available / (1024 * 1024)
            logger.info(f"Disk space check before upload: {available_mb:.1f} MB available")
        
        # Stream file directly to disk instead of loading into memory
        # This avoids FastAPI using /tmp for large files
        logger.info(f"Streaming file to: {upload_path}")
        
        # Stream file directly to disk (avoids loading into memory and using /tmp)
        try:
            with open(upload_path, "wb") as f:
                file_size = 0
                while True:
                    chunk = await file.read(8192)  # Read in 8KB chunks
                    if not chunk:
                        break
                    f.write(chunk)
                    file_size += len(chunk)
            
            file_size_mb = file_size / (1024 * 1024)
            logger.info(f"Successfully saved file: {upload_path} (size: {file_size_mb:.1f} MB)")
            
            if file_size == 0:
                upload_path.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail="Empty file")
                
        except OSError as e:
            logger.error(f"Failed to write file: {e} (errno: {e.errno})")
            # Log actual error details and path
            logger.error(f"Upload path: {upload_path}, Path exists: {upload_path.parent.exists()}, Parent writable: {os.access(upload_path.parent, os.W_OK)}")
            import errno
            if e.errno == errno.ENOSPC:  # No space left on device
                cleanup_old_sessions(max_age_seconds=0)  # Clean all old sessions
                # Try again after cleanup
                try:
                    # Reset file position and try again
                    await file.seek(0)
                    with open(upload_path, "wb") as f:
                        file_size = 0
                        while True:
                            chunk = await file.read(8192)
                            if not chunk:
                                break
                            f.write(chunk)
                            file_size += len(chunk)
                    logger.info(f"Successfully saved file after cleanup: {upload_path}")
                except OSError as e2:
                    if e2.errno == errno.ENOSPC:
                        raise HTTPException(status_code=507, detail=f"Insufficient storage space (errno {e2.errno}): Please free up disk space manually.")
                    raise HTTPException(status_code=500, detail=f"Failed to write file after cleanup (errno {e2.errno}): {str(e2)}")
            else:
                raise HTTPException(status_code=500, detail=f"Failed to write file (errno {e.errno}): {str(e)}")
        
        # Probe video in thread pool (fast, just metadata)
        # This creates a temp directory which might fail if no space
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                probe_video,
                upload_path,
                session_id,
            )
        except OSError as e:
            logger.error(f"Error in probe_video (likely disk space): {e} (errno: {e.errno})")
            if e.errno == 28:  # No space left on device
                cleanup_old_sessions(max_age_seconds=0)
                # Try once more
                result = await loop.run_in_executor(
                    None,
                    probe_video,
                    upload_path,
                    session_id,
                )
            else:
                raise
        
        # Keep uploaded file for progressive decoding
        
        return JSONResponse({
            "session_id": session_id,
            "total_frames": result.get("total_frames", 0),  # May be 0 if unknown
            "fps": result["fps"],
            "width": result.get("width"),
            "height": result.get("height"),
            "duration": result.get("duration"),
        })
    except HTTPException:
        raise
    except OSError as e:
        logger.error(f"OS error during upload: {e} (errno: {e.errno})")
        if e.errno == 28:  # No space left on device
            cleanup_old_sessions(max_age_seconds=0)  # Clean all old sessions
            if 'upload_path' in locals():
                upload_path.unlink(missing_ok=True)
            if 'session_id' in locals():
                cleanup_session(session_id)
            raise HTTPException(status_code=507, detail=f"Insufficient storage space (errno {e.errno}): {str(e)}")
        # Don't assume all OSErrors are disk space - could be permission issues, etc.
        raise HTTPException(status_code=500, detail=f"Storage error (errno {e.errno}): {str(e)}")
    except Exception as e:
        logger.error(f"Upload error: {e}", exc_info=True)
        if 'upload_path' in locals():
            upload_path.unlink(missing_ok=True)
        if 'session_id' in locals():
            cleanup_session(session_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/decode-status/{session_id}")
async def decode_status(session_id: str) -> JSONResponse:
    """Check decoding status"""
    info = get_session_info(session_id)
    if not info:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse({
        "session_id": session_id,
        "total_frames": info["total_frames"],
        "fps": info["fps"],
        "width": info.get("width"),
        "height": info.get("height"),
    })


@app.get("/api/decode-frame-range/{session_id}")
async def decode_range(
    session_id: str,
    start: int = Query(..., description="Start frame index"),
    end: Optional[int] = Query(None, description="End frame index (inclusive)")
) -> JSONResponse:
    """Decode a range of frames on-demand"""
    try:
        loop = asyncio.get_event_loop()
        count = await loop.run_in_executor(
            None,
            decode_frame_range,
            session_id,
            start,
            end,
        )
        return JSONResponse({"decoded": count, "start": start, "end": end or start})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/frame/{session_id}/{frame_index}")
async def get_frame(session_id: str, frame_index: int) -> FileResponse:
    """Get a specific frame as PNG, decode on-demand if missing"""
    # Decode on-demand if frame doesn't exist
    frame_path = get_frame_path(session_id, frame_index, decode_if_missing=True)
    if not frame_path:
        raise HTTPException(status_code=404, detail="Frame not found or failed to decode")
    return FileResponse(str(frame_path), media_type="image/png")


@app.post("/api/generate-hls/{session_id}")
async def generate_hls(session_id: str, segment_duration: float = Query(1.0, description="Segment duration in seconds")) -> JSONResponse:
    """Generate HLS segments for a session"""
    try:
        # Check if session exists
        session_info = get_session_info(session_id)
        if not session_info:
            raise HTTPException(status_code=404, detail="Session not found")
        
        video_path = Path(session_info.get("video_path"))
        if not video_path or not video_path.exists():
            raise HTTPException(status_code=404, detail="Video file not found")
        
        # Generate HLS segments in thread pool (can take time)
        logger.info(f"Generating HLS segments for session {session_id}...")
        
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            generate_hls_segments,
            video_path,
            session_id,
            segment_duration,
        )
        
        logger.info(f"HLS generation complete for session {session_id}: {result['total_segments']} segments")
        
        return JSONResponse({
            "session_id": session_id,
            "total_segments": result["total_segments"],
            "segment_duration": result["segment_duration"],
            "playlist_url": f"/api/hls/{session_id}/playlist.m3u8",
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating HLS segments for session {session_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/hls/{session_id}/playlist.m3u8")
async def get_hls_playlist(session_id: str) -> FileResponse:
    """Serve HLS playlist file"""
    hls_info = get_hls_info(session_id)
    if not hls_info:
        raise HTTPException(status_code=404, detail="HLS segments not generated. Call /api/generate-hls first.")
    
    playlist_path = Path(hls_info["playlist_path"])
    if not playlist_path.exists():
        raise HTTPException(status_code=404, detail="Playlist file not found")
    
    return FileResponse(str(playlist_path), media_type="application/vnd.apple.mpegurl")


@app.get("/api/hls/{session_id}/segment_{segment_name}.ts")
async def get_hls_segment(session_id: str, segment_name: str) -> FileResponse:
    """Serve an HLS segment file"""
    hls_info = get_hls_info(session_id)
    if not hls_info:
        raise HTTPException(status_code=404, detail="HLS segments not generated")
    
    segment_dir = Path(hls_info["segment_dir"])
    # segment_name might be "000", "001", etc. or just "0", "1"
    segment_path = segment_dir / f"segment_{segment_name}.ts"
    
    if not segment_path.exists():
        # Try parsing as integer and reformatting with padding
        try:
            segment_num = int(segment_name)
            segment_path = segment_dir / f"segment_{segment_num:03d}.ts"
        except ValueError:
            pass
    
    if not segment_path.exists():
        raise HTTPException(status_code=404, detail=f"Segment {segment_name} not found")
    
    return FileResponse(str(segment_path), media_type="video/mp2t")


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str) -> JSONResponse:
    """Cleanup session and temp files"""
    cleanup_session(session_id)
    return JSONResponse({"status": "deleted"})


@app.get("/health")
def health():
    return JSONResponse({"status": "ok"})


@app.get("/favicon.ico")
def favicon():
    # Avoid noisy 404s; return an empty icon
    return Response(status_code=204)


# Serve MediaInfo assets from either vendor/mediainfo or node_modules fallback
vendor_dir = BASE_DIR / "vendor" / "mediainfo"
node_modules_dir = BASE_DIR / "node_modules" / "mediainfo.js" / "dist"
mediainfo_dir = vendor_dir if vendor_dir.exists() else node_modules_dir

app.mount(
    "/vendor/mediainfo",
    StaticFiles(directory=str(mediainfo_dir), html=False, check_dir=False),
    name="mediainfo",
)


def _find_mediainfo_file(kind: str) -> Path | None:
    # kind: 'js' or 'wasm'
    if not mediainfo_dir.exists():
        return None
    candidates_js = [
        "mediainfo.min.js", "mediainfo.js",
        "MediaInfo.min.js", "MediaInfo.js",
    ]
    candidates_wasm = [
        "mediainfo.wasm", "MediaInfo.wasm", "MediaInfoModule.wasm",
    ]
    candidates = candidates_js if kind == "js" else candidates_wasm
    # Search recursively in case dist structure varies
    for p in mediainfo_dir.rglob("*"):
        if not p.is_file():
            continue
        name = p.name
        for c in candidates:
            if name.lower() == c.lower():
                return p
    return None


@app.get("/_assets/mediainfo/auto.js")
def mediainfo_auto_js():
    p = _find_mediainfo_file("js")
    if not p:
        return JSONResponse({"error": "MediaInfo JS not found"}, status_code=404)
    return FileResponse(str(p), media_type="application/javascript")


@app.get("/_assets/mediainfo/auto.wasm")
def mediainfo_auto_wasm():
    p = _find_mediainfo_file("wasm")
    if not p:
        return JSONResponse({"error": "MediaInfo WASM not found"}, status_code=404)
    return FileResponse(str(p), media_type="application/wasm")


@app.websocket("/api/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for control commands only (HLS handles video streaming)"""
    await websocket.accept()
    logger.info(f"[WS] Client connected for session {session_id}")
    
    # Initialize playback state for this session
    if session_id not in _playback_state:
        _playback_state[session_id] = {
            "current_frame": 0,
            "is_playing": False,
        }
    
    state = _playback_state[session_id]
    session_info = get_session_info(session_id)
    
    if not session_info:
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return
    
    fps = session_info.get("fps", 30.0)
    total_frames = session_info.get("total_frames", 0)
    
    # Send initial state on connection
    await websocket.send_json({
        "type": "state",
        "current_frame": state["current_frame"],
        "is_playing": state["is_playing"],
        "total_frames": total_frames,
        "fps": fps
    })
    
    # Handle control commands in a loop
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            action = data.get("action")
            
            if action == "play":
                state["is_playing"] = True
                await websocket.send_json({
                    "type": "state",
                    "is_playing": True,
                    "current_frame": state["current_frame"]
                })
                logger.info(f"[WS] Play command received for session {session_id}")
                
            elif action == "pause":
                state["is_playing"] = False
                await websocket.send_json({
                    "type": "state",
                    "is_playing": False,
                    "current_frame": state["current_frame"]
                })
                logger.info(f"[WS] Pause command received for session {session_id}")
                
            elif action == "seek":
                target_frame = int(data.get("frame", 0))
                target_frame = max(0, min(target_frame, total_frames - 1))
                state["current_frame"] = target_frame
                state["is_playing"] = False  # Pause on seek
                
                await websocket.send_json({
                    "type": "state",
                    "current_frame": target_frame,
                    "is_playing": False
                })
                logger.info(f"[WS] Seek command received for session {session_id}: frame {target_frame}")
                
            elif action == "next_frame":
                current_frame = state["current_frame"]
                next_frame = min(current_frame + 1, total_frames - 1)
                state["current_frame"] = next_frame
                state["is_playing"] = False  # Pause on step
                
                await websocket.send_json({
                    "type": "state",
                    "current_frame": next_frame,
                    "is_playing": False
                })
                
            elif action == "prev_frame":
                current_frame = state["current_frame"]
                prev_frame = max(current_frame - 1, 0)
                state["current_frame"] = prev_frame
                state["is_playing"] = False  # Pause on step
                
                await websocket.send_json({
                    "type": "state",
                    "current_frame": prev_frame,
                    "is_playing": False
                })
                
            elif action == "update_frame":
                # Client sends frame updates during HLS playback
                frame = int(data.get("frame", state["current_frame"]))
                frame = max(0, min(frame, total_frames - 1))
                state["current_frame"] = frame
                # No response needed, just update state
                
            else:
                logger.warning(f"[WS] Unknown action: {action}")
                await websocket.send_json({
                    "type": "error",
                    "message": f"Unknown action: {action}"
                })
                    
    except WebSocketDisconnect:
        logger.info(f"[WS] Client disconnected for session {session_id}")
        state["is_playing"] = False
    except Exception as e:
        logger.error(f"[WS] Error in WebSocket handler: {e}")
        state["is_playing"] = False
        await websocket.close()


# Serve the project root (index.html and assets). html=True makes index.html default
app.mount(
    "/",
    StaticFiles(directory=str(BASE_DIR), html=True),
    name="static",
)


