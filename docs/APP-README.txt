3D VIEWING – PC app
===================

1. Run 3D-Viewing.exe (a small status window opens). Keep it open – minimise it – while you watch.
2. Install the "3D Viewing" Chrome extension (see the extension zip: chrome://extensions -> Developer mode -> Load unpacked).
3. Open a video (YouTube, Vimeo, etc.), click the extension icon, switch it on, put on red/cyan glasses (red = left eye).

Everything runs on your own PC. Video frames go only to this app on 127.0.0.1 and are never saved or sent anywhere.

Tips for older PCs
  * Extension popup -> "Render quality: Low" and enable "Prefer H.264 video" (then reload the page).
  * The app picks a model resolution automatically for your CPU and lowers it if the PC gets busy.
  * Close other heavy programs while watching. The app runs at below-normal priority so playback stays smooth.

If the app does not start: install the "Microsoft Visual C++ Redistributable (x64)" from Microsoft, then try again.
A log is kept at %APPDATA%\3D-Viewing\3d-viewing.log

Not supported: DRM-protected video (Netflix, Disney+, Prime Video...). Browsers do not let extensions read those frames.
