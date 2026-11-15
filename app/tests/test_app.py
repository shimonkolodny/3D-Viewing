import asyncio
import os
import sys
import threading

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from depth3d_app import protocol
from depth3d_app.stabilizer import Stabilizer
from depth3d_app.server import origin_allowed

MODEL = os.environ.get("DEPTH_MODEL")


def test_frame_roundtrip_and_validation():
    rgb = bytes(range(256)) * 42  # 10752 = 56*64*3
    msg = protocol.build_frame(7, 9, 56, 64, rgb[:56 * 64 * 3])
    s, f, w, h, p = protocol.parse_frame(msg)
    assert (s, f, w, h, len(p)) == (7, 9, 56, 64, 56 * 64 * 3)
    for bad in (b"", msg[:-1], msg + b"x", protocol.build_frame(1, 1, 5000, 64, b"")):
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_frame(bad)


def test_origin_rules():
    assert origin_allowed("chrome-extension://abcdef", False)
    assert not origin_allowed("https://evil.example", False)
    assert not origin_allowed(None, False)
    assert origin_allowed(None, True)


def test_stabilizer_range_scene_cut_and_stability():
    st = Stabilizer()
    rng = np.random.default_rng(0)
    img = rng.integers(0, 255, (56, 98, 3), dtype=np.uint8)
    base = rng.random((56, 98)).astype(np.float32) * 3 + 10
    outs = []
    for i in range(6):
        d, cut = st.process(base + rng.normal(0, 0.05, base.shape).astype(np.float32), img)
        outs.append(d)
        assert d.dtype == np.uint8 and not cut
    assert outs[-1].max() >= 240 and outs[-1].min() <= 15
    # outliers that move the raw 98th percentile every frame must not make the bulk of the map flicker
    means = []
    for i in range(14):
        j = base.copy()
        j[:4, :] = base.max() + (3.0 if i % 2 else 30.0)   # ~7% of pixels, alternating extreme values
        d, _ = st.process(j, img)
        means.append(float(d[10:50].mean()))
    assert np.std(means[6:]) < 8.0, means
    _, cut = st.process(base, 255 - img)
    assert cut


@pytest.mark.skipif(not MODEL, reason="set DEPTH_MODEL to run the end-to-end test")
def test_end_to_end_server():
    import websockets
    from depth3d_app.depthmodel import DepthModel
    from depth3d_app.engine import Engine
    from depth3d_app.server import run_server

    model = DepthModel(MODEL, threads=1)
    engine = Engine(model, max_width=196, log=lambda *_: None)
    engine.start()
    state = {"clients": 0}
    ready = threading.Event()
    port = 38999
    threading.Thread(target=lambda: asyncio.run(run_server(engine, state, port, False, lambda *_: None, ready)),
                     daemon=True).start()
    assert ready.wait(10)

    async def client():
        # a web page origin must be refused
        async with websockets.connect(f"ws://127.0.0.1:{port}", origin="https://evil.example") as bad:
            with pytest.raises(websockets.ConnectionClosed):
                await bad.recv()
        async with websockets.connect(f"ws://127.0.0.1:{port}", origin="chrome-extension://testid") as ws:
            await ws.send('{"type":"hello","version":1}')
            ack = await ws.recv()
            assert '"ok": true' in ack
            w, h = 196, 112
            gx = np.tile(np.linspace(0, 255, w, dtype=np.uint8), (h, 1))
            rgb = np.stack([gx, gx, gx], axis=2).tobytes()
            for fid in range(3):
                await ws.send(protocol.build_frame(5, fid, w, h, rgb))
                data = await asyncio.wait_for(ws.recv(), 20)
                s, f, dw, dh, nw, flags, d = protocol.parse_depth(data)
                assert (s, f, dw, dh) == (5, fid, w, h) and nw >= 140 and len(d) == w * h
            await ws.send(b"garbage")  # must not crash the server
            await ws.send(protocol.build_frame(5, 99, w, h, rgb))
            data = await asyncio.wait_for(ws.recv(), 20)
            assert protocol.parse_depth(data)[1] == 99

    asyncio.run(client())
    engine.stop()
