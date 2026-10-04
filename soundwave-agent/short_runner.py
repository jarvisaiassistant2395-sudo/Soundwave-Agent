"""
Soundwave AI — Autonomous Viral Shorts Runner
Full pipeline execution: Script -> Voice -> Subtitles -> Background -> Render -> Download.

Backgrounds: for every short the server picks an Orbital NCG video
(https://www.youtube.com/@OrbitalNCG) it has never used before and imports it
through the YouTube link importer.
"""

import os
import sys
import json
import time
import socket
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List

from viral_engine import generate_viral_script, NICHES
from progress_tracker import update_state, get_html_path, open_in_browser

API_BASE = "http://127.0.0.1:4000/api/v1"
ORBITAL_CHANNEL_URL = "https://www.youtube.com/@OrbitalNCG"
# Voice + Orbital link import + render in one synchronous request.
GENERATE_TIMEOUT_S = 900

def is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    """Check if a TCP port is currently listening."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except:
        return False

def ensure_server_running() -> bool:
    """Verify that the Soundwave AI backend server is active on port 4000."""
    return is_port_open("127.0.0.1", 4000) or is_port_open("localhost", 4000)

def post_json(endpoint: str, data: Dict[str, Any], timeout: int = 120) -> Tuple[Optional[Dict[str, Any]], str]:
    """Helper to perform HTTP POST with JSON payload."""
    url = f"{API_BASE}{endpoint}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body), "OK"
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8") if e.fp else ""
        return None, f"HTTP {e.code}: {err_body or e.reason}"
    except Exception as e:
        return None, str(e)

def get_json(endpoint: str, timeout: int = 30) -> Tuple[Optional[Dict[str, Any]], str]:
    """Helper to perform HTTP GET."""
    url = f"{API_BASE}{endpoint}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body), "OK"
    except Exception as e:
        return None, str(e)

def get_orbital_status() -> Optional[Dict[str, Any]]:
    """Orbital NCG background history: channel, used/unused counts, used videos."""
    data, _ = get_json("/agent/orbital")
    return data


def reset_orbital_history() -> Optional[Dict[str, Any]]:
    """Forget which Orbital NCG videos were used, so they can be picked again."""
    data, _ = post_json("/agent/orbital/reset", {})
    return (data or {}).get("status") if data else None


def describe_background(bg: Optional[Dict[str, Any]]) -> str:
    """One-line description of the Orbital video a short was rendered over."""
    if not bg:
        return "Orbital NCG (unknown video)"
    title = bg.get("title") or "Orbital NCG video"
    url = bg.get("url") or ORBITAL_CHANNEL_URL
    return f'"{title}" — {url}'


def download_file(url_or_path: str, dest_path: Path, timeout: int = 180) -> bool:
    """Download the completed video export to the local destination path."""
    if url_or_path.startswith("/"):
        download_url = f"http://127.0.0.1:4000{url_or_path}"
    elif not url_or_path.startswith("http"):
        download_url = f"http://127.0.0.1:4000/{url_or_path.lstrip('/')}"
    else:
        download_url = url_or_path

    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(download_url, str(dest_path))
        return dest_path.exists() and dest_path.stat().st_size > 100_000
    except Exception as e:
        print(f"[ShortRunner] Download failed: {e}")
        return False

def generate_single_short(
    topic: str = "psychology",
    voice: str = "en-US-JennyNeural",
    resolution: str = "720p",
    custom_script: Optional[str] = None,
    output_dir: Optional[Path] = None,
    open_browser: bool = False,
) -> Optional[Path]:
    """Execute the full end-to-end pipeline to create a viral short."""
    html_path = update_state(1, "Checking Soundwave AI Server...", topic=topic, voice=voice)
    if open_browser:
        open_in_browser(html_path)

    # 1. Server check
    if not ensure_server_running():
        update_state(1, "ERROR: Soundwave AI server is not running on port 4000. Start the server first.")
        print("[ShortRunner] Soundwave AI server not running on port 4000. Please start with: cd server && npm run dev")
        return None

    # 2. Script generation
    update_state(2, "Generating research-backed viral script...", topic=topic, voice=voice)
    script = custom_script or generate_viral_script(topic)
    time.sleep(0.5)

    # 3. Call 1-Click Short API (voice → unused Orbital NCG video via the
    #    YouTube link importer → 9:16 render)
    update_state(
        3,
        "Synthesizing voice, importing an unused Orbital NCG background & rendering 9:16 video...",
        topic=topic, voice=voice, script=script,
    )

    payload = {
        "topic": f"{topic} {script[:80]}",
        "voice": voice,
        "resolution": resolution,
        "async": False,
    }

    # Call endpoint (primary /agent/generate-short, with fallback to /jarvis/generate-short)
    res_data, status_msg = post_json("/agent/generate-short", payload, timeout=GENERATE_TIMEOUT_S)
    if not res_data or "jobId" not in res_data:
        res_data, status_msg = post_json("/jarvis/generate-short", payload, timeout=GENERATE_TIMEOUT_S)

    if not res_data or "jobId" not in res_data:
        update_state(6, f"Generation failed: {status_msg}", topic=topic, voice=voice, script=script)
        print(f"[ShortRunner] API call failed: {status_msg}")
        return None

    job_id = res_data["jobId"]
    download_url = res_data.get("downloadUrl", f"/api/v1/export/jobs/{job_id}/download")
    background = res_data.get("background")
    print(f"[ShortRunner] Background: {describe_background(background)} (Orbital NCG, YouTube link importer)")

    # 7. Verification & Download
    update_state(7, "Verifying MP4 output and saving locally...", topic=topic, voice=voice, script=script, download_url=download_url)

    out_folder = output_dir or (Path.home() / "Downloads")
    if not out_folder.exists():
        out_folder = Path.cwd() / "exports"
    out_folder.mkdir(parents=True, exist_ok=True)

    clean_topic = "".join(c if c.isalnum() else "_" for c in topic[:20])
    dest_file = out_folder / f"soundwave_{clean_topic}_{int(time.time())}.mp4"

    ok = download_file(download_url, dest_file)
    if ok:
        update_state(8, f"Complete! Saved to {dest_file.name}", topic=topic, voice=voice, script=script, download_url=str(dest_file))
        print(f"[ShortRunner] SUCCESS: Created {dest_file} ({dest_file.stat().st_size / 1024 / 1024:.2f} MB)")
        return dest_file
    else:
        update_state(8, "Export completed on server, manual download available.", topic=topic, voice=voice, script=script, download_url=download_url)
        return None

def generate_all_niches_batch(
    voice: str = "en-US-JennyNeural",
    resolution: str = "720p",
    output_dir: Optional[Path] = None,
) -> List[Path]:
    """Generate 1 viral short for each of the 7 niches in sequence."""
    niche_keys = list(NICHES.keys())
    created = []
    print(f"\n🚀 [Soundwave Agent] Starting Batch Production for all 7 niches: {', '.join(niche_keys)}\n")

    for idx, niche in enumerate(niche_keys, start=1):
        print(f"\n--- [{idx}/{len(niche_keys)}] Producing Niche: {niche.upper()} ---")
        out_path = generate_single_short(
            topic=niche,
            voice=voice,
            resolution=resolution,
            output_dir=output_dir,
            open_browser=(idx == 1),
        )
        if out_path:
            created.append(out_path)
        time.sleep(1)

    print(f"\n🎉 [Soundwave Agent] Batch production complete! Generated {len(created)}/{len(niche_keys)} shorts.")
    return created

if __name__ == "__main__":
    print("=== Soundwave Short Runner ===")
    if not ensure_server_running():
        print("Server not running. Run: cd server && npm run dev")
    else:
        print("Server is online! Ready for generation.")
