// Isolated-world helper: tells the MAIN-world script whether to hide VP9/AV1 support (for PCs without hardware decode).
(async () => {
  try {
    const { preferH264 } = await chrome.storage.local.get({ preferH264: false });
    document.documentElement.dataset.d3dH264 = preferH264 ? "1" : "0";
    document.dispatchEvent(new CustomEvent("d3d-h264", { detail: !!preferH264 }));
  } catch (_) {}
})();
