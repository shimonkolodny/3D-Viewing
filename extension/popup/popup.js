const DEFAULTS = { enabled: false, strength: 2.0, convergence: 0.4, swapEyes: false, mode: "dubois", quality: "medium", preferH264: false };
const $ = (id) => document.getElementById(id);

async function init() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $("enabled").checked = s.enabled;
  for (const k of ["strength", "convergence"]) { $(k).value = s[k]; show(k); }
  for (const k of ["mode", "quality"]) $(k).value = s[k];
  for (const k of ["swapEyes", "preferH264"]) $(k).checked = s[k];

  $("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
  for (const k of ["strength", "convergence"]) $(k).oninput = (e) => { show(k); chrome.storage.local.set({ [k]: parseFloat(e.target.value) }); };
  for (const k of ["mode", "quality"]) $(k).onchange = (e) => chrome.storage.local.set({ [k]: e.target.value });
  for (const k of ["swapEyes", "preferH264"]) $(k).onchange = (e) => chrome.storage.local.set({ [k]: e.target.checked });
  chrome.storage.onChanged.addListener((ch) => { if (ch.enabled) $("enabled").checked = ch.enabled.newValue; });
  poll(); setInterval(poll, 1500);
}
function show(k) { $(k + "Out").textContent = k === "strength" ? parseFloat($(k).value).toFixed(1) + "%" : Math.round($(k).value * 100) + "%"; }

async function poll() {
  const st = $("status");
  const enabled = $("enabled").checked;
  let r = null;
  try { r = await chrome.runtime.sendMessage({ t: "getState" }); } catch (_) {}
  if (r && r.connected) { st.className = "status ok"; st.textContent = "PC app connected. Play a video and put your glasses on (red = left eye)."; }
  else if (!enabled) { st.className = "status warn"; st.textContent = "Off. Turn it on, then start the 3D Viewing PC app."; }
  else { st.className = "status bad"; st.textContent = "PC app not running. Start “3D Viewing” on your computer (download link below)."; }
}
init();
