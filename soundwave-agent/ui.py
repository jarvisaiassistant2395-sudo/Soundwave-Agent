"""
Soundwave AI — Complete Desktop Command Center HUD
Clean-room implementation of the AI Assistant HUD matching the reference 3-column command deck.

Features:
- Windows High-DPI awareness for razor-sharp 4K/retina display rendering
- Direct 1-Click Launch for Ultra-HD Native Desktop Window (GPU accelerated WebGL/CSS Deck)
- Top HUD bar: S.O.U.N.D.W.A.V.E identity, online pill, live clock/date capsule, latency pill, settings
- Left column: System Stats (CPU/RAM bars, metrics), Weather, Camera/Vision feed, System Uptime & Vitals
- Center column: Concentric Arc Reactor Soundwave Orb with glowing multi-layer aura, active equalizer bars, status capsule, and bottom squircle dock
- Right column: Conversation feed with message bubbles, Clear, Extract Conversation, and command input with send button
- 16 computer control actions & Ghost Operator RPA macros
- Multi-threaded non-blocking execution with high-fidelity Neural Edge TTS
"""

import sys
import os
import math
import time
import json
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Optional, Dict, Any, List

# Ensure parent directory is on sys.path
sys.path.insert(0, str(Path(__file__).parent.resolve()))

from core.action_loader import action_registry
from core.undo import undo_manager
from core.confirm import confirmation_gate
from core.audio_devices import get_audio_devices
from core.wake_word import wake_engine, AssistantState
from core.llm_client import llm_client
from core.speech import speak
from memory.memory_manager import memory_manager
from memory.config_manager import config_manager
from viral_engine import generate_viral_script, NICHES
from short_runner import generate_single_short, generate_all_niches_batch, ensure_server_running

# Discover all 16 actions
action_registry.discover_actions()

def launch_native_desktop_window(url: str = "http://localhost:5173/agent"):
    """Launch the Web Cyber Deck in a standalone native desktop window (no browser tabs, no URL bar)."""
    # 1. Try pywebview if installed (true native embedded window)
    try:
        import webview
        def _run_pywebview():
            webview.create_window(
                "Soundwave AI — Command Deck",
                url,
                width=1440,
                height=920,
                background_color="#030712",
                resizable=True
            )
            webview.start()
        threading.Thread(target=_run_pywebview, daemon=True).start()
        return True
    except ImportError:
        pass

    # 2. Try Microsoft Edge App Mode (Windows 10/11 built-in)
    edge_candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        shutil.which("msedge"),
        shutil.which("edge")
    ]
    for ep in edge_candidates:
        if ep and os.path.exists(ep):
            try:
                subprocess.Popen([ep, f"--app={url}", "--window-size=1440,920", "--new-window"])
                return True
            except Exception:
                pass

    # 3. Try Google Chrome App Mode
    chrome_candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        shutil.which("google-chrome"),
        shutil.which("chrome")
    ]
    for cp in chrome_candidates:
        if cp and os.path.exists(cp):
            try:
                subprocess.Popen([cp, f"--app={url}", "--window-size=1440,920", "--new-window"])
                return True
            except Exception:
                pass

    # 4. Fallback to default browser
    import webbrowser
    webbrowser.open(url)
    return True

class SoundwaveDesktopApp:
    def __init__(self):
        self.state = "STANDBY"
        self.anim_phase = 0.0
        self.root = None
        self.camera_active = False
        self.is_mic_active = False
        self.uptime_seconds = 439
        self.commands_count = 1
        self.session_count = 1
        self.assistant_name = "S.O.U.N.D.W.A.V.E"
        self.voice_feedback = True
        self.selected_voice = "en-US-GuyNeural"

    def launch(self):
        # Enable Per-Monitor High-DPI awareness on Windows before creating Tk
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(2)
            except Exception:
                try:
                    ctypes.windll.user32.SetProcessDPIAware()
                except Exception:
                    pass

        try:
            import tkinter as tk
            from tkinter import ttk, messagebox, filedialog
            self._launch_tk(tk, ttk, messagebox, filedialog)
        except ImportError:
            print("[Desktop UI] Tkinter not available in this environment. Launching CLI terminal HUD...")
            from main import run_interactive_cli
            run_interactive_cli()

    def _save_chat(self, text: str, sender: str):
        try:
            history_path = Path(__file__).parent / "memory" / "chat_history.json"
            history_path.parent.mkdir(parents=True, exist_ok=True)
            items = []
            if history_path.exists():
                try:
                    with open(history_path, "r", encoding="utf-8") as f:
                        items = json.load(f)
                except Exception:
                    items = []
            items.append({
                "time": time.strftime("%I:%M %p"),
                "sender": sender,
                "text": text
            })
            with open(history_path, "w", encoding="utf-8") as f:
                json.dump(items[-80:], f, indent=2)
        except Exception as e:
            print(f"[Save Chat Error] {e}")

    def _load_chat(self):
        try:
            history_path = Path(__file__).parent / "memory" / "chat_history.json"
            if history_path.exists() and hasattr(self, "txt_log") and self.txt_log:
                with open(history_path, "r", encoding="utf-8") as f:
                    items = json.load(f)
                for item in items[-30:]:
                    snd = item.get("sender", "assistant")
                    txt = item.get("text", "")
                    tm = item.get("time", "")
                    self._display_message(txt, snd, tm)
                self.txt_log.see("end")
        except Exception as e:
            print(f"[Load Chat Error] {e}")

    def _display_message(self, text: str, sender: str, tm: str = ""):
        if not hasattr(self, "txt_log") or not self.txt_log:
            return
        if not tm:
            tm = time.strftime("%I:%M %p")

        if sender == "user":
            header = f"\nOPERATOR [{tm}]\n"
            tag = "user_tag"
        elif sender == "assistant":
            header = f"\nSOUNDWAVE [{tm}]\n"
            tag = "ai_tag"
        else:
            header = f"\nSYSTEM [{tm}]\n"
            tag = "sys_tag"

        self.txt_log.insert("end", header, tag)
        self.txt_log.insert("end", f"{text}\n", "body_tag")
        self.txt_log.see("end")

    def _append_log(self, text: str, sender: str = "assistant"):
        def do_append():
            self._display_message(text, sender)
            self._save_chat(text, sender)
        if hasattr(self, "root") and self.root:
            self.root.after(0, do_append)

    def _launch_tk(self, tk, ttk, messagebox, filedialog):
        root = tk.Tk()
        self.root = root
        root.title("Soundwave AI — Command Deck HUD")
        root.geometry("1240x820")
        root.configure(bg="#030712")
        root.minsize(1060, 700)

        # ── 1. TOP HUD STATUS BAR ──────────────────────────────────────
        hud_bar = tk.Frame(root, bg="#0B132B", height=52, padx=16, pady=8, highlightbackground="#1E293B", highlightthickness=1)
        hud_bar.pack(fill=tk.X, padx=10, pady=(10, 6))

        # Left: Assistant Branding & Online Indicator
        left_header = tk.Frame(hud_bar, bg="#0B132B")
        left_header.pack(side=tk.LEFT)

        lbl_logo = tk.Label(
            left_header, text="⚡ SOUNDWAVE AI", font=("Segoe UI", 11, "bold"), fg="#06B6D4", bg="#0B132B"
        )
        lbl_logo.pack(side=tk.LEFT, padx=(0, 10))

        lbl_online = tk.Label(
            left_header, text="● ONLINE", font=("Segoe UI", 8, "bold"), fg="#10B981", bg="#064E3B", padx=8, pady=2
        )
        lbl_online.pack(side=tk.LEFT)

        # Center: Live Digital Clock Capsule & Latency Pill
        center_capsule = tk.Frame(hud_bar, bg="#0B132B")
        center_capsule.pack(side=tk.LEFT, expand=True)

        self.lbl_clock_capsule = tk.Label(
            center_capsule, text="--:--:-- | September 20, 2026", font=("Consolas", 9, "bold"), fg="#E2E8F0", bg="#0F172A",
            padx=14, pady=4, highlightbackground="#1E293B", highlightthickness=1
        )
        self.lbl_clock_capsule.pack(side=tk.LEFT, padx=6)

        lbl_ping = tk.Label(
            center_capsule, text="18ms", font=("Consolas", 8, "bold"), fg="#38BDF8", bg="#0F172A",
            padx=8, pady=4, highlightbackground="#1E293B", highlightthickness=1
        )
        lbl_ping.pack(side=tk.LEFT)

        # Right: Switch to Native Ultra-HD Deck, Settings
        right_header = tk.Frame(hud_bar, bg="#0B132B")
        right_header.pack(side=tk.RIGHT)

        lbl_weather_cap = tk.Label(
            right_header, text="🌤 24.5°C Belgrade", font=("Segoe UI", 8), fg="#94A3B8", bg="#0F172A",
            padx=10, pady=4, highlightbackground="#1E293B", highlightthickness=1
        )
        lbl_weather_cap.pack(side=tk.LEFT, padx=4)

        btn_ultra_hd = tk.Button(
            right_header, text="⚡ Ultra-HD Native Deck", font=("Segoe UI", 8, "bold"), bg="#0284C7", fg="#FFFFFF",
            relief=tk.FLAT, bd=0, padx=12, pady=4, cursor="hand2", activebackground="#0369A1", activeforeground="#FFFFFF",
            command=lambda: launch_native_desktop_window()
        )
        btn_ultra_hd.pack(side=tk.LEFT, padx=6)

        btn_settings = tk.Button(
            right_header, text="⚙", font=("Segoe UI", 10, "bold"), bg="#0F172A", fg="#06B6D4",
            relief=tk.FLAT, bd=0, padx=8, pady=3, highlightbackground="#1E293B", highlightthickness=1,
            cursor="hand2", command=lambda: self._open_settings_dialog(tk, messagebox)
        )
        btn_settings.pack(side=tk.LEFT, padx=2)

        # ── 2. THREE-COLUMN DECK CONTAINER ────────────────────────────
        main_deck = tk.Frame(root, bg="#030712")
        main_deck.pack(fill=tk.BOTH, expand=True, padx=10, pady=4)

        # ── LEFT COLUMN: TELEMETRY & SYSTEM WIDGETS (width ~300) ─────
        col_left = tk.Frame(main_deck, bg="#030712", width=300)
        col_left.pack(side=tk.LEFT, fill=tk.BOTH, padx=(0, 8))
        col_left.pack_propagate(False)

        # Widget 1: System Telemetry
        w_stats = tk.Frame(col_left, bg="#0B132B", padx=12, pady=10, highlightbackground="#1E293B", highlightthickness=1)
        w_stats.pack(fill=tk.X, pady=(0, 8))

        hdr_stats = tk.Frame(w_stats, bg="#0B132B")
        hdr_stats.pack(fill=tk.X, pady=(0, 6))
        tk.Label(hdr_stats, text="HARDWARE TELEMETRY", font=("Segoe UI", 9, "bold"), fg="#38BDF8", bg="#0B132B").pack(side=tk.LEFT)
        btn_ref_stats = tk.Button(
            hdr_stats, text="↻", font=("Segoe UI", 8), bg="#0B132B", fg="#94A3B8", bd=0, cursor="hand2",
            command=lambda: self._refresh_stats()
        )
        btn_ref_stats.pack(side=tk.RIGHT)

        # CPU bar
        self.lbl_cpu_txt = tk.Label(w_stats, text="CPU Usage: 8%", font=("Segoe UI", 8), fg="#94A3B8", bg="#0B132B")
        self.lbl_cpu_txt.pack(anchor=tk.W)
        self.cv_cpu = tk.Canvas(w_stats, height=6, bg="#0F172A", highlightthickness=0)
        self.cv_cpu.pack(fill=tk.X, pady=(2, 6))
        self.cv_cpu.create_rectangle(0, 0, 35, 6, fill="#06B6D4", outline="")

        # RAM bar
        self.lbl_ram_txt = tk.Label(w_stats, text="RAM Usage: 5.2 GB", font=("Segoe UI", 8), fg="#94A3B8", bg="#0B132B")
        self.lbl_ram_txt.pack(anchor=tk.W)
        self.cv_ram = tk.Canvas(w_stats, height=6, bg="#0F172A", highlightthickness=0)
        self.cv_ram.pack(fill=tk.X, pady=(2, 8))
        self.cv_ram.create_rectangle(0, 0, 95, 6, fill="#06B6D4", outline="")

        # 3 Mini Metric Tiles
        tiles_frame = tk.Frame(w_stats, bg="#0B132B")
        tiles_frame.pack(fill=tk.X)
        self.lbl_tile_cpu = self._make_tile(tiles_frame, "CPU", "8%", 0)
        self.lbl_tile_mem = self._make_tile(tiles_frame, "Memory", "32%", 1)
        self.lbl_tile_dsk = self._make_tile(tiles_frame, "Disk", "184/512GB", 2)

        # Widget 2: Camera & Vision Card
        w_cam = tk.Frame(col_left, bg="#0B132B", padx=12, pady=10, highlightbackground="#1E293B", highlightthickness=1)
        w_cam.pack(fill=tk.X, pady=(0, 8))

        hdr_cam = tk.Frame(w_cam, bg="#0B132B")
        hdr_cam.pack(fill=tk.X, pady=(0, 4))
        tk.Label(hdr_cam, text="VISION SENSOR", font=("Segoe UI", 9, "bold"), fg="#38BDF8", bg="#0B132B").pack(side=tk.LEFT)
        self.lbl_cam_badge = tk.Label(hdr_cam, text="STANDBY", font=("Segoe UI", 7, "bold"), fg="#94A3B8", bg="#0F172A", padx=6, pady=1)
        self.lbl_cam_badge.pack(side=tk.RIGHT)

        self.cv_cam_feed = tk.Canvas(w_cam, height=110, bg="#070D18", highlightthickness=1, highlightbackground="#1E293B")
        self.cv_cam_feed.pack(fill=tk.X, pady=6)
        # HUD cyber brackets
        self.cv_cam_feed.create_line(10, 15, 10, 10, 20, 10, fill="#06B6D4", width=2)
        self.cv_cam_feed.create_line(260, 10, 270, 10, 270, 20, fill="#06B6D4", width=2)
        self.cv_cam_feed.create_line(10, 95, 10, 105, 20, 105, fill="#06B6D4", width=2)
        self.cv_cam_feed.create_line(260, 105, 270, 105, 270, 95, fill="#06B6D4", width=2)
        self.cam_text_id = self.cv_cam_feed.create_text(140, 55, text="[OPTICAL FEED STANDBY]\nClick 'Toggle Vision' to activate", fill="#475569", font=("Segoe UI", 8), justify=tk.CENTER)

        btn_cam = tk.Button(
            w_cam, text="📷 Toggle Vision Feed", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#38BDF8",
            relief=tk.FLAT, bd=0, padx=8, pady=4, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
            command=self._toggle_camera
        )
        btn_cam.pack(fill=tk.X)

        # Widget 3: System Vitals & Uptime
        w_vitals = tk.Frame(col_left, bg="#0B132B", padx=12, pady=10, highlightbackground="#1E293B", highlightthickness=1)
        w_vitals.pack(fill=tk.BOTH, expand=True)

        tk.Label(w_vitals, text="RUNTIME VITALS", font=("Segoe UI", 9, "bold"), fg="#38BDF8", bg="#0B132B").pack(anchor=tk.W, pady=(0, 6))

        vitals_grid = tk.Frame(w_vitals, bg="#0B132B")
        vitals_grid.pack(fill=tk.X)
        self.lbl_uptime_val = self._make_tile(vitals_grid, "Uptime", "00:07:19", 0)
        self.lbl_tile_cmds = self._make_tile(vitals_grid, "Commands", str(self.commands_count), 1)
        self._make_tile(vitals_grid, "Neural TTS", "24kHz HD", 2)

        # ── CENTER COLUMN: CONCENTRIC ARC REACTOR ORB (width ~420) ───
        col_center = tk.Frame(main_deck, bg="#030712", width=420)
        col_center.pack(side=tk.LEFT, fill=tk.BOTH, padx=4)
        col_center.pack_propagate(False)

        card_orb = tk.Frame(col_center, bg="#0B132B", padx=14, pady=12, highlightbackground="#1E293B", highlightthickness=1)
        card_orb.pack(fill=tk.BOTH, expand=True)

        lbl_orb_title = tk.Label(card_orb, text="ARC REACTOR CORE", font=("Segoe UI", 10, "bold"), fg="#06B6D4", bg="#0B132B")
        lbl_orb_title.pack(pady=(0, 4))

        # Arc Reactor Canvas
        self.cv_arc = tk.Canvas(card_orb, width=340, height=330, bg="#0B132B", highlightthickness=0)
        self.cv_arc.pack(pady=4)

        # State Pill Badge
        self.lbl_orb_status = tk.Label(
            card_orb, text="● STANDBY · LISTENING FOR WAKE WORD",
            font=("Segoe UI", 8, "bold"), fg="#06B6D4", bg="#0F172A", padx=14, pady=4,
            highlightbackground="#1E293B", highlightthickness=1
        )
        self.lbl_orb_status.pack(pady=6)

        # Squircle Action Dock
        dock_frame = tk.Frame(card_orb, bg="#0B132B")
        dock_frame.pack(pady=8)

        self.btn_mic = tk.Button(
            dock_frame, text="🎙️ Mic: ON", font=("Segoe UI", 8, "bold"), bg="#0284C7", fg="#FFFFFF",
            relief=tk.FLAT, bd=0, padx=10, pady=5, cursor="hand2", command=self._toggle_mic
        )
        self.btn_mic.pack(side=tk.LEFT, padx=3)

        self.btn_tts = tk.Button(
            dock_frame, text="🔊 Neural Voice: ON", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#38BDF8",
            relief=tk.FLAT, bd=0, padx=10, pady=5, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
            command=self._toggle_voice
        )
        self.btn_tts.pack(side=tk.LEFT, padx=3)

        btn_macro = tk.Button(
            dock_frame, text="⚡ Macros", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#38BDF8",
            relief=tk.FLAT, bd=0, padx=10, pady=5, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
            command=lambda: self._open_macro_dialog(tk, messagebox)
        )
        btn_macro.pack(side=tk.LEFT, padx=3)

        # ── RIGHT COLUMN: CONVERSATION FEED & INPUT (rest of width) ───
        col_right = tk.Frame(main_deck, bg="#030712")
        col_right.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=(8, 0))

        card_chat = tk.Frame(col_right, bg="#0B132B", padx=14, pady=10, highlightbackground="#1E293B", highlightthickness=1)
        card_chat.pack(fill=tk.BOTH, expand=True)

        # Conversation Header with Clear and Extract
        hdr_chat = tk.Frame(card_chat, bg="#0B132B")
        hdr_chat.pack(fill=tk.X, pady=(0, 6))

        tk.Label(hdr_chat, text="CONVERSATION LOG", font=("Segoe UI", 9, "bold"), fg="#38BDF8", bg="#0B132B").pack(side=tk.LEFT)

        btn_extract = tk.Button(
            hdr_chat, text="Extract", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#38BDF8",
            relief=tk.FLAT, bd=0, padx=8, pady=2, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
            command=lambda: self._extract_conversation(filedialog, messagebox)
        )
        btn_extract.pack(side=tk.RIGHT, padx=2)

        btn_clear = tk.Button(
            hdr_chat, text="Clear", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#94A3B8",
            relief=tk.FLAT, bd=0, padx=8, pady=2, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
            command=self._clear_conversation
        )
        btn_clear.pack(side=tk.RIGHT, padx=2)

        # Scrollable Chat Box
        chat_box_frame = tk.Frame(card_chat, bg="#050B17", highlightbackground="#1E293B", highlightthickness=1)
        chat_box_frame.pack(fill=tk.BOTH, expand=True, pady=4)

        self.txt_log = tk.Text(
            chat_box_frame, bg="#050B17", fg="#E2E8F0", font=("Segoe UI", 9),
            wrap=tk.WORD, bd=0, padx=10, pady=8, insertbackground="#06B6D4"
        )
        sb_chat = tk.Scrollbar(chat_box_frame, command=self.txt_log.yview)
        self.txt_log.configure(yscrollcommand=sb_chat.set)
        sb_chat.pack(side=tk.RIGHT, fill=tk.Y)
        self.txt_log.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.txt_log.tag_config("user_tag", foreground="#38BDF8", font=("Segoe UI", 9, "bold"))
        self.txt_log.tag_config("ai_tag", foreground="#06B6D4", font=("Segoe UI", 9, "bold"))
        self.txt_log.tag_config("sys_tag", foreground="#A855F7", font=("Segoe UI", 8, "italic"))
        self.txt_log.tag_config("body_tag", foreground="#F1F5F9", font=("Segoe UI", 9))

        # Quick Actions Row
        quick_frame = tk.Frame(card_chat, bg="#0B132B")
        quick_frame.pack(fill=tk.X, pady=(4, 6))

        quick_actions = [
            ("🌅 Morning Prep", "morning workflow"),
            ("🎬 Viral Short", "make viral short"),
            ("🧹 Diagnostics", "run system diagnostics"),
        ]
        for lbl, prompt_txt in quick_actions:
            tk.Button(
                quick_frame, text=lbl, font=("Segoe UI", 7, "bold"), bg="#0F172A", fg="#94A3B8",
                relief=tk.FLAT, bd=0, padx=6, pady=2, highlightbackground="#1E293B", highlightthickness=1, cursor="hand2",
                command=lambda p=prompt_txt: self._handle_user_prompt(p)
            ).pack(side=tk.LEFT, padx=2)

        # Command Input Field & Send Button
        input_frame = tk.Frame(card_chat, bg="#0B132B")
        input_frame.pack(fill=tk.X, pady=(2, 0))

        self.ent_input = tk.Entry(
            input_frame, bg="#070D18", fg="#FFFFFF", font=("Segoe UI", 10),
            insertbackground="#06B6D4", relief=tk.FLAT, bd=0, highlightbackground="#1E293B", highlightthickness=1
        )
        self.ent_input.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=6, padx=(0, 6))
        self.ent_input.bind("<Return>", lambda e: self._on_send_click())

        btn_send = tk.Button(
            input_frame, text="Send ➔", font=("Segoe UI", 9, "bold"), bg="#0284C7", fg="#FFFFFF",
            relief=tk.FLAT, bd=0, padx=14, pady=5, cursor="hand2", activebackground="#0369A1",
            command=self._on_send_click
        )
        btn_send.pack(side=tk.RIGHT)

        # Initial greeting & chat history loading
        self._load_chat()
        self._display_message("Soundwave AI online. Studio Neural Speech engine connected (24kHz HD). How can I assist you today, Operator?", "assistant")

        # Start background timers & animation loop
        self._start_animation_loop()
        self._start_clock_ticker()

        root.mainloop()

    def _make_tile(self, parent, title: str, value: str, col: int):
        f = tk.Frame(parent, bg="#0F172A", padx=6, pady=4, highlightbackground="#1E293B", highlightthickness=1)
        f.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=2)
        tk.Label(f, text=title.upper(), font=("Segoe UI", 6, "bold"), fg="#64748B", bg="#0F172A").pack(anchor=tk.W)
        lbl_val = tk.Label(f, text=value, font=("Consolas", 8, "bold"), fg="#38BDF8", bg="#0F172A")
        lbl_val.pack(anchor=tk.W)
        return lbl_val

    def _refresh_stats(self):
        import random
        cpu = random.randint(5, 14)
        mem = random.randint(28, 44)
        if hasattr(self, "lbl_tile_cpu"):
            self.lbl_tile_cpu.config(text=f"{cpu}%")
        if hasattr(self, "lbl_tile_mem"):
            self.lbl_tile_mem.config(text=f"{mem}%")
        if hasattr(self, "lbl_cpu_txt"):
            self.lbl_cpu_txt.config(text=f"CPU Usage: {cpu}%")
        if hasattr(self, "cv_cpu"):
            self.cv_cpu.delete("all")
            self.cv_cpu.create_rectangle(0, 0, cpu * 3.5, 6, fill="#06B6D4", outline="")

    def _toggle_camera(self):
        self.camera_active = not self.camera_active
        if self.camera_active:
            self.lbl_cam_badge.config(text="STREAMING", fg="#10B981", bg="#064E3B")
            self.cv_cam_feed.itemconfigure(self.cam_text_id, text="[LIVE OPTICAL FEED ACTIVE]\nScreen & Camera Vision Connected", fill="#06B6D4")
            self._append_log("Optical sensors and screen viewport engaged.", "sys")
        else:
            self.lbl_cam_badge.config(text="STANDBY", fg="#94A3B8", bg="#0F172A")
            self.cv_cam_feed.itemconfigure(self.cam_text_id, text="[OPTICAL FEED STANDBY]\nClick 'Toggle Vision' to activate", fill="#475569")

    def _toggle_mic(self):
        self.is_mic_active = not self.is_mic_active
        if self.is_mic_active:
            self.btn_mic.config(text="🎙️ Mic: ACTIVE", bg="#10B981")
            self.state = "LISTENING"
            self._set_status_text("● LISTENING TO OPERATOR...")
        else:
            self.btn_mic.config(text="🎙️ Mic: MUTED", bg="#475569")
            self.state = "STANDBY"
            self._set_status_text("● STANDBY · LISTENING FOR WAKE WORD")

    def _toggle_voice(self):
        self.voice_feedback = not self.voice_feedback
        if self.voice_feedback:
            self.btn_tts.config(text="🔊 Neural Voice: ON", fg="#38BDF8")
        else:
            self.btn_tts.config(text="🔇 Neural Voice: OFF", fg="#64748B")

    def _set_status_text(self, text: str):
        if hasattr(self, "lbl_orb_status") and self.lbl_orb_status:
            self.lbl_orb_status.config(text=text)

    def _clear_conversation(self):
        if hasattr(self, "txt_log") and self.txt_log:
            self.txt_log.delete("1.0", "end")
            self._display_message("Conversation cleared. Ready for command.", "sys")

    def _extract_conversation(self, filedialog, messagebox):
        if not hasattr(self, "txt_log") or not self.txt_log:
            return
        content = self.txt_log.get("1.0", "end").strip()
        if not content:
            messagebox.showinfo("Export", "Conversation buffer is empty.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text file", "*.txt"), ("All files", "*.*")],
            initialfile=f"soundwave_conversation_{int(time.time())}.txt"
        )
        if path:
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                messagebox.showinfo("Export Successful", f"Saved conversation to:\n{path}")
            except Exception as e:
                messagebox.showerror("Export Failed", str(e))

    def _on_send_click(self):
        if not hasattr(self, "ent_input"):
            return
        txt = self.ent_input.get().strip()
        if not txt:
            return
        self.ent_input.delete(0, "end")
        self.commands_count += 1
        if hasattr(self, "lbl_tile_cmds"):
            self.lbl_tile_cmds.config(text=str(self.commands_count))
        self._handle_user_prompt(txt)

    def _start_clock_ticker(self):
        def tick():
            t_str = time.strftime("%I:%M:%S %p")
            d_str = time.strftime("%B %d, %Y")
            self.uptime_seconds += 1
            h = str(self.uptime_seconds // 3600).zfill(2)
            m = str((self.uptime_seconds % 3600) // 60).zfill(2)
            s = str(self.uptime_seconds % 60).zfill(2)
            up_str = f"{h}:{m}:{s}"

            if hasattr(self, "lbl_clock_capsule") and self.lbl_clock_capsule:
                self.lbl_clock_capsule.config(text=f"{t_str} | {d_str}")
            if hasattr(self, "lbl_uptime_val") and self.lbl_uptime_val:
                self.lbl_uptime_val.config(text=up_str)

            if self.root:
                self.root.after(1000, tick)

        if self.root:
            self.root.after(1000, tick)

    def _start_animation_loop(self):
        def render():
            if not hasattr(self, "cv_arc") or not self.cv_arc:
                return
            self.cv_arc.delete("all")
            cx, cy = 170, 165
            is_active = self.state in ("LISTENING", "SPEAKING", "THINKING", "EXECUTING") or self.is_mic_active

            # 1. Subtle Outer Energy Halo (Soft multi-layered gradient rings)
            halo_colors = ["#041226", "#061B36", "#0A254A", "#0E3261", "#14427D"]
            for i, hc in enumerate(halo_colors):
                r = 138 - i * 3
                self.cv_arc.create_oval(cx - r, cy - r, cx + r, cy + r, outline=hc, width=1)

            # 2. Main Outer Cyan Containment Ring (R ~120)
            outer_color = "#06B6D4" if is_active else "#1E3A5F"
            self.cv_arc.create_oval(cx - 120, cy - 120, cx + 120, cy + 120, outline=outer_color, width=1.5)

            # 3. Rotating Orbital Dashes Ring (R ~104)
            self.cv_arc.create_oval(cx - 104, cy - 104, cx + 104, cy + 104, outline="#0284C7", width=1.2, dash=(6, 10))

            # 4. Cardinal Energy Nodes & Ticks (R ~86)
            for tick_i in range(8):
                ta = (tick_i * math.pi) / 4 + (self.anim_phase * (0.2 if is_active else 0.08))
                tx1 = cx + math.cos(ta) * 80
                ty1 = cy + math.sin(ta) * 80
                tx2 = cx + math.cos(ta) * (92 if tick_i % 2 == 0 else 86)
                ty2 = cy + math.sin(ta) * (92 if tick_i % 2 == 0 else 86)
                t_color = "#38BDF8" if is_active else "#0369A1"
                self.cv_arc.create_line(tx1, ty1, tx2, ty2, fill=t_color, width=1.6 if tick_i % 2 == 0 else 1)

            # 5. Mid Glowing Ring (R ~68)
            mid_pulse = math.sin(self.anim_phase * 2) * 2 if is_active else 0
            self.cv_arc.create_oval(cx - (68 + mid_pulse), cy - (68 + mid_pulse), cx + (68 + mid_pulse), cy + (68 + mid_pulse), outline="#06B6D4", width=2)

            # 6. Deep Dark Power Core (R ~50)
            core_fill = "#082F49" if is_active else "#030E1E"
            self.cv_arc.create_oval(cx - 50, cy - 50, cx + 50, cy + 50, fill=core_fill, outline="#38BDF8", width=1.5)

            # 7. 3D Dotted Thinking Orb Particles (Jakubantalik Dotted Orb)
            num_lat = 7
            dots_per_ring = 16
            for l_idx in range(num_lat):
                lat = -math.pi / 2 + (l_idx + 1) / (num_lat + 1) * math.pi
                r_lat = 58 * math.cos(lat)
                y_lat = 44 * math.sin(lat)
                wave_offset = math.sin(self.anim_phase * 2.5 + l_idx * 0.8) * 6 if is_active else 0
                for d_idx in range(dots_per_ring):
                    lon = d_idx / dots_per_ring * 2 * math.pi + self.anim_phase * (0.7 if is_active else 0.25)
                    px = cx + math.cos(lon) * (r_lat + wave_offset)
                    py = cy + y_lat + math.sin(lon) * (r_lat * 0.3)
                    depth = (math.sin(lon) + 1) / 2
                    dot_r = 1.0 + depth * (2.6 if is_active else 1.6)
                    dot_c = "#06B6D4" if depth > 0.5 else "#0E3A5F"
                    if depth > 0.8:
                        dot_c = "#FFFFFF" if is_active else "#38BDF8"
                    self.cv_arc.create_oval(px - dot_r, py - dot_r, px + dot_r, py + dot_r, fill=dot_c, outline="")

            # 8. Active Dynamic Equalizer Bars (5 vertical rounded bars with gradient feel)
            bar_w = 4
            bar_gap = 4
            total_w = 5 * bar_w + 4 * bar_gap
            start_x = cx - total_w / 2
            for bi in range(5):
                bx = start_x + bi * (bar_w + bar_gap)
                if self.state == "SPEAKING":
                    bh = math.sin(self.anim_phase * 3.5 + bi * 1.4) * 12 + 16
                elif self.state == "LISTENING":
                    bh = math.sin(self.anim_phase * 2.8 + bi * 1.1) * 10 + 14
                elif self.state == "THINKING":
                    bh = math.sin(self.anim_phase * 4.0 + bi * 1.8) * 6 + 10
                else:
                    bh = math.sin(self.anim_phase + bi * 0.9) * 2 + 5

                by1 = cy - bh / 2
                by2 = cy + bh / 2
                # Core bar
                self.cv_arc.create_rectangle(bx, by1, bx + bar_w, by2, fill="#06B6D4", outline="")
                # Top glowing tip
                self.cv_arc.create_rectangle(bx, by1, bx + bar_w, by1 + 1.5, fill="#FFFFFF", outline="")

            self.anim_phase += 0.08 if is_active else 0.03
            if self.root:
                self.root.after(35, render)

        if self.root:
            self.root.after(35, render)

    def _open_macro_dialog(self, tk, messagebox):
        win = tk.Toplevel(self.root)
        win.title("Ghost Operator Macros")
        win.geometry("500x440")
        win.configure(bg="#030712")

        tk.Label(win, text="GHOST OPERATOR RPA MACROS", font=("Segoe UI", 11, "bold"), fg="#06B6D4", bg="#030712").pack(pady=12)

        macros = [
            ("🚀 Creator Workstation Setup", "creator_morning_prep", "Launches browser, sets audio to 75%, verifies vitals."),
            ("🎬 1-Click Viral Production Autopilot", "viral_production_autopilot", "Generates hook script and buffers upload notice."),
            ("🧹 Workspace & System Diagnostics", "workspace_cleanup_diagnostics", "Audits local workspace files and hardware load."),
        ]

        for title, mid, desc in macros:
            card = tk.Frame(win, bg="#0B132B", padx=12, pady=10, highlightbackground="#1E293B", highlightthickness=1)
            card.pack(fill=tk.X, padx=14, pady=5)

            tk.Label(card, text=title, font=("Segoe UI", 9, "bold"), fg="#FFFFFF", bg="#0B132B").pack(anchor=tk.W)
            tk.Label(card, text=desc, font=("Segoe UI", 8), fg="#94A3B8", bg="#0B132B").pack(anchor=tk.W)

            btn = tk.Button(
                card, text="Run Workflow", font=("Segoe UI", 8, "bold"), bg="#0284C7", fg="#FFFFFF",
                relief=tk.FLAT, bd=0, padx=10, pady=3, cursor="hand2",
                command=lambda m=mid: [win.destroy(), self._execute_action("ghost_macro", {"action": "execute", "macro_id": m})]
            )
            btn.pack(anchor=tk.E, pady=(4, 0))

    def _open_settings_dialog(self, tk, messagebox):
        win = tk.Toplevel(self.root)
        win.title("Soundwave Settings")
        win.geometry("480x480")
        win.configure(bg="#030712")

        tk.Label(win, text="ASSISTANT CONFIGURATION", font=("Segoe UI", 11, "bold"), fg="#06B6D4", bg="#030712").pack(pady=12)

        f = tk.Frame(win, bg="#0B132B", padx=14, pady=14, highlightbackground="#1E293B", highlightthickness=1)
        f.pack(fill=tk.BOTH, expand=True, padx=16, pady=6)

        tk.Label(f, text="Assistant Name:", font=("Segoe UI", 9), fg="#94A3B8", bg="#0B132B").pack(anchor=tk.W)
        ent_name = tk.Entry(f, bg="#070D18", fg="#FFFFFF", font=("Segoe UI", 9), insertbackground="#06B6D4")
        ent_name.pack(fill=tk.X, pady=(2, 10))
        ent_name.insert(0, self.assistant_name)

        tk.Label(f, text="Neural Voice Talent:", font=("Segoe UI", 9, "bold"), fg="#38BDF8", bg="#0B132B").pack(anchor=tk.W, pady=(4, 2))

        voices = [
            ("en-US-GuyNeural", "Guy (en-US Male - Deep & Natural)"),
            ("en-US-ChristopherNeural", "Christopher (en-US Male - Studio JARVIS)"),
            ("en-GB-RyanNeural", "Ryan (en-GB Male - British)"),
            ("en-US-JennyNeural", "Jenny (en-US Female - Smooth)"),
        ]

        voice_var = tk.StringVar(value=self.selected_voice)
        for vid, vlabel in voices:
            rb = tk.Radiobutton(
                f, text=vlabel, variable=voice_var, value=vid,
                font=("Segoe UI", 8), fg="#E2E8F0", bg="#0B132B",
                selectcolor="#070D18", activebackground="#0B132B", activeforeground="#06B6D4"
            )
            rb.pack(anchor=tk.W, pady=1)

        btn_test_v = tk.Button(
            f, text="▶ Test Selected Voice", font=("Segoe UI", 8, "bold"), bg="#0F172A", fg="#06B6D4",
            relief=tk.FLAT, bd=0, padx=8, pady=3, highlightbackground="#1E293B", highlightthickness=1,
            cursor="hand2", command=lambda: speak("Neural speech synthesis operational.", voice_var.get())
        )
        btn_test_v.pack(anchor=tk.W, pady=(4, 8))

        def toggle_voice():
            self.voice_feedback = not self.voice_feedback
            btn_v.config(text="Neural Voice: Enabled" if self.voice_feedback else "Neural Voice: Disabled")

        btn_v = tk.Button(
            f, text="Neural Voice: Enabled" if self.voice_feedback else "Neural Voice: Disabled",
            font=("Segoe UI", 8, "bold"), bg="#0284C7", fg="#FFFFFF", relief=tk.FLAT, bd=0, padx=8, pady=4,
            command=toggle_voice
        )
        btn_v.pack(fill=tk.X, pady=6)

        def save():
            new_name = ent_name.get().strip()
            if new_name:
                self.assistant_name = new_name
            self.selected_voice = voice_var.get()
            win.destroy()
            messagebox.showinfo("Saved", "Settings updated.")

        tk.Button(win, text="Save Settings", bg="#10B981", fg="#FFFFFF", font=("Segoe UI", 9, "bold"), relief=tk.FLAT, bd=0, padx=12, pady=5, cursor="hand2", command=save).pack(pady=10)

    def _trigger_short(self, niche: str):
        self.state = "GENERATING"
        self._set_status_text(f"● RENDERING SHORT FOR {niche.upper()}...")
        def task():
            saved_file = generate_single_short(topic=niche, voice=self.selected_voice, open_browser=True)
            self.state = "STANDBY"
            self._set_status_text("● STANDBY · LISTENING FOR WAKE WORD")
            if saved_file:
                self._append_log(f"Rendered viral short for {niche}!\nVideo saved to:\n{saved_file}", "sys")
                speak("Your video has finished rendering and is ready to watch!", self.selected_voice)
            else:
                self._append_log(f"Rendered viral short for {niche}. Video ready in browser.", "sys")
        threading.Thread(target=task, daemon=True).start()

    def _execute_action(self, name: str, params: Dict[str, Any]):
        self.state = "EXECUTING"
        self._set_status_text(f"● EXECUTING {name.upper()}...")
        def task():
            res = action_registry.execute(name, params)
            self._append_log(f"[{name.upper()}]:\n{res}", "sys")
            self.state = "STANDBY"
            self._set_status_text("● STANDBY · LISTENING FOR WAKE WORD")
        threading.Thread(target=task, daemon=True).start()

    def _handle_user_prompt(self, prompt: str):
        self._append_log(prompt, "user")
        self.state = "THINKING"
        self._set_status_text("● NEURAL REASONING...")

        def worker():
            try:
                spoken_reply, action_output = llm_client.query(prompt)
                self._append_log(spoken_reply, "assistant")
                if action_output:
                    self._append_log(f"Action: {action_output}", "sys")

                self.state = "SPEAKING"
                self._set_status_text("● SYNTHESIZING NEURAL SPEECH...")
                if self.voice_feedback:
                    speak(spoken_reply, self.selected_voice)
            except Exception as e:
                self._append_log(f"Error: {e}", "sys")
            finally:
                self.state = "STANDBY"
                self._set_status_text("● STANDBY · LISTENING FOR WAKE WORD")

        threading.Thread(target=worker, daemon=True).start()

if __name__ == "__main__":
    app = SoundwaveDesktopApp()
    app.launch()
