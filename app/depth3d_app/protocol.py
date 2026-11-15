"""Binary wire protocol between the browser extension and the PC app (little-endian).

Client -> server
  JSON text  {"type":"hello","version":1}
  FRAME   : u8 type=1 | u32 stream | u32 frameId | u16 w | u16 h | w*h*3 bytes RGB
Server -> client
  JSON text  {"type":"hello_ack", ...}  /  {"type":"status", ...}
  DEPTH   : u8 type=2 | u32 stream | u32 frameId | u16 w | u16 h | u16 nextW | u16 flags | w*h bytes (u8 depth, 255 = nearest)
            flags bit0 = scene cut (client should not cross-fade)
"""
import struct

PROTOCOL_VERSION = 1
MSG_FRAME = 1
MSG_DEPTH = 2

FRAME_HDR = struct.Struct("<BIIHH")
DEPTH_HDR = struct.Struct("<BIIHHHH")

MAX_DIM = 1024
MIN_DIM = 28
FLAG_SCENE_CUT = 1


class ProtocolError(ValueError):
    pass


def parse_frame(data: bytes):
    """Return (stream, frame_id, w, h, rgb_bytes_memoryview). Raises ProtocolError on any malformed input."""
    if len(data) < FRAME_HDR.size:
        raise ProtocolError("short frame")
    typ, stream, fid, w, h = FRAME_HDR.unpack_from(data, 0)
    if typ != MSG_FRAME:
        raise ProtocolError("bad type")
    if not (MIN_DIM <= w <= MAX_DIM and MIN_DIM <= h <= MAX_DIM):
        raise ProtocolError("bad dimensions")
    if len(data) - FRAME_HDR.size != w * h * 3:
        raise ProtocolError("bad payload size")
    return stream, fid, w, h, memoryview(data)[FRAME_HDR.size:]


def build_frame(stream, fid, w, h, rgb: bytes) -> bytes:
    return FRAME_HDR.pack(MSG_FRAME, stream, fid, w, h) + rgb


def build_depth(stream, fid, w, h, next_w, flags, depth_u8: bytes) -> bytes:
    return DEPTH_HDR.pack(MSG_DEPTH, stream, fid, w, h, next_w, flags) + depth_u8


def parse_depth(data: bytes):
    typ, stream, fid, w, h, next_w, flags = DEPTH_HDR.unpack_from(data, 0)
    if typ != MSG_DEPTH or len(data) - DEPTH_HDR.size != w * h:
        raise ProtocolError("bad depth message")
    return stream, fid, w, h, next_w, flags, memoryview(data)[DEPTH_HDR.size:]
