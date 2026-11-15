# 3D Viewing

Realtime **red/cyan anaglyph 3D for any web video**, designed to run on old hardware (target: 2014 Intel dual-core + HD 4400).

```
Chrome extension  ──small frames──▶  PC app (Depth Anything V2 Small, ONNX Runtime, CPU)
       ▲                                         │
       └────────── 8-bit depth maps ◀────────────┘
 extension builds the left/right views + anaglyph in a WebGL2 shader at full video resolution
```

* `app/` – Windows PC app (Python, ONNX Runtime). Local WebSocket server on `127.0.0.1:38475`, autotunes the model resolution, runs at below-normal priority, 1 inference thread.
* `extension/` – Chrome MV3 extension: video detection, capture, WebGL2 renderer (depth-guided upsampling, backward-warp view synthesis, Dubois red/cyan), popup controls.
* `tests/e2e` – real-Chromium end-to-end test; `app/tests` – unit + WebSocket tests; `tools/smoke_test.py` – packaged-exe smoke test.
* `plan.md` – design, decisions and roadmap.

## Use
Download the latest build from [Releases](../../releases/latest): the app zip and the extension zip. See `docs/APP-README.txt`.

## Develop
```bash
pip install -r app/requirements.txt pytest
python -m pytest app/tests                 # unit tests
DEPTH_MODEL=path/to/model.onnx python -m pytest app/tests   # + real-model WebSocket test
python -m depth3d_app --no-gui             # run the app (downloads the model on first run)
```
Load `extension/` via `chrome://extensions` → Load unpacked.

Releases are built by GitHub Actions (`.github/workflows/release.yml`): run the workflow with a version, or push a `v*` tag.

## Licence
MIT. Model: Depth Anything V2 Small (Apache-2.0) – see `THIRD-PARTY-NOTICES.md`.
