"""Local WebSocket server. Loopback only; refuses connections that do not come from a browser extension."""
import asyncio
import itertools
import json

from websockets.asyncio.server import serve

from . import __version__, protocol

DEFAULT_PORT = 38475
_conn_ids = itertools.count(1)


def origin_allowed(origin: str | None, allow_any: bool) -> bool:
    if allow_any:
        return True
    # Web pages always send their own http(s) Origin; only extensions send chrome-extension://.
    return bool(origin) and origin.startswith(("chrome-extension://", "moz-extension://"))


async def run_server(engine, state, port=DEFAULT_PORT, allow_any_origin=False, log=print, ready=None):
    loop = asyncio.get_running_loop()

    async def handler(ws):
        origin = ws.request.headers.get("Origin")
        if not origin_allowed(origin, allow_any_origin):
            await ws.close(4403, "forbidden origin")
            return
        conn_id = next(_conn_ids)
        state["clients"] += 1
        log(f"client {conn_id} connected")

        def sink(data: bytes):
            asyncio.run_coroutine_threadsafe(_safe_send(ws, data), loop)

        try:
            async for msg in ws:
                if isinstance(msg, str):
                    try:
                        obj = json.loads(msg)
                    except ValueError:
                        continue
                    if obj.get("type") == "hello":
                        await ws.send(json.dumps({
                            "type": "hello_ack", "protocol": protocol.PROTOCOL_VERSION, "app": __version__,
                            "ok": obj.get("version") == protocol.PROTOCOL_VERSION,
                            "width": engine.width, "model": "depth-anything-v2-small",
                            "provider": engine.model.provider,
                        }))
                    continue
                try:
                    stream, fid, w, h, payload = protocol.parse_frame(msg)
                except protocol.ProtocolError:
                    continue  # silently drop malformed frames
                engine.submit((conn_id, stream), (stream, fid, w, h, payload), sink)
        finally:
            engine.forget(conn_id)
            state["clients"] -= 1
            log(f"client {conn_id} disconnected")

    async with serve(handler, "127.0.0.1", port, max_size=2 * 1024 * 1024, compression=None,
                     ping_interval=20, ping_timeout=20) as server:
        if ready:
            ready.set()
        await server.serve_forever()


async def _safe_send(ws, data):
    try:
        await ws.send(data)
    except Exception:
        pass
