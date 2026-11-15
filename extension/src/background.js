// Service worker: owns the single WebSocket to the local 3D Viewing app and relays frames/depth for every tab.
const WS_URL = "ws://127.0.0.1:38475";
const PROTOCOL_VERSION = 1;
const MSG_FRAME = 1, MSG_DEPTH = 2;
const FRAME_HDR = 13, DEPTH_HDR = 17;

let ws = null;
let connected = false;
let retryMs = 1000;
let retryTimer = null;
const ports = new Map(); // stream id -> port
const allPorts = new Set();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function broadcastState() {
  for (const p of allPorts) { try { p.postMessage({ t: "state", connected }); } catch (_) {} }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(WS_URL); } catch (_) { scheduleRetry(); return; }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === "hello_ack") {
        connected = !!m.ok; retryMs = 1000; broadcastState();
      }
      return;
    }
    const dv = new DataView(ev.data);
    if (dv.byteLength < DEPTH_HDR || dv.getUint8(0) !== MSG_DEPTH) return;
    const stream = dv.getUint32(1, true);
    const port = ports.get(stream);
    if (!port) return;
    const w = dv.getUint16(9, true), h = dv.getUint16(11, true);
    try {
      port.postMessage({
        t: "depth", fid: dv.getUint32(5, true), w, h,
        nextW: dv.getUint16(13, true), flags: dv.getUint16(15, true),
        b64: bytesToB64(new Uint8Array(ev.data, DEPTH_HDR, w * h)),
      });
    } catch (_) {}
  };
  ws.onclose = ws.onerror = () => {
    if (connected) { connected = false; broadcastState(); }
    ws = null;
    scheduleRetry();
  };
}
function scheduleRetry() {
  if (retryTimer || allPorts.size === 0) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
  retryMs = Math.min(retryMs * 2, 10000);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "d3d") return;
  allPorts.add(port);
  let myStream = null;
  connect();
  port.postMessage({ t: "state", connected });
  port.onMessage.addListener((m) => {
    if (m.t === "hello") { myStream = m.stream >>> 0; ports.set(myStream, port); }
    else if (m.t === "frame") {
      if (!ws || ws.readyState !== WebSocket.OPEN || !connected) { connect(); return; }
      const rgb = b64ToBytes(m.b64);
      if (rgb.length !== m.w * m.h * 3) return;
      const buf = new ArrayBuffer(FRAME_HDR + rgb.length);
      const dv = new DataView(buf);
      dv.setUint8(0, MSG_FRAME); dv.setUint32(1, m.stream >>> 0, true); dv.setUint32(5, m.fid >>> 0, true);
      dv.setUint16(9, m.w, true); dv.setUint16(11, m.h, true);
      new Uint8Array(buf, FRAME_HDR).set(rgb);
      ws.send(buf);
    } else if (m.t === "badge" && port.sender && port.sender.tab) {
      setBadge(port.sender.tab.id, m.text, m.color);
    }
  });
  port.onDisconnect.addListener(() => {
    allPorts.delete(port);
    if (myStream !== null && ports.get(myStream) === port) ports.delete(myStream);
    if (port.sender && port.sender.tab) setBadge(port.sender.tab.id, "", "#000");
    if (allPorts.size === 0 && ws) { try { ws.close(); } catch (_) {} }
  });
});

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    if (text) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.t === "getState") { reply({ connected, ports: allPorts.size }); }
  return false;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-3d") return;
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  await chrome.storage.local.set({ enabled: !enabled });
});
