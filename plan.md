# 3D-Viewing — Realtime 2D→Anaglyph 3D for Web Video

A Chrome extension detects a playing `<video>`, a small local PC app estimates depth for it with an open model, and the extension renders a red/cyan (or other) anaglyph from that depth in realtime. It must run on old hardware.

> Numbers in this plan (fps, ms, MB) are **targets to validate in Phase 0**, not measurements.

---

## 1. Key design decision: send frames out, depth back — not anaglyph back

The brief says the app "anaglyphs it and sends it back". Doing that literally is the slowest possible design:

| | Literal (app returns anaglyph video) | **Proposed (app returns depth map)** |
|---|---|---|
| Upload | full-res frames (or encode/decode) | ~256–384 px frames, JPEG/raw (~50–150 KB) |
| Download | full-res frames, 30–60/s (tens of MB/s or a codec) | 8-bit depth map, ~64–150 KB, 10–30/s |
| Output quality | capped by pipe | full native video resolution, native fps |
| Old hardware | CPU does warp + color + encode | GPU of the browser does warp (trivial); app only runs the model |
| Who "applies the anaglyph" | app | **extension (as requested)** |

So: **the app does the one expensive thing (depth inference); the extension does the cheap per-pixel thing (view synthesis + anaglyph) in a WebGL shader at full resolution.** The user-visible behavior is identical to the brief, and it is what makes "old hardware + realtime" feasible. Depth changes slowly relative to video frames, so depth can run at 10–20 fps while video renders at its native fps.

---

## 2. Model choice

**Primary: Depth Anything V2 — Small (ViT-S, ~25M params), exported to ONNX.**
- Best quality-per-FLOP among open monocular depth models; sharp edges (matters for anaglyph ghosting).
- **Small is Apache-2.0**; the Base/Large/Giant checkpoints are CC-BY-NC — do **not** ship those.
- Fixed small input (e.g. 252×140→ padded to multiple of 14, ~266×154 / 364 wide for "quality" tier) keeps cost low; output is relative inverse depth (disparity-like), which is exactly what stereo synthesis needs. No metric depth required.
- Quantizable to INT8/FP16 for CPU and iGPU.

**Fallback tier (very old CPUs): MiDaS v2.1 small (~21M, MIT, 256×256).** Lower quality, but very cheap and widely proven on CPU.

**Evaluated and rejected (for this project):**
- Depth Pro / Marigold / diffusion depth — far too heavy for realtime on old hardware.
- Video Depth Anything — better temporal consistency but heavier; we get most of the benefit with cheap temporal smoothing (§6.3). Revisit as a "quality" tier on strong GPUs.
- Depth Anything V1/V2 Base+ — non-commercial licence / too heavy.

Phase 0 benchmarks Depth Anything V2-S vs. MiDaS-small (and Depth Anything 3 small if its licence/size fit) on target hardware and **confirms licences** before we commit. The model sits behind a `DepthModel` interface so it is swappable.

---

## 3. Architecture

```
┌──────────────────────── Chrome ─────────────────────────┐        ┌──────────── PC app (tray) ────────────┐
│ content script (per tab)                                │        │ WebSocket server 127.0.0.1:<port>     │
│  • finds <video>, rVFC loop                             │        │  • auth token, version handshake      │
│  • downscale frame → small canvas ──────────┐           │        │  • frame queue (depth 1, drop-old)    │
│  • WebGL overlay canvas (anaglyph shader)   │ frames    │        │  • preprocess (resize/normalize)      │
│     ▲ depth texture                         ▼           │  WS    │  • ONNX Runtime inference             │
│ offscreen doc / service worker (WS client) ◄────────────┼────────┼──  EPs: CUDA/TRT · DirectML ·         │
│     depth maps ◄────────────────────────────────────────┼────────┼──  OpenVINO · CoreML · CPU(INT8)      │
│ popup UI: on/off, strength, convergence, glasses type   │        │  • hardware autotune (tier select)    │
└─────────────────────────────────────────────────────────┘        │  • tray UI: status, fps, model, GPU   │
                                                                   └───────────────────────────────────────┘
```

### 3.1 Transport
- **Binary WebSocket on `127.0.0.1`**, opened from the extension's offscreen document / service worker (not the page) so site CSP and mixed-content rules don't apply. Host permission to `ws://127.0.0.1/*` in the manifest.
- Handshake: protocol version, per-install **auth token** (pairing code shown in the tray app, pasted once into the extension) — prevents other web pages from using the local server. Bind to loopback only; validate `Origin` is the extension's `chrome-extension://<id>`.
- Chrome's Local Network Access prompts may appear for localhost connections; handle denial with a clear UI state.
- Fallback if WebSockets prove problematic: **Chrome Native Messaging** (stdio, no open port). Depth maps are small, so its message-size limits are fine. Decide in Phase 1.
- Message format (little-endian): `[u8 type][u32 frameId][u16 w][u16 h][payload]`. Frames up: JPEG (default, cheap on bandwidth) or raw RGBA/luma (zero decode cost, localhost bandwidth is plentiful) — benchmark both. Depth down: raw `u8` w×h.
- **Backpressure:** max 1–2 frames in flight. If the app is busy, the extension drops frames (never queues) → latency stays bounded and the app is never overloaded.

### 3.2 Frame capture (extension)
- Primary path: `video.requestVideoFrameCallback` → `drawImage(video)` into a ~256–384 px canvas → send. Works for the vast majority of sites (YouTube, Vimeo, most MSE/HLS players are same-origin blob sources).
- **Limitations to document up front:**
  - **DRM (EME/Widevine: Netflix, Disney+, Prime…) cannot be read** by any browser API — those sites will be unsupported (black frames). Detect and show "DRM-protected, not supported".
  - Cross-origin video without CORS taints canvas/WebGL → fall back to `chrome.tabCapture` stream (frames via `MediaStreamTrackProcessor`), applying the overlay in sync with a small known delay; mark as "beta".
- Auto-detect: pick the largest playing, visible video; observe DOM mutations (SPAs, ads, iframes via `all_frames`); re-attach on source change; pause work when video is paused/hidden/offscreen.

### 3.3 Rendering (extension, WebGL2)
- A transparent `<canvas>` overlaid on the `<video>` (position/size tracked with `ResizeObserver` + rVFC); original video hidden or left beneath. Fullscreen handled by mounting inside the fullscreen element. Click-through (`pointer-events: none`) so site controls keep working. Subtitles/controls remain above since the overlay is z-ordered under them where possible.
- Per frame: upload video frame texture (zero-copy where possible) + latest depth texture → fragment shader (§6) → screen.
- Depth is stale by a few frames; this is imperceptible because depth is smooth in time, and the shader always samples the **current** video frame.

### 3.4 PC app
- **Tech:** Rust single binary (tray via `tray-icon`/Tauri, `tokio-tungstenite`, `ort` for ONNX Runtime). Small install, low idle cost, no Python runtime shipped. *If `ort` EP packaging proves painful, ship a Python (onnxruntime + websockets) build as the fallback; the protocol is identical.* Phase 0/1 prototypes are in Python for speed.
- Execution providers, auto-chosen at first run by a quick benchmark: NVIDIA → CUDA/TensorRT; any Windows GPU → **DirectML**; Intel → **OpenVINO** (iGPU/CPU); Apple → CoreML; otherwise **CPU with INT8 quantized model**.
- First-run **autotune**: runs 2–3 s of synthetic frames per (EP × model variant × resolution), picks the highest-quality config that holds the target fps with headroom, stores it, lets the user override. Re-tunes if hardware changes.
- Adaptive quality at runtime: if inference time grows (thermal throttling, other load), step down resolution or depth fps automatically; step back up when idle.
- Cross-platform: Windows first (largest "old hardware" audience), then Linux/macOS.

---

## 4. Performance budget & tiers (targets)

End-to-end target: **depth latency ≤ ~100 ms, video never stutters** (video renders at native fps regardless of depth rate).

| Tier | Hardware example | Model / input | Depth rate |
|---|---|---|---|
| Quality | Discrete GPU (GTX 1050+/RX 570+) | DA-V2-S FP16, ~364 px | 30 fps |
| Balanced | Intel iGPU / older laptop GPU | DA-V2-S FP16/INT8, ~266 px | 15–20 fps |
| Potato | 4-core CPU circa 2014–2016, no GPU | DA-V2-S INT8 or MiDaS-small, ~192–256 px | 5–10 fps + temporal interpolation |

Tricks that make the Potato tier look smooth:
- **Depth at low fps, render at full fps** — hold last depth, and cross-fade between consecutive depth maps over the interval (in shader).
- **Skip static frames** (paused, or tiny frame diff) — depth reused for free.
- **Scene-cut detection** (histogram/frame-diff in extension) forces immediate depth refresh and resets temporal filters.
- Run model at lowest resolution that preserves edges; edge-aware upsampling in the shader (§6.2) restores sharpness.
- Pin inference to a dedicated thread; leave cores for the browser's video decode.

---

## 5. Anaglyph output options
- **Red/cyan only** (confirmed). No other glasses types.
- Color method: Dubois least-squares matrices (default; best color retention/least ghosting), plus Half-color and Gray variants. Selectable.
- User controls: **depth strength** (max disparity as % of width), **convergence** (zero-parallax plane — what pops out vs. recedes), swap eyes, per-site on/off, hotkey toggle, "reduce ghosting" (depth-range compression).
- Defaults conservative (≈1.5–2% of width max disparity) to avoid eye strain; clamp hard max.

---

## 6. Core algorithm (the part that makes it look good)

### 6.1 Depth → stereo pair (DIBR in a fragment shader)
- Treat depth as normalized disparity `d ∈ [0,1]`; per-eye shift `s = ±strength · (d − convergence)`.
- **Backward warping** with a short depth-aware ray-march (≈6–10 steps, parallax-occlusion style): for each output pixel, search along the scanline for the source pixel whose shifted position lands here, preferring nearer depth. Avoids holes by construction and is cheap on any GPU.
- Remaining disocclusions: stretch/blend from background side (no inpainting needed at ≤2% disparity).

### 6.2 Edge-aware depth upsampling
Depth arrives at ~256–364 px. Upsample in shader with a joint bilateral/guided filter using full-res video luma as guide so depth edges snap to image edges (reduces halos and ghosting).

### 6.3 Temporal stability (biggest source of "bad 3D" is flicker)
- Relative-depth models normalize per frame → scale/shift flicker. Fix: per-frame percentile normalization (e.g. 2nd–98th) smoothed by EMA over time; hard reset on scene cuts.
- EMA / motion-adaptive blend of consecutive depth maps (more smoothing where the image is static, less where it moves).
- Optional later: optical-flow-guided warp of previous depth (Phase 6).

### 6.4 Color
Anaglyph = per-eye color matrices applied after warping (Dubois) in the same shader pass — one draw call total.

---

## 7. Repo layout

```
3D-Viewing/
  plan.md
  README.md
  docs/                  protocol.md, models.md, benchmarks.md, site-compat.md
  extension/             Chrome MV3 (TypeScript, Vite)
    manifest.json
    src/content/         video detection, capture, overlay, WebGL renderer + shaders
    src/background/      service worker, offscreen WS client, state
    src/popup/           controls UI
  app/                   PC app (Rust)
    src/server.rs        WS + auth
    src/infer/           ort session, EP selection, autotune, preprocess
    src/tray.rs
    models/              ONNX files fetched at install/first-run (not committed)
  tools/
    export_onnx.py       checkpoint → ONNX → FP16/INT8
    bench.py             cross-hardware benchmark harness
    quality_eval.py      depth-quality & temporal-flicker metrics
  proto/                 Phase 0/1 Python prototype
```

---

## 8. Phases

**Phase 0 — Feasibility & model selection (days)**
- Export DA-V2-S and MiDaS-small to ONNX (FP32/FP16/INT8). Benchmark on: a modern GPU, an Intel iGPU laptop, and an old CPU-only machine (or CPU-throttled VM).
- Confirm licences of the exact checkpoints; record in `docs/models.md`.
- Offline: depth + shader-equivalent warp on sample clips; eyeball anaglyph on a real pair of glasses.
- **Exit criteria:** pick default model + tiers; Potato tier ≥ 5 fps depth on the oldest target.

**Phase 1 — Pipeline spike (≈1 week)**
- Python app (onnxruntime + websockets) ↔ minimal extension that captures a YouTube video, gets depth, renders plain anaglyph in WebGL.
- Decide WebSocket vs. Native Messaging; JPEG vs. raw frames.
- **Exit:** watchable realtime 3D on a modern laptop, latency measured.

**Phase 2 — Quality**
- Depth-aware ray-march warp, edge-aware upsample, temporal normalization/EMA, scene-cut handling, Dubois matrices, controls (strength/convergence).
- A/B vs. naive horizontal shift; collect flicker metric.

**Phase 3 — Performance on old hardware**
- Rust app rewrite; EP selection; INT8/FP16 variants; autotune; adaptive quality; frame skipping; depth interpolation.
- Profiling to keep app CPU idle <2% when no video is playing.

**Phase 4 — Extension robustness**
- Video detection edge cases (iframes, SPAs, multiple videos, ads, PiP, fullscreen, resize), tabCapture fallback, DRM detection messaging, per-site settings, hotkeys, popup UI, pairing flow, graceful "app not running" state with download link.

**Phase 5 — Packaging & release**
- Windows installer (+ auto-start option, code-signed if possible), model download on first run with checksum, Chrome Web Store listing (privacy policy: everything stays on-device, nothing leaves localhost), signed updates for app and models.
- Docs: supported sites, glasses guide, troubleshooting.

**Phase 6 — Stretch**
- Linux/macOS builds; Edge/Firefox (MV3); optical-flow-guided temporal depth; Video-Depth-Anything "quality" tier; side-by-side / other 3D output formats; head-tracking-free comfort presets; local-file (`file://`) and Twitch/live low-latency tuning.

---

## 9. Testing & validation
- **Latency:** timestamp frames in the protocol; log capture→depth→render per stage; overlay in a debug HUD.
- **Throughput:** soak test 2 h video on the Potato tier (thermal, memory leaks, WS stability).
- **Quality:** fixed clip set (fast motion, dark scenes, animation, screen content, scene cuts); flicker metric (temporal depth variance on static regions); human A/B with real glasses.
- **Compat matrix:** YouTube, Vimeo, Twitch, Dailymotion, generic `<video>` pages, iframes, fullscreen, PiP; Chrome stable ±1.
- **Security:** token pairing, loopback-only bind, Origin checks, fuzz the binary protocol parser, no network egress from the app after model download.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| DRM sites unreadable | Detect + message; out of scope (cannot be bypassed legitimately) |
| Cross-origin tainted video | `tabCapture` fallback path |
| Old CPU too slow | INT8, lower res, depth interpolation, MiDaS-small fallback, frame skipping |
| Depth flicker causes eye strain | §6.3 temporal stabilization, conservative default strength, comfort limits |
| Anaglyph ghosting / color loss | Dubois matrices, depth-range compression, user glasses presets |
| Local-server abuse by web pages | Auth token, Origin check, loopback bind |
| Chrome MV3 / Local Network Access changes | Native Messaging fallback behind the same internal interface |
| Model licence (Base+ is non-commercial) | Ship Small only; verify in Phase 0; model behind swappable interface |
| ONNX EP packaging pain (DirectML/OpenVINO) | Python fallback build; ship per-EP runtime variants |

---

## 11. Decisions (confirmed)

| Question | Decision | Consequence |
|---|---|---|
| Platform | **Windows only** (10/11, x64) | Drop Linux/macOS/CoreML work; CPU + DirectML are the runtimes that matter |
| Distribution | **Public release** (Chrome Web Store + signed installer) | Licences, signing, privacy policy, store review, auto-update, support burden (see Phase 5) |
| Oldest target | **2014-era Intel CPU + integrated GPU** (Haswell/Broadwell, e.g. i5-4xxx, HD 4400/4600/5500) | Defines the "Potato" tier — see §12 |
| Glasses | **Red/cyan only** | One Dubois red/cyan matrix + Half-color/Gray fallbacks |
| Skip DRM sites? | **No — they should be supported** | See §13: cannot be done by reading frames; best-effort screen-capture path with honest limits |

---

## 12. The 2014 Intel target — what it really means

Facts that shape the design (all to be verified in Phase 0 on a real machine):

- **Inference will run on the CPU.** Haswell/Broadwell iGPUs are too weak/old for useful ML: OpenVINO's GPU plugin needs Gen9+ (Skylake, 2015), and DirectML on HD 4400-class parts is likely slower than the CPU. Treat iGPU inference as "benchmark and see", CPU as the default.
- **CPU features:** AVX2 + FMA yes; AVX-512 and VNNI **no**. INT8 gains are modest (ONNX Runtime u8s8 on AVX2 can saturate — use reduced-range/per-channel quantization and compare against FP32). Verify accuracy of the quantized model.
- **Compute budget:** a 2–4 core ~2.5 GHz Haswell realistically sustains tens of GFLOPS. DA-V2-S at ~252×140 input (~180 tokens) is in the single-digit-GFLOP range, so **target ≈ 5–8 depth fps** — a hypothesis to measure. Depth interpolation/hold (§4) is therefore mandatory.
- **Video decode competes for the same CPU.** Haswell has hardware H.264 decode but **no hardware VP9/AV1**. YouTube's default VP9 would be software-decoded and eat the cores the model needs. Mitigations: an extension option to prefer H.264 streams on this class of machine, and inference on 1–2 threads at below-normal priority so playback never stutters.
- **The render side also runs on that iGPU.** WebGL2 on HD 4400-class must stay light: configurable render scale (e.g. 720p overlay upscaled by the compositor), ray-march steps knob (4/6/8), and a "simple shift" fallback shader. Budget: shader pass ≤ ~4 ms at 720p on the target iGPU.
- **Windows 10** is the likeliest OS on this hardware: support it explicitly in installer and CI.
- **Memory:** many of these machines have 4 GB RAM. Target app working set ≤ ~300 MB.

**Potato tier (replaces the generic one in §4):** DA-V2-S INT8 *or* MiDaS-small, ~192–252 px wide input, 1–2 inference threads, ≥5 depth fps, interpolated to native video fps, app CPU ≤ ~35% on a 2-core part during playback. If DA-V2-S can't meet that, MiDaS-small becomes this tier's default. **Phase 0 exit criterion:** a real Haswell/Broadwell Intel machine holds ≥5 fps depth while playing 720p H.264 without dropping video frames.

---

## 13. DRM streaming sites (Netflix, Disney+, Prime Video…)

You want these supported. The honest picture:

- Widevine/PlayReady video is decrypted and decoded inside a protected pipeline. **`<video>` → canvas/WebGL readback, `tabCapture`, and extension APIs return black frames** for protected content, by design. Defeating that is DRM circumvention; we won't do it, and a Web Store extension that did would be removed.
- **Best-effort path: capture screen/window pixels** (`getDisplayMedia`, or Windows Graphics Capture in the PC app) and run depth on those. On some setups (e.g. software Widevine L3, no hardware-protected overlay) screen capture isn't blocked; on others the OS/GPU driver blanks the protected region. Results vary by site, browser version, GPU and granted resolution tier.
- Even when capture works, the extension **cannot draw 3D into the protected video**; it needs its own overlay (a topmost click-through window from the PC app, or a fullscreen overlay) over the player — window tracking, fullscreen handling, extra latency.
- Everything is processed in memory frame-by-frame; **nothing is recorded, saved or transmitted**. State this in the privacy policy.
- **Public-release risk:** streaming services' terms of service may restrict this, and Web Store review is stricter around DRM-adjacent features. That is a legal/business call. Recommendation: v1 ships with non-DRM sites fully supported; DRM mode ships as **experimental, off-by-default** (Phase 5b), with legal review before enabling it in the store build (it could be PC-app-only instead).
- UX: when DRM is detected (EME in use / black frames), show "Protected video — try experimental screen-capture mode" instead of failing silently.

---

## 14. Plan changes from your answers
- §3.4 / Phase 3: Windows-only; remove macOS/Linux/CoreML tracks.
- §4 / §12: Potato tier = 2014 Intel CPU + iGPU, CPU-first, mandatory depth interpolation, H.264 preference, below-normal-priority inference.
- §5: red/cyan only.
- §13 / new **Phase 5b**: experimental screen-capture mode for DRM sites, gated on legal review.
- Phase 5 (public release) additions: code-signing certificate (SmartScreen reputation), installer with silent auto-update, Chrome Web Store privacy policy and data-use disclosures ("no data leaves the device"), opt-in crash reporting with no video content, Windows 10 / old-hardware support docs, licence audit (Depth Anything V2-S Apache-2.0, ONNX Runtime MIT) with bundled attributions.
- Phase 6: Linux/macOS builds removed.

## 15. Resolved questions
1. **DRM mode:** yes — ship as experimental, off-by-default, pending legal review (Phase 5b).
2. **Test hardware:** the user's own machine is the reference device (see §16).
3. **Pricing:** **free.** Use a permissive open-source licence (MIT or Apache-2.0) for app and extension; no licence-key code; optional donation link only. Free + open source also eases Web Store review and SmartScreen trust. Note: a free product still needs a code-signing certificate to avoid SmartScreen warnings — look at free-for-OSS signing options (e.g. SignPath Foundation) before buying one.

---

## 16. Reference device (measured from the user's Task Manager screenshot)

| Item | Value | Implication |
|---|---|---|
| CPU | Intel Core i3-4160T, Haswell refresh, 3.1 GHz, **2 cores / 4 threads**, 35 W, 3 MB L3 | AVX2/FMA yes; no AVX-512/VNNI. Only 2 physical cores: inference must use **1 thread** (2 at most, only when video is paused or decode is light) |
| iGPU | Intel HD Graphics 4400 | Must run the WebGL2 anaglyph shader; not used for inference by default |
| RAM | 7.9 GB total, **6.6 GB (84%) already in use** | Memory is tight: app working set target **≤ ~200 MB**, model loaded once, no frame backlog; consider memory-mapped ONNX weights |
| OS | **Windows 10** | Confirms Windows 10 as a first-class target |
| CPU load at capture | 82% with other apps running | Real-world headroom is small: inference must back off automatically (adaptive quality, §3.4) when the system is busy |

Consequences for the plan:
- **Phase 0 benchmark target = this exact machine.** Pass criteria: ≥5 depth fps (≈192–252 px input) on 1 inference thread while a 720p H.264 video plays without dropped video frames; app memory ≤ 200 MB; shader pass ≤ ~4 ms at 720p on HD 4400.
- With one thread on one of two cores, DA-V2-S at 252×140 may land below 5 fps — plan for **MiDaS-small / smaller DA-V2-S input (e.g. 196×112) as the default on this machine** and let autotune decide. Fallback if both are too slow: depth every Nth frame + motion-compensated reuse (~2–3 fps real depth).
- Prefer H.264 over VP9/AV1 in the extension on this device class (no hardware VP9 decode on HD 4400).
- Treat 4 GB RAM machines as a stretch goal; this 8 GB machine is the floor for v1.
