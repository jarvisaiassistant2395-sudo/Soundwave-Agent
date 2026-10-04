"""
Soundwave AI — High-Fidelity Neural Speech Engine
Integrates Microsoft 24kHz Neural Edge TTS & Google Gemini Native Voice Audio.
Eliminates robotic Windows SAPI / Google Translate artifacts.
"""

import os
import sys
import json
import base64
import tempfile
import urllib.request
import subprocess
import threading
from pathlib import Path
from typing import Optional

def speak(text: str, voice: str = "en-US-GuyNeural"):
    """Synthesize and play high-definition neural speech in a background thread."""
    if not text or not text.strip():
        return

    threading.Thread(target=_speak_worker, args=(text.strip(), voice), daemon=True).start()

def _speak_worker(text: str, voice: str):
    clean_text = text.replace('"', "'").replace("\n", " ")[:350].strip()
    if not clean_text:
        return

    # Method 1: Soundwave Local Server Neural TTS (24kHz Microsoft Neural Audio)
    if _try_soundwave_server_tts(clean_text, voice):
        return

    # Method 2: Python edge-tts CLI / Library (if installed locally)
    if _try_python_edge_tts(clean_text, voice):
        return

    # Method 3: Gemini Audio Synthesis (if GEMINI_API_KEY is configured)
    if _try_gemini_voice_audio(clean_text):
        return

    # Method 4: High-quality OS voice playback fallback
    _fallback_os_tts(clean_text)

def _try_soundwave_server_tts(text: str, voice: str) -> bool:
    """Query the local Soundwave Express server running at 127.0.0.1:4000."""
    try:
        url = "http://127.0.0.1:4000/api/v1/agent/speak"
        payload = json.dumps({"text": text, "voice": voice}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success") and data.get("audioBase64"):
                raw_bytes = base64.b64decode(data["audioBase64"])
                return _play_audio_bytes(raw_bytes, ext=".mp3")
    except Exception:
        pass
    return False

def _try_python_edge_tts(text: str, voice: str) -> bool:
    """Use the Python edge-tts package directly (auto-installing if missing)."""
    try:
        import edge_tts
    except ImportError:
        try:
            # Silently auto-install edge-tts in user's Python environment
            subprocess.run([sys.executable, "-m", "pip", "install", "edge-tts", "--quiet"], capture_output=True, timeout=25)
            import edge_tts
        except Exception:
            return False

    try:
        import asyncio
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
            temp_mp3 = tf.name

        async def _synth():
            communicate = edge_tts.Communicate(text, voice or "en-US-GuyNeural")
            await communicate.save(temp_mp3)

        asyncio.run(_synth())

        if os.path.exists(temp_mp3) and os.path.getsize(temp_mp3) > 500:
            success = _play_audio_file(temp_mp3)
            try:
                os.remove(temp_mp3)
            except Exception:
                pass
            return success
    except Exception:
        pass
    return False

def _try_gemini_voice_audio(text: str) -> bool:
    """Use Gemini Flash Audio endpoint to generate raw lifelike speech."""
    try:
        from memory.config_manager import config_manager
        api_key = config_manager.get_api_key("gemini") or os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            return False

        model = "gemini-2.0-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = {
            "contents": [{"parts": [{"text": f"Read this aloud with natural human cadence, warmth, and emotion: {text}"}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": "Puck"
                        }
                    }
                }
            }
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                for p in parts:
                    inline = p.get("inlineData", {})
                    if inline.get("mimeType", "").startswith("audio") and inline.get("data"):
                        raw_bytes = base64.b64decode(inline["data"])
                        return _play_audio_bytes(raw_bytes, ext=".wav")
    except Exception:
        pass
    return False

def _play_audio_bytes(data: bytes, ext: str = ".mp3") -> bool:
    """Save bytes to a temp file and play it through OS audio player."""
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tf:
            tf.write(data)
            temp_path = tf.name
        played = _play_audio_file(temp_path)
        try:
            os.remove(temp_path)
        except Exception:
            pass
        return played
    except Exception:
        return False

def _play_audio_file(filepath: str) -> bool:
    """Play audio file across Windows, macOS, and Linux without external GUI popups."""
    norm_path = os.path.abspath(filepath)
    if not os.path.exists(norm_path) or os.path.getsize(norm_path) == 0:
        return False

    # Windows playback
    if sys.platform == "win32":
        # 1. Try Windows Media Player COM object (fast and headless)
        try:
            ps_cmd = f"""
            $w = New-Object -ComObject WMPlayer.OCX
            $w.settings.volume = 100
            $w.URL = "{norm_path}"
            $w.controls.play()
            while ($w.playState -ne 1 -and $w.playState -ne 8) {{ Start-Sleep -Milliseconds 50 }}
            """
            res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd], capture_output=True, timeout=18)
            if res.returncode == 0:
                return True
        except Exception:
            pass

        # 2. Try PresentationCore MediaPlayer
        try:
            ps_cmd2 = f"""
            Add-Type -AssemblyName presentationCore
            $m = New-Object System.Windows.Media.MediaPlayer
            $m.Open([System.Uri]"{norm_path}")
            $m.Play()
            Start-Sleep -Seconds 4
            """
            res2 = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd2], capture_output=True, timeout=10)
            if res2.returncode == 0:
                return True
        except Exception:
            pass

    # macOS playback
    if sys.platform == "darwin":
        try:
            subprocess.run(["afplay", norm_path], capture_output=True, timeout=18)
            return True
        except Exception:
            pass

    # Linux playback (ffplay / mpv / aplay / paplay)
    if sys.platform.startswith("linux"):
        for player in [
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", norm_path],
            ["mpv", "--no-video", norm_path],
            ["paplay", norm_path],
            ["aplay", norm_path]
        ]:
            try:
                res = subprocess.run(player, capture_output=True, timeout=18)
                if res.returncode == 0:
                    return True
            except Exception:
                continue

    return False

def _fallback_os_tts(clean_text: str):
    """Fallback if neural services are completely disconnected."""
    if sys.platform == "win32":
        try:
            # Modern Windows: Prefer Microsoft Mark / George / Natural voices over 1995 David
            ps_script = f"""
            Add-Type -AssemblyName System.Speech
            $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
            $v = $synth.GetInstalledVoices() | Where-Object {{
                $_.VoiceInfo.Name -match 'Mark' -or
                $_.VoiceInfo.Name -match 'George' -or
                $_.VoiceInfo.Name -match 'Natural' -or
                $_.VoiceInfo.Name -match 'OneCore' -or
                $_.VoiceInfo.Name -match 'Zira'
            }} | Select-Object -First 1
            if ($v) {{ $synth.SelectVoice($v.VoiceInfo.Name) }}
            $synth.Rate = 0
            $synth.Speak("{clean_text}")
            """
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script], capture_output=True, timeout=15)
            return
        except Exception:
            pass

    if sys.platform == "darwin":
        try:
            subprocess.run(["say", "-v", "Samantha", clean_text], timeout=15)
            return
        except Exception:
            pass

    print(f"\n[Soundwave Speaks]: {clean_text}\n")

class SpeechEngine:
    @staticmethod
    def speak(text: str, voice: str = "en-US-GuyNeural") -> bool:
        speak(text, voice)
        return True

speech_engine = SpeechEngine()
