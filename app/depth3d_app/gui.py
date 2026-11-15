"""Tiny status window (tkinter ships with Python, adds no dependencies)."""
import tkinter as tk
from tkinter import ttk


def run_gui(engine, state, port, on_close):
    root = tk.Tk()
    root.title("3D Viewing")
    root.geometry("340x190")
    root.resizable(False, False)
    frm = ttk.Frame(root, padding=14)
    frm.pack(fill="both", expand=True)
    ttk.Label(frm, text="3D Viewing depth service", font=("Segoe UI", 12, "bold")).pack(anchor="w")
    status = ttk.Label(frm, text="Starting…")
    status.pack(anchor="w", pady=(8, 0))
    detail = ttk.Label(frm, text="")
    detail.pack(anchor="w", pady=(4, 0))
    ttk.Label(frm, text=f"Listening on 127.0.0.1:{port}\nKeep this window open (minimise it) while watching.",
              foreground="#555").pack(anchor="w", pady=(10, 0))

    def tick():
        n = state["clients"]
        status.config(text="Browser connected" if n else "Waiting for the browser extension…")
        detail.config(text=f"Depth: {engine.depth_fps:.1f} fps   Model width: {engine.width}px   "
                           f"{engine.ms_ema or 0:.0f} ms/frame")
        root.after(500, tick)

    def close():
        on_close()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", close)
    tick()
    root.mainloop()
