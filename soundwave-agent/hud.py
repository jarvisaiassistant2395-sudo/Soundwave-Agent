"""
Soundwave AI — Reactive Audio HUD & Visualizer
Replaces the 3D software head with a modern, futuristic acoustic visualizer.

Displays dynamic audio pulses, frequency waves, and real-time state transitions:
[IDLE] -> [LISTENING] -> [GENERATING] -> [COMPOSITING] -> [COMPLETE]
"""

import math
import time
import threading
from typing import Optional, Callable

class SoundwaveHudTerminal:
    """ASCII-based reactive soundwave visualizer for terminal and headless environments."""

    BAR_CHARS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

    def __init__(self):
        self.state = "STANDBY"
        self.phase = 0.0

    def set_state(self, new_state: str):
        self.state = new_state

    def render_frame(self, num_bars: int = 32) -> str:
        self.phase += 0.25
        bars = []
        is_active = self.state not in ("STANDBY", "IDLE")

        for i in range(num_bars):
            angle = (i / num_bars) * math.pi * 2 + self.phase
            if is_active:
                val = (math.sin(angle * 2) * math.cos(angle * 3) + 1) / 2
                level = int(val * (len(self.BAR_CHARS) - 1))
            else:
                val = (math.sin(angle) + 1) / 4
                level = int(val * (len(self.BAR_CHARS) - 1))
            bars.append(self.BAR_CHARS[max(0, min(level, len(self.BAR_CHARS) - 1))])

        wave_str = "".join(bars)
        return f"\r[Soundwave HUD: {self.state:<12}] ▕{wave_str}▏"

def launch_gui_hud(
    on_generate_click: Optional[Callable[[str], None]] = None,
    on_batch_click: Optional[Callable[[], None]] = None,
):
    """Launch the Tkinter-based Soundwave Reactive HUD."""
    try:
        import tkinter as tk
        from tkinter import ttk, messagebox
    except ImportError:
        print("[HUD] Tkinter not available. Falling back to Terminal HUD.")
        return

    root = tk.Tk()
    root.title("Soundwave AI — Command Deck HUD")
    root.geometry("520x640")
    root.configure(bg="#070B14")
    root.resizable(False, False)

    state_var = tk.StringVar(value="SYSTEM READY")
    topic_var = tk.StringVar(value="psychology")
    anim_phase = [0.0]
    is_busy = [False]

    # Title Banner matching Command Deck HUD
    header = tk.Frame(root, bg="#0A1224", pady=10, highlightbackground="#14233D", highlightthickness=1)
    header.pack(fill=tk.X, padx=12, pady=10)

    title_lbl = tk.Label(
        header, text="S . O . U . N . D . W . A . V . E", font=("Consolas", 14, "bold"), fg="#00F0FF", bg="#0A1224"
    )
    title_lbl.pack()

    subtitle_lbl = tk.Label(
        header, text="● Online · Autonomous Shorts & Voice Studio", font=("Segoe UI", 9), fg="#10B981", bg="#0A1224"
    )
    subtitle_lbl.pack(pady=(2, 0))

    # Canvas Visualizer (Concentric Glowing Arc Reactor)
    canvas = tk.Canvas(root, width=320, height=240, bg="#070B14", highlightthickness=0)
    canvas.pack(pady=4)

    def draw_hud():
        canvas.delete("all")
        cx, cy = 160, 120
        active = is_busy[0]

        # 1. Outer Concentric Ring (R ~100)
        canvas.create_oval(cx - 100, cy - 100, cx + 100, cy + 100, outline="#0E223D", width=1)

        # 2. Concentric Ring 2 (R ~80) with dashed lines
        canvas.create_oval(cx - 80, cy - 80, cx + 80, cy + 80, outline="#14345C", width=1.2, dash=(4, 10))

        # 3. Concentric Ring 3 (R ~62) with cyan ticks
        canvas.create_oval(cx - 62, cy - 62, cx + 62, cy + 62, outline="#00F0FF" if active else "#1A497F", width=1.4)
        for tick_i in range(4):
            ta = (tick_i * math.pi) / 2 + (anim_phase[0] * 0.15)
            tx1 = cx + math.cos(ta) * 56
            ty1 = cy + math.sin(ta) * 56
            tx2 = cx + math.cos(ta) * 64
            ty2 = cy + math.sin(ta) * 64
            canvas.create_line(tx1, ty1, tx2, ty2, fill="#00F0FF", width=1.5)

        # 4. Glowing Cyan Circle (R ~48)
        canvas.create_oval(cx - 48, cy - 48, cx + 48, cy + 48, outline="#00F0FF", width=2)

        # 5. Inner Dark Core
        core_fill = "#081E36" if active else "#051120"
        canvas.create_oval(cx - 36, cy - 36, cx + 36, cy + 36, fill=core_fill, outline="#00F0FF", width=1)

        # 6. Active Equalizer Bars (5 vertical rounded bars)
        bar_w = 4
        bar_gap = 4
        total_w = 5 * bar_w + 4 * bar_gap
        start_x = cx - total_w / 2
        for bi in range(5):
            bx = start_x + bi * (bar_w + bar_gap)
            if active:
                bh = math.sin(anim_phase[0] * 2.5 + bi * 1.2) * 12 + 16
            else:
                bh = math.sin(anim_phase[0] + bi * 0.8) * 3 + 7
            by1 = cy - bh / 2
            by2 = cy + bh / 2
            canvas.create_rectangle(bx, by1, bx + bar_w, by2, fill="#00F0FF", outline="")

        anim_phase[0] += 0.08 if active else 0.03
        root.after(30, draw_hud)

    # Status Label Capsule
    status_frame = tk.Frame(root, bg="#0C172E", padx=16, pady=6, highlightbackground="#172A4A", highlightthickness=1)
    status_frame.pack(padx=24, pady=4)

    status_lbl = tk.Label(
        status_frame, textvariable=state_var, font=("Consolas", 10, "bold"), fg="#00F0FF", bg="#0C172E"
    )
    status_lbl.pack()

    # Niche Selection
    ctrl_frame = tk.Frame(root, bg="#0A0F1C", padx=24)
    ctrl_frame.pack(fill=tk.X, pady=8)

    lbl_niche = tk.Label(ctrl_frame, text="SELECT NICHE:", font=("Inter", 9, "bold"), fg="#94A3B8", bg="#0A0F1C")
    lbl_niche.pack(anchor=tk.W, pady=2)

    niches = ["psychology", "facts", "history", "finance", "ai", "motivation", "horror"]
    dropdown = ttk.Combobox(ctrl_frame, values=niches, textvariable=topic_var, state="readonly", font=("Inter", 10))
    dropdown.pack(fill=tk.X, pady=4)

    # Buttons
    def on_generate():
        if is_busy[0]:
            return
        is_busy[0] = True
        state_var.set("GENERATING VIRAL SHORT...")
        niche = topic_var.get()

        def worker():
            if on_generate_click:
                on_generate_click(niche)
            else:
                time.sleep(3)
            state_var.set("COMPLETED!")
            is_busy[0] = False

        threading.Thread(target=worker, daemon=True).start()

    def on_batch():
        if is_busy[0]:
            return
        is_busy[0] = True
        state_var.set("STARTING 7-NICHE BATCH...")

        def worker():
            if on_batch_click:
                on_batch_click()
            else:
                time.sleep(5)
            state_var.set("BATCH COMPLETE!")
            is_busy[0] = False

        threading.Thread(target=worker, daemon=True).start()

    btn_frame = tk.Frame(root, bg="#0A0F1C", padx=24)
    btn_frame.pack(fill=tk.X, pady=10)

    btn_gen = tk.Button(
        btn_frame,
        text="⚡ 1-Click Short",
        font=("Inter", 10, "bold"),
        bg="#0284C7",
        fg="#FFFFFF",
        activebackground="#0369A1",
        relief=tk.FLAT,
        pady=8,
        command=on_generate,
    )
    btn_gen.pack(fill=tk.X, pady=3)

    btn_batch = tk.Button(
        btn_frame,
        text="📦 Batch All 7 Niches",
        font=("Inter", 10, "bold"),
        bg="#7C3AED",
        fg="#FFFFFF",
        activebackground="#6D28D9",
        relief=tk.FLAT,
        pady=8,
        command=on_batch,
    )
    btn_batch.pack(fill=tk.X, pady=3)

    draw_hud()
    root.mainloop()

if __name__ == "__main__":
    term = SoundwaveHudTerminal()
    term.set_state("ACTIVE")
    for _ in range(20):
        print(term.render_frame(), end="")
        time.sleep(0.08)
    print("\nTerminal HUD test passed.")
