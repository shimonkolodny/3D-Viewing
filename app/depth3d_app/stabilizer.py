"""Turns the model's relative inverse-depth output into a temporally stable 8-bit depth map."""
import numpy as np


class Stabilizer:
    """Per-stream temporal filter.

    * percentile normalisation (2nd..98th) smoothed over time -> no per-frame scale/shift flicker
    * motion-adaptive blend with the previous depth map (smoother when the picture is static)
    * scene-cut detection from a tiny thumbnail -> hard reset
    """

    CUT_THRESHOLD = 38.0

    def __init__(self):
        self.reset()

    def reset(self):
        self.lo = None
        self.hi = None
        self.prev = None
        self.prev_thumb = None

    def process(self, depth: np.ndarray, rgb: np.ndarray):
        """depth: float32 (h,w) larger = nearer. rgb: uint8 (h,w,3). Returns (u8 depth, scene_cut)."""
        thumb = rgb[::8, ::8].astype(np.float32).mean(axis=2)
        motion = 0.0
        cut = False
        if self.prev_thumb is not None and self.prev_thumb.shape == thumb.shape:
            motion = float(np.abs(thumb - self.prev_thumb).mean())
            if motion > self.CUT_THRESHOLD:
                cut = True
        self.prev_thumb = thumb
        if cut or self.prev is None or self.prev.shape != depth.shape:
            if cut:
                self.lo = self.hi = None
            self.prev = None

        lo, hi = np.percentile(depth, (2.0, 98.0))
        lo, hi = float(lo), float(hi)
        if self.lo is None:
            self.lo, self.hi = lo, hi
        else:
            a = 0.12
            self.lo += a * (lo - self.lo)
            self.hi += a * (hi - self.hi)
        span = max(self.hi - self.lo, 1e-4)
        d = np.clip((depth - self.lo) / span, 0.0, 1.0)

        if self.prev is not None:
            keep = float(np.clip(0.65 - motion / 18.0, 0.15, 0.65))
            d = self.prev * keep + d * (1.0 - keep)
        self.prev = d
        return (d * 255.0 + 0.5).astype(np.uint8), cut
