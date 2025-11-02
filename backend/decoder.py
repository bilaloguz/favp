"""Frame decoder service - runs FFmpeg in separate process to extract frames"""
import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global cache: session_id -> decoded frames info
_frame_cache: Dict[str, dict] = {}

# Global cache: session_id -> HLS segments info
_hls_cache: Dict[str, dict] = {}


def get_ffmpeg_path() -> Optional[str]:
    """Find FFmpeg binary"""
    path = shutil.which("ffmpeg")
    if path:
        return path
    # Try common locations
    for loc in ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]:
        if Path(loc).exists():
            return loc
    return None


def get_ffprobe_path() -> Optional[str]:
    """Find FFprobe binary"""
    path = shutil.which("ffprobe")
    if path:
        return path
    # Try common locations
    for loc in ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"]:
        if Path(loc).exists():
            return loc
    return None


def probe_video(video_path: Path, session_id: str) -> dict:
    """Probe video to get metadata (fast) without decoding frames"""
    ffprobe = get_ffprobe_path()
    if not ffprobe:
        raise RuntimeError("FFprobe not found. Install FFmpeg: https://ffmpeg.org/download.html")

    # Use project tmp directory instead of system /tmp to avoid partition issues
    # video_path is in tmp/uploads, so go up to BASE_DIR/tmp/sessions
    # Calculate properly: if video_path is BASE_DIR/tmp/uploads/file.mp4
    # Then we want BASE_DIR/tmp/sessions/favp_session_id
    video_parent = video_path.parent  # tmp/uploads
    tmp_base = video_parent.parent if video_parent.name == "uploads" else video_path.parent.parent  # tmp
    sessions_dir = tmp_base / "sessions"
    
    try:
        sessions_dir.mkdir(exist_ok=True, parents=True)
    except OSError as e:
        if e.errno == 28:  # No space left on device
            logger.error(f"[Decoder] Failed to create sessions directory: {e}")
            raise RuntimeError(f"Insufficient storage space for temp directory: {e}")
        raise
    
    temp_dir = sessions_dir / f"favp_{session_id}"
    try:
        temp_dir.mkdir(exist_ok=True)
    except OSError as e:
        if e.errno == 28:  # No space left on device
            logger.error(f"[Decoder] Failed to create temp directory: {e}")
            raise RuntimeError(f"Insufficient storage space for temp directory: {e}")
        raise
    
    logger.info(f"[Decoder] Session {session_id}: Creating temp dir {temp_dir}")

    try:
        # Probe video to get dimensions and duration using ffprobe
        probe_cmd = [
            ffprobe,
            "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-show_entries", "format=duration,nb_frames",
            "-of", "json",
            str(video_path),
        ]
        result = subprocess.run(probe_cmd, capture_output=True, text=True, check=True)
        probe_data = json.loads(result.stdout)
        
        width = height = duration = None
        probe_fps = None
        nb_frames = None
        
        if "streams" in probe_data and len(probe_data["streams"]) > 0:
            stream = probe_data["streams"][0]
            width = stream.get("width")
            height = stream.get("height")
            rfps = stream.get("r_frame_rate")
            if rfps and "/" in str(rfps):
                num, den = map(float, rfps.split("/"))
                if den > 0:
                    probe_fps = num / den
            nb_frames = stream.get("nb_frames")
        
        if "format" in probe_data:
            dur_str = probe_data["format"].get("duration")
            if dur_str:
                duration = float(dur_str)
        
        # Estimate total frames from duration and FPS if nb_frames not available
        total_frames = nb_frames
        if not total_frames and duration and probe_fps:
            total_frames = int(duration * probe_fps)
        elif not total_frames:
            total_frames = 0  # Will decode on-demand to count

        result = {
            "total_frames": total_frames,
            "temp_dir": str(temp_dir),
            "video_path": str(video_path),
            "fps": probe_fps or 30.0,
            "width": width,
            "height": height,
            "duration": duration,
        }
        
        _frame_cache[session_id] = result
        logger.info(f"[Decoder] Session {session_id}: Probed - {width}x{height}, {probe_fps} fps, ~{total_frames} frames")
        return result

    except subprocess.CalledProcessError as e:
        err_msg = e.stderr
        if err_msg and isinstance(err_msg, bytes):
            err_msg = err_msg.decode('utf-8', errors='replace')
        elif not err_msg:
            err_msg = str(e)
        logger.error(f"[Decoder] FFprobe error: {err_msg}")
        raise RuntimeError(f"FFprobe failed: {err_msg}")


def decode_video(video_path: Path, session_id: str, fps: Optional[float] = None) -> dict:
    """
    Decode video into individual frames.
    Returns: {total_frames, frame_paths, fps, width, height}
    """
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html")

    ffprobe = get_ffprobe_path()
    if not ffprobe:
        raise RuntimeError("FFprobe not found. Install FFmpeg: https://ffmpeg.org/download.html")

    # Use project tmp directory instead of system /tmp
    video_parent = video_path.parent  # tmp/uploads
    tmp_base = video_parent.parent if video_parent.name == "uploads" else video_path.parent.parent  # tmp
    sessions_dir = tmp_base / "sessions"
    sessions_dir.mkdir(exist_ok=True, parents=True)
    
    temp_dir = sessions_dir / f"favp_{session_id}"
    temp_dir.mkdir(exist_ok=True)
    logger.info(f"[Decoder] Session {session_id}: Creating temp dir {temp_dir}")

    try:
        # Probe video to get dimensions and duration using ffprobe
        probe_cmd = [
            ffprobe,
            "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-show_entries", "format=duration",
            "-of", "json",
            str(video_path),
        ]
        result = subprocess.run(probe_cmd, capture_output=True, text=True, check=True)
        probe_data = json.loads(result.stdout)
        
        width = height = duration = None
        probe_fps = fps
        
        if "streams" in probe_data and len(probe_data["streams"]) > 0:
            stream = probe_data["streams"][0]
            width = stream.get("width")
            height = stream.get("height")
            rfps = stream.get("r_frame_rate")
            if rfps and "/" in str(rfps):
                num, den = map(float, rfps.split("/"))
                if den > 0:
                    probe_fps = num / den
        
        if "format" in probe_data:
            dur_str = probe_data["format"].get("duration")
            if dur_str:
                duration = float(dur_str)

        # Extract frames
        frame_pattern = str(temp_dir / "frame_%08d.png")
        extract_cmd = [
            ffmpeg,
            "-i", str(video_path),
            "-vsync", "0",  # Extract all frames
            "-y",  # Overwrite
            frame_pattern,
        ]
        logger.info(f"[Decoder] Session {session_id}: Extracting frames...")
        subprocess.run(extract_cmd, capture_output=True, check=True, timeout=300)

        # Count extracted frames
        frame_files = sorted(temp_dir.glob("frame_*.png"))
        total_frames = len(frame_files)
        
        if total_frames == 0:
            raise RuntimeError("No frames extracted")

        logger.info(f"[Decoder] Session {session_id}: Extracted {total_frames} frames")

        result = {
            "total_frames": total_frames,
            "temp_dir": str(temp_dir),
            "fps": probe_fps or fps or 30.0,
            "width": width,
            "height": height,
            "duration": duration,
        }
        
        _frame_cache[session_id] = result
        return result

    except subprocess.CalledProcessError as e:
        err_msg = e.stderr
        if err_msg and isinstance(err_msg, bytes):
            err_msg = err_msg.decode('utf-8', errors='replace')
        elif not err_msg:
            err_msg = str(e)
        logger.error(f"[Decoder] FFmpeg error: {err_msg}")
        raise RuntimeError(f"FFmpeg failed: {err_msg}")


def decode_frame_range(session_id: str, start_frame: int, end_frame: Optional[int] = None) -> int:
    """Decode a range of frames on-demand in batches. Returns number of frames decoded."""
    if session_id not in _frame_cache:
        raise RuntimeError("Session not found")
    
    cache = _frame_cache[session_id]
    video_path = Path(cache.get("video_path"))
    temp_dir = Path(cache["temp_dir"])
    
    if not video_path or not video_path.exists():
        raise RuntimeError("Video file not found")
    
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFmpeg not found")
    
    if end_frame is None:
        end_frame = start_frame
    
    # Check which frames are missing
    missing_frames = []
    for idx in range(start_frame, end_frame + 1):
        frame_path = temp_dir / f"frame_{idx + 1:08d}.png"
        if not frame_path.exists():
            missing_frames.append(idx)
    
    if not missing_frames:
        logger.debug(f"[Decoder] All frames {start_frame}-{end_frame} already decoded")
        return end_frame - start_frame + 1
    
    # Decode in batches for efficiency using sequential frame extraction
    # FFmpeg can extract a contiguous range efficiently
    batch_size = 75  # Decode up to 75 frames at a time per FFmpeg call
    total_decoded = 0
    
    # Group missing frames into contiguous ranges
    if not missing_frames:
        return 0
    
    ranges = []
    current_range_start = missing_frames[0]
    current_range_end = missing_frames[0]
    
    for i in range(1, len(missing_frames)):
        if missing_frames[i] == current_range_end + 1:
            current_range_end = missing_frames[i]
        else:
            ranges.append((current_range_start, current_range_end))
            current_range_start = missing_frames[i]
            current_range_end = missing_frames[i]
    ranges.append((current_range_start, current_range_end))
    
    # Decode each contiguous range
    for range_start, range_end in ranges:
        # Process large ranges in batches
        for batch_start in range(range_start, range_end + 1, batch_size):
            batch_end = min(batch_start + batch_size - 1, range_end)
            
            # Extract contiguous range using select='between(n,start,end)'
            select_filter = f"select='between(n\\,{batch_start}\\,{batch_end})'"
            temp_pattern = str(temp_dir / f"batch_{batch_start}_{batch_end}_%08d.png")
            
            extract_cmd = [
                ffmpeg,
                "-i", str(video_path),
                "-vf", select_filter,
                "-vsync", "0",
                "-y",
                temp_pattern,
            ]
            
            try:
                logger.debug(f"[Decoder] Decoding batch: frames {batch_start}-{batch_end}")
                subprocess.run(extract_cmd, capture_output=True, text=True, check=True, timeout=120)
                
                # Rename extracted frames to correct sequential names
                extracted = sorted(temp_dir.glob(f"batch_{batch_start}_{batch_end}_*.png"))
                for i, src_path in enumerate(extracted):
                    target_idx = batch_start + i
                    if target_idx > batch_end:
                        break
                    target_path = temp_dir / f"frame_{target_idx + 1:08d}.png"
                    src_path.rename(target_path)
                    total_decoded += 1
                
                # Clean up any remaining batch files
                for leftover in temp_dir.glob(f"batch_{batch_start}_{batch_end}_*.png"):
                    leftover.unlink(missing_ok=True)
                    
            except subprocess.CalledProcessError as e:
                err_msg = e.stderr if isinstance(e.stderr, str) else (e.stderr.decode('utf-8', errors='replace') if isinstance(e.stderr, bytes) else str(e))
                logger.warning(f"[Decoder] Batch decode failed for {batch_start}-{batch_end}, trying individual frames")
                # Fallback: decode frames one by one for this batch
                for idx in range(batch_start, batch_end + 1):
                    frame_path = temp_dir / f"frame_{idx + 1:08d}.png"
                    if frame_path.exists():
                        total_decoded += 1
                        continue
                        
                    extract_cmd_single = [
                        ffmpeg,
                        "-i", str(video_path),
                        "-vf", f"select=eq(n\\,{idx})",
                        "-frames:v", "1",
                        "-y",
                        str(frame_path),
                    ]
                    try:
                        subprocess.run(extract_cmd_single, capture_output=True, check=True, timeout=15)
                        if frame_path.exists():
                            total_decoded += 1
                    except subprocess.CalledProcessError:
                        logger.warning(f"[Decoder] Failed to decode frame {idx}")
                        # Continue with next frame instead of breaking
    
    logger.info(f"[Decoder] Decoded {total_decoded} frames ({start_frame}-{end_frame}) for session {session_id}")
    return total_decoded


def get_frame_path(session_id: str, frame_index: int, decode_if_missing: bool = True) -> Optional[Path]:
    """Get path to a specific frame file, decode on-demand if missing"""
    if session_id not in _frame_cache:
        return None
    cache = _frame_cache[session_id]
    temp_dir = Path(cache["temp_dir"])
    # Frames are 1-indexed: frame_00000001.png, frame_00000002.png, ...
    frame_num = frame_index + 1
    frame_path = temp_dir / f"frame_{frame_num:08d}.png"
    
    if frame_path.exists():
        return frame_path
    
    # Decode on-demand if enabled
    if decode_if_missing:
        try:
            decode_frame_range(session_id, frame_index, frame_index)
            if frame_path.exists():
                return frame_path
        except Exception as e:
            logger.warning(f"[Decoder] Failed to decode frame {frame_index} on-demand: {e}")
    
    return None


def get_session_info(session_id: str) -> Optional[dict]:
    """Get cached session info"""
    return _frame_cache.get(session_id)


def generate_hls_segments(video_path: Path, session_id: str, segment_duration: float = 1.0) -> dict:
    """Generate HLS segments from video file. Returns info about segments."""
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html")
    
    # Use existing temp_dir from probe_video if available
    if session_id not in _frame_cache:
        raise RuntimeError("Session not found - probe video first")
    
    cache = _frame_cache[session_id]
    temp_dir = Path(cache["temp_dir"])
    hls_dir = temp_dir / "hls"
    hls_dir.mkdir(exist_ok=True)
    
    playlist_path = hls_dir / "playlist.m3u8"
    
    # Generate HLS segments with 1-second duration
    # Use -hls_segment_filename to control segment naming
    hls_cmd = [
        ffmpeg,
        "-i", str(video_path),
        "-c:v", "libx264",  # H.264 encoding
        "-c:a", "aac",      # AAC audio (if present)
        "-preset", "fast",  # Faster encoding
        "-crf", "23",       # Good quality
        "-hls_time", str(segment_duration),
        "-hls_list_size", "0",  # Include all segments in playlist
        "-hls_segment_type", "mpegts",  # Use MPEG-TS format
        "-hls_segment_filename", str(hls_dir / "segment_%03d.ts"),
        "-start_number", "0",
        "-f", "hls",
        "-y",  # Overwrite
        str(playlist_path),
    ]
    
    try:
        logger.info(f"[Decoder] Session {session_id}: Generating HLS segments (duration={segment_duration}s)...")
        result = subprocess.run(hls_cmd, capture_output=True, text=True, check=True, timeout=600)
        
        # Count generated segments
        segment_files = sorted(hls_dir.glob("segment_*.ts"))
        total_segments = len(segment_files)
        
        logger.info(f"[Decoder] Session {session_id}: Generated {total_segments} HLS segments")
        
        # Post-process playlist to fix segment URLs to use API endpoints
        if playlist_path.exists():
            playlist_content = playlist_path.read_text()
            # Replace relative segment paths with API endpoints
            # Matches segment_000.ts, segment_001.ts, etc.
            import re
            playlist_content = re.sub(
                r'^segment_([0-9]+)\.ts$',
                rf'/api/hls/{session_id}/segment_\1.ts',
                playlist_content,
                flags=re.MULTILINE
            )
            playlist_path.write_text(playlist_content)
        
        hls_info = {
            "playlist_path": str(playlist_path),
            "segment_dir": str(hls_dir),
            "total_segments": total_segments,
            "segment_duration": segment_duration,
        }
        
        _hls_cache[session_id] = hls_info
        return hls_info
        
    except subprocess.CalledProcessError as e:
        err_msg = e.stderr if isinstance(e.stderr, str) else (e.stderr.decode('utf-8', errors='replace') if isinstance(e.stderr, bytes) else str(e))
        logger.error(f"[Decoder] HLS generation error: {err_msg}")
        raise RuntimeError(f"HLS generation failed: {err_msg}")


def get_hls_info(session_id: str) -> Optional[dict]:
    """Get HLS segments info for a session"""
    return _hls_cache.get(session_id)


def cleanup_session(session_id: str) -> None:
    """Cleanup temp files for a session"""
    if session_id not in _frame_cache:
        return
    cache = _frame_cache[session_id]
    temp_dir = Path(cache.get("temp_dir"))
    if temp_dir and temp_dir.exists():
        import shutil
        try:
            shutil.rmtree(temp_dir)
            logger.info(f"[Decoder] Cleaned up {temp_dir}")
        except Exception as e:
            logger.warning(f"[Decoder] Cleanup warning: {e}")
    _frame_cache.pop(session_id, None)
    _hls_cache.pop(session_id, None)

