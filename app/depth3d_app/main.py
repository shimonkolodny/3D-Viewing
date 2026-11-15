import argparse
import asyncio
import ctypes
import os
import sys
import threading

from . import __version__
from .depthmodel import DepthModel, autotune, find_model
from .engine import Engine
from .server import DEFAULT_PORT, run_server


def lower_priority():
    """Run below normal priority so video decoding and the browser always win the CPU."""
    try:
        if sys.platform == "win32":
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        else:
            os.nice(5)
    except Exception:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="3D Viewing depth service")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--threads", type=int, default=1, help="inference threads (default 1 keeps a core free for video)")
    ap.add_argument("--model", help="path to depth_anything_v2_small.onnx")
    ap.add_argument("--provider", choices=["cpu", "dml"], default="cpu")
    ap.add_argument("--target-fps", type=float, default=8.0)
    ap.add_argument("--no-gui", action="store_true")
    ap.add_argument("--allow-any-origin", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--version", action="version", version=__version__)
    args = ap.parse_args(argv)

    if sys.stdout is None or sys.stderr is None:  # windowed (no console) build: keep a log file instead
        from .depthmodel import user_data_dir
        sys.stdout = sys.stderr = open(os.path.join(user_data_dir(), "3d-viewing.log"), "a", buffering=1, encoding="utf-8")
    lower_priority()
    log = print
    log(f"3D Viewing {__version__}")
    path = find_model(args.model, log)
    log(f"Loading model {path}")
    model = DepthModel(path, threads=args.threads, provider=args.provider)
    log("Autotuning for this machine…")
    width, _ = autotune(model, args.target_fps, log)
    log(f"Selected model width {width}px")
    engine = Engine(model, max_width=width, log=log)
    engine.start()
    state = {"clients": 0}

    def serve():
        asyncio.run(run_server(engine, state, args.port, args.allow_any_origin, log))

    if args.no_gui:
        serve()
        return
    t = threading.Thread(target=serve, daemon=True)
    t.start()
    try:
        from .gui import run_gui
        run_gui(engine, state, args.port, on_close=engine.stop)
    except Exception as e:
        log(f"GUI unavailable ({e}); running headless")
        t.join()


if __name__ == "__main__":
    main()
