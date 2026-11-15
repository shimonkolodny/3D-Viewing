"""Start the app (built exe or `python -m depth3d_app`), send a frame over the real WebSocket protocol and expect depth back.
usage: smoke_test.py <model.onnx> <command...>   e.g.  smoke_test.py models/x.onnx dist/3D-Viewing/3D-Viewing.exe"""
import asyncio, os, struct, subprocess, sys, time
import numpy as np
import websockets

PORT = 38777

async def main(model, cmd):
    p = subprocess.Popen(cmd + ["--no-gui", "--allow-any-origin", "--port", str(PORT), "--model", model, "--target-fps", "2"])
    try:
        deadline = time.time() + 240
        ws = None
        while time.time() < deadline:
            if p.poll() is not None:
                raise SystemExit(f"app exited early with code {p.returncode}")
            try:
                ws = await websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=None)
                break
            except OSError:
                await asyncio.sleep(1)
        if ws is None:
            raise SystemExit("app never started listening")
        await ws.send('{"type":"hello","version":1}')
        ack = await asyncio.wait_for(ws.recv(), 10)
        print("ack:", ack)
        assert '"ok": true' in ack
        w, h = 196, 112
        img = (np.random.rand(h, w, 3) * 255).astype(np.uint8).tobytes()
        await ws.send(struct.pack("<BIIHH", 1, 42, 7, w, h) + img)
        data = await asyncio.wait_for(ws.recv(), 60)
        typ, stream, fid, dw, dh, nw, flags = struct.unpack_from("<BIIHHHH", data)
        assert (typ, stream, fid, dw, dh) == (2, 42, 7, w, h) and len(data) == 17 + w * h, (typ, stream, fid, dw, dh, len(data))
        print(f"OK: depth {dw}x{dh}, next width {nw}")
    finally:
        p.terminate()
        try: p.wait(10)
        except Exception: p.kill()

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
