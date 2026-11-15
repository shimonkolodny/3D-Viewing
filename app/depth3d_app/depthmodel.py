"""ONNX Runtime wrapper around Depth Anything V2 Small (Apache-2.0)."""
import hashlib
import os
import sys
import time
import urllib.request

import numpy as np

MODEL_FILENAME = "depth_anything_v2_small.onnx"
MODEL_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
MODEL_SHA256 = "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c"

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
INV_STD = (1.0 / np.array([0.229, 0.224, 0.225], dtype=np.float32)).astype(np.float32)

# Candidate model input widths (all multiples of 14, as the ViT patch size requires).
WIDTHS = [140, 168, 196, 238, 280, 322, 378]


def app_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def user_data_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    d = os.path.join(base, "3D-Viewing")
    os.makedirs(d, exist_ok=True)
    return d


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_model(explicit: str | None = None, log=print) -> str:
    """Locate the model next to the app, else in the user data dir, else download it (checksum-verified)."""
    candidates = [explicit] if explicit else []
    candidates += [
        os.path.join(app_dir(), "models", MODEL_FILENAME),
        os.path.join(user_data_dir(), MODEL_FILENAME),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    dest = os.path.join(user_data_dir(), MODEL_FILENAME)
    log(f"Downloading depth model (~99 MB) to {dest} ...")
    tmp = dest + ".part"
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "3D-Viewing"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    if sha256_file(tmp) != MODEL_SHA256:
        os.remove(tmp)
        raise RuntimeError("Downloaded model failed its checksum; refusing to use it.")
    os.replace(tmp, dest)
    return dest


class DepthModel:
    def __init__(self, path: str, threads: int = 1, provider: str = "cpu"):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.enable_cpu_mem_arena = False   # keep the working set small on 8 GB machines
        so.enable_mem_pattern = False     # input sizes change when quality adapts
        providers = ["CPUExecutionProvider"]
        if provider == "dml" and "DmlExecutionProvider" in ort.get_available_providers():
            providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
        self.session = ort.InferenceSession(path, so, providers=providers)
        self.provider = self.session.get_providers()[0]
        self.input_name = self.session.get_inputs()[0].name

    def infer(self, rgb: np.ndarray) -> np.ndarray:
        """rgb: uint8 (h,w,3). Returns float32 (h',w') inverse depth (bigger = nearer), h',w' multiples of 14."""
        h, w = rgb.shape[0] // 14 * 14, rgb.shape[1] // 14 * 14
        x = rgb[:h, :w].astype(np.float32) * (1.0 / 255.0)
        x -= MEAN
        x *= INV_STD
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        out = self.session.run(None, {self.input_name: x})[0]
        return out[0]

    def benchmark(self, width: int, runs: int = 3) -> float:
        """Median milliseconds to run one 16:9 frame at `width`."""
        h = max(14, round(width * 9 / 16 / 14) * 14)
        img = (np.random.rand(h, width, 3) * 255).astype(np.uint8)
        self.infer(img)  # warm-up
        times = []
        for _ in range(runs):
            t = time.perf_counter()
            self.infer(img)
            times.append((time.perf_counter() - t) * 1000)
        return float(sorted(times)[len(times) // 2])


def autotune(model: DepthModel, target_fps: float = 8.0, log=print):
    """Pick the largest input width that sustains target_fps with ~20% headroom. Returns (width, {width: ms})."""
    budget = 1000.0 / target_fps * 0.8
    results = {}
    best = WIDTHS[0]
    for w in WIDTHS:
        ms = model.benchmark(w)
        results[w] = ms
        log(f"  autotune width {w}: {ms:.0f} ms")
        if ms <= budget:
            best = w
        else:
            break
    return best, results
