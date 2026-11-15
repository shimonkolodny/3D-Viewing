// MAIN-world: when enabled, report VP9/AV1 as unsupported so sites pick H.264 (hardware decoded on 2014-era Intel GPUs).
(() => {
  let on = document.documentElement.dataset.d3dH264 === "1";
  document.addEventListener("d3d-h264", (e) => { on = !!e.detail; });
  const bad = /vp0?9|av0?1|vp8/i;
  const wrap = (obj, name) => {
    const orig = obj && obj[name];
    if (!orig) return;
    obj[name] = function (type, ...rest) {
      if (on && typeof type === "string" && bad.test(type)) return name === "canPlayType" ? "" : false;
      return orig.call(this, type, ...rest);
    };
  };
  try { wrap(window.MediaSource, "isTypeSupported"); } catch (_) {}
  try { wrap(HTMLMediaElement.prototype, "canPlayType"); } catch (_) {}
})();
