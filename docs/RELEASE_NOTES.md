## What this is
Real-time red/cyan anaglyph 3D for web video. A Chrome extension grabs small frames from the playing video, a local Windows app
estimates depth with Depth Anything V2 Small, and the extension turns that depth into a stereo pair + red/cyan image with WebGL2.
Free and open source (MIT). Nothing leaves your computer.

## Install
1. Download **3D-Viewing-App-Windows-x64.zip**, unzip it anywhere, run `3D-Viewing.exe` and keep the window open.
2. Download **3D-Viewing-Chrome-Extension.zip**, unzip it, open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, choose the folder.
3. Open a video, click the extension, switch it on (hotkey Alt+Shift+3). Red lens = left eye.

Verify downloads with `SHA256SUMS.txt`.

## Known limitations of this first release (v0.1.x)
- **Not yet measured on real old hardware.** The design targets a 2014 Intel dual-core (e.g. i3-4160T + HD 4400): one inference thread, automatic model-resolution tuning, depth interpolated to full frame rate. Actual frame rates on that class of machine are unverified – please report numbers.
- DRM sites (Netflix etc.) are **not supported** yet; the experimental screen-capture mode is only planned.
- The extension is installed unpacked (not yet on the Chrome Web Store) and the exe is unsigned, so Windows SmartScreen may warn on first run.
- Windows only. Chrome/Chromium-based browsers only.
