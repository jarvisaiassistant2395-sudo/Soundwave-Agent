#!/usr/bin/env python3
"""
Soundwave AI — Autonomous Agent & Shorts Production Suite
Main Entry Point (CLI & GUI).
"""

import sys
import os
import argparse
import time
from pathlib import Path

# Ensure package directory is on path
current_dir = Path(__file__).parent.resolve()
sys.path.insert(0, str(current_dir))

from viral_engine import generate_viral_script, NICHES, list_niches
from short_runner import (
    ORBITAL_CHANNEL_URL,
    generate_single_short,
    generate_all_niches_batch,
    ensure_server_running,
    get_orbital_status,
    reset_orbital_history,
)
from progress_tracker import get_html_path, open_in_browser
from hud import SoundwaveHudTerminal, launch_gui_hud

def print_banner():
    banner = """
  ╔═════════════════════════════════════════════════════════════════╗
  ║   🌊  SOUNDWAVE AI — AUTONOMOUS VIRAL SHORTS AGENT v2.0         ║
  ║   Clean Room Commercial Edition · No 3D Avatar Required         ║
  ╚═════════════════════════════════════════════════════════════════╝
    """
    print(banner)

def orbital_summary(status=None) -> str:
    """e.g. 'Orbital NCG backgrounds: 37 unused / 5 used (youtube.com/@OrbitalNCG)'."""
    status = status if status is not None else get_orbital_status()
    if not status:
        return f"Orbital NCG backgrounds: server offline ({ORBITAL_CHANNEL_URL})"
    available = status.get("available")
    unused = "?" if available is None else available
    return f"Orbital NCG backgrounds: {unused} unused / {status.get('usedCount', 0)} used ({ORBITAL_CHANNEL_URL})"


def print_orbital_history(limit: int = 10) -> None:
    status = get_orbital_status()
    print(orbital_summary(status))
    if not status:
        return
    used = status.get("used") or []
    if not used:
        print("  No Orbital videos used yet — every Generate imports one it hasn't used before.")
    for entry in used[:limit]:
        print(f"  • {entry.get('title')} — {entry.get('url')} ({entry.get('usedAt', '')[:10]})")
    if len(used) > limit:
        print(f"  … and {len(used) - limit} more")


def run_interactive_cli():
    print_banner()
    server_ok = ensure_server_running()
    print(f"Status: Soundwave AI Server is {'ONLINE' if server_ok else 'OFFLINE (run: cd server && npm run dev)'}")
    print(orbital_summary() if server_ok else f"Background source: unused Orbital NCG videos ({ORBITAL_CHANNEL_URL})")

    hud = SoundwaveHudTerminal()

    while True:
        print("\nSelect an action:")
        print("  1) ⚡ Generate 1-Click Viral Short")
        print("  2) 📦 Batch Generate All 7 Niches")
        print("  3) 🎨 Launch Desktop HUD Visualizer")
        print("  4) 🌐 Open Live Progress Dashboard")
        print("  5) 🎮 Orbital NCG Background History")
        print("  6) 📜 Preview Viral Scripts")
        print("  0) Exit")

        choice = input("\nChoice [1-6, 0]: ").strip()

        if choice == "1":
            print("\nAvailable Niches:")
            n_keys = list(NICHES.keys())
            for idx, k in enumerate(n_keys, 1):
                print(f"  {idx}. {k.title()}")
            n_choice = input(f"Select niche [1-{len(n_keys)}, default 1]: ").strip()
            try:
                sel_niche = n_keys[int(n_choice) - 1]
            except:
                sel_niche = "psychology"

            voice = input("Voice [default Guy]: ").strip() or "en-US-GuyNeural"
            hud.set_state(f"PRODUCING {sel_niche.upper()}")
            print(hud.render_frame())
            generate_single_short(topic=sel_niche, voice=voice, open_browser=True)

        elif choice == "2":
            hud.set_state("BATCH PRODUCTION")
            print(hud.render_frame())
            generate_all_niches_batch()

        elif choice == "3":
            print("Launching Desktop HUD...")
            launch_gui_hud(
                on_generate_click=lambda n: generate_single_short(topic=n),
                on_batch_click=lambda: generate_all_niches_batch(),
            )

        elif choice == "4":
            hp = get_html_path()
            print(f"Opening {hp} in default browser...")
            open_in_browser(hp)

        elif choice == "5":
            print_orbital_history()
            if input("Reset the Orbital history so used videos can be picked again? [y/N]: ").strip().lower() == "y":
                status = reset_orbital_history()
                print(orbital_summary(status) if status else "Reset failed — is the server running?")

        elif choice == "6":
            for k in NICHES:
                print(f"\n--- {k.upper()} ---")
                print(generate_viral_script(k))

        elif choice in ("0", "q", "exit"):
            print("Exiting Soundwave Agent.")
            break

def main():
    parser = argparse.ArgumentParser(description="Soundwave AI Autonomous Shorts & Voice Agent")
    parser.add_argument("--gui", action="store_true", help="Launch the reactive Soundwave desktop HUD")
    parser.add_argument("--native", action="store_true", help="Launch the GPU-accelerated Ultra-HD native desktop window")
    parser.add_argument("--niche", type=str, help="Generate a short for a specific niche (psychology, facts, history, finance, ai, motivation, horror)")
    parser.add_argument("--batch", action="store_true", help="Batch generate 1 short for every niche (7 total)")
    parser.add_argument("--voice", type=str, default="en-US-GuyNeural", help="TTS Voice (default: en-US-GuyNeural)")
    parser.add_argument("--resolution", type=str, default="720p", choices=["720p", "1080p"], help="Video resolution")
    parser.add_argument("--open-progress", action="store_true", help="Open the live HTML progress monitor in the browser")
    parser.add_argument("--status", action="store_true", help="Check server health and the Orbital NCG background history")

    args = parser.parse_args()

    if args.native:
        from ui import launch_native_desktop_window
        launch_native_desktop_window()
        return

    if args.gui:
        try:
            from ui import SoundwaveDesktopApp
            desktop_app = SoundwaveDesktopApp()
            desktop_app.launch()
        except Exception as e:
            print(f"[HUD] Launching lightweight HUD fallback ({e})...")
            launch_gui_hud(
                on_generate_click=lambda n: generate_single_short(topic=n, voice=args.voice, resolution=args.resolution),
                on_batch_click=lambda: generate_all_niches_batch(voice=args.voice, resolution=args.resolution),
            )
        return

    if args.status:
        print_banner()
        online = ensure_server_running()
        print(f"Soundwave Server: {'ONLINE' if online else 'OFFLINE'}")
        if online:
            print_orbital_history()
        return

    if args.open_progress:
        open_in_browser(get_html_path())
        return

    if args.batch:
        generate_all_niches_batch(voice=args.voice, resolution=args.resolution)
        return

    if args.niche:
        generate_single_short(topic=args.niche, voice=args.voice, resolution=args.resolution, open_browser=True)
        return

    # Default to interactive CLI
    run_interactive_cli()

if __name__ == "__main__":
    main()
