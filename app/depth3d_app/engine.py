"""Inference worker: always processes the *newest* frame, never builds a backlog."""
import threading
import time
from collections import OrderedDict

import numpy as np

from . import protocol
from .depthmodel import WIDTHS
from .stabilizer import Stabilizer


class Engine(threading.Thread):
    def __init__(self, model, max_width: int, min_width: int = WIDTHS[0], log=print):
        super().__init__(daemon=True, name="depth-engine")
        self.model = model
        self.max_width = max_width
        self.min_width = min_width
        self.width = max_width
        self.log = log
        self._cond = threading.Condition()
        self._pending = OrderedDict()      # key -> (frame tuple, sink)
        self._stabilizers = {}
        self._halt = False
        self.ms_ema = None
        self.depth_fps = 0.0
        self._fps_times = []
        self.frames_done = 0

    # ---- producer side -------------------------------------------------
    def submit(self, key, frame, sink):
        """key identifies (connection, stream); sink(bytes) delivers the reply. Older pending frame for key is replaced."""
        with self._cond:
            self._pending.pop(key, None)
            self._pending[key] = (frame, sink)
            self._cond.notify()

    def forget(self, conn_id):
        with self._cond:
            for k in [k for k in self._pending if k[0] == conn_id]:
                del self._pending[k]
            for k in [k for k in self._stabilizers if k[0] == conn_id]:
                del self._stabilizers[k]

    def stop(self):
        with self._cond:
            self._halt = True
            self._cond.notify()

    # ---- worker --------------------------------------------------------
    def run(self):
        while True:
            with self._cond:
                while not self._pending and not self._halt:
                    self._cond.wait()
                if self._halt:
                    return
                key, (frame, sink) = self._pending.popitem(last=False)
            try:
                self._process(key, frame, sink)
            except Exception as e:  # never let one bad frame kill the worker
                self.log(f"inference error: {e!r}")

    def _process(self, key, frame, sink):
        stream, fid, w, h, payload = frame
        t0 = time.perf_counter()
        rgb = np.frombuffer(payload, dtype=np.uint8).reshape(h, w, 3)
        depth = self.model.infer(rgb)
        rgb_c = rgb[: depth.shape[0], : depth.shape[1]]
        stab = self._stabilizers.setdefault(key, Stabilizer())
        d8, cut = stab.process(depth, rgb_c)
        ms = (time.perf_counter() - t0) * 1000.0
        self._adapt(ms, d8.shape[1])
        flags = protocol.FLAG_SCENE_CUT if cut else 0
        sink(protocol.build_depth(stream, fid, d8.shape[1], d8.shape[0], self.width, flags, d8.tobytes()))
        now = time.monotonic()
        self._fps_times.append(now)
        self._fps_times = [t for t in self._fps_times if now - t < 3.0]
        self.depth_fps = len(self._fps_times) / 3.0
        self.frames_done += 1

    def _adapt(self, ms, cur_w):
        """Step the model resolution down when slow, back up when there is clear headroom (cost ~ width^2)."""
        self.ms_ema = ms if self.ms_ema is None else self.ms_ema + 0.2 * (ms - self.ms_ema)
        idx = WIDTHS.index(self.width) if self.width in WIDTHS else 0
        if self.ms_ema > 170 and self.width > self.min_width:
            self.width = WIDTHS[idx - 1]
            self.ms_ema = None
        elif idx + 1 < len(WIDTHS) and WIDTHS[idx + 1] <= self.max_width:
            projected = self.ms_ema * (WIDTHS[idx + 1] / self.width) ** 2
            if projected < 105:
                self.width = WIDTHS[idx + 1]
                self.ms_ema = None
