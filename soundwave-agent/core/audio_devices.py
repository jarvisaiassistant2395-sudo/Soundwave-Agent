"""
Soundwave AI — Audio Devices Manager
Lists, filters, and resolves microphones and speakers cleanly across Windows, macOS, and Linux.
"""

import sys
from typing import List, Dict, Any, Optional

def get_audio_devices() -> Dict[str, List[Dict[str, Any]]]:
    """Return filtered, friendly lists of input (mic) and output (speaker) devices."""
    inputs = []
    outputs = []

    try:
        import sounddevice as sd
        devices = sd.query_devices()
        hostapis = sd.query_hostapis()

        for idx, d in enumerate(devices):
            name = d.get("name", f"Device {idx}")
            api_name = hostapis[d["hostapi"]]["name"] if d.get("hostapi") is not None else ""

            # Skip redundant virtual or duplicate host API clones
            if "mapper" in name.lower() or "primary" in name.lower():
                continue

            if d.get("max_input_channels", 0) > 0:
                inputs.append({
                    "id": idx,
                    "name": f"{name} ({api_name})" if api_name else name,
                    "raw_name": name,
                    "channels": d["max_input_channels"],
                    "samplerate": int(d.get("default_samplerate", 44100)),
                })

            if d.get("max_output_channels", 0) > 0:
                outputs.append({
                    "id": idx,
                    "name": f"{name} ({api_name})" if api_name else name,
                    "raw_name": name,
                    "channels": d["max_output_channels"],
                    "samplerate": int(d.get("default_samplerate", 44100)),
                })
    except Exception:
        # Fallback device mocks if sounddevice is not present
        inputs.append({"id": 0, "name": "Default System Microphone", "raw_name": "Default Microphone", "channels": 1, "samplerate": 44100})
        outputs.append({"id": 1, "name": "Default System Speakers", "raw_name": "Default Speakers", "channels": 2, "samplerate": 48000})

    return {"inputs": inputs, "outputs": outputs}

def find_device_by_name(name: str, kind: str = "input") -> Optional[int]:
    """Resolve a device index by stored device name."""
    devs = get_audio_devices()
    target_list = devs["inputs"] if kind == "input" else devs["outputs"]
    name_lower = name.lower()

    for d in target_list:
        if name_lower in d["name"].lower() or name_lower in d["raw_name"].lower():
            return d["id"]

    return target_list[0]["id"] if target_list else None

class AudioManager:
    @staticmethod
    def list_audio_devices() -> Dict[str, List[Dict[str, Any]]]:
        return get_audio_devices()

    @staticmethod
    def resolve_device(name: str, kind: str = "input") -> Optional[int]:
        return find_device_by_name(name, kind)

audio_manager = AudioManager()
