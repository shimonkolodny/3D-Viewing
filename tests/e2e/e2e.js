// End-to-end: real Chromium + the unpacked extension + the real depth app + a local test video.
// usage: node e2e.js <extensionDir> <videoDir> <outDir> [appPort]
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const [extDir, vidDir, outDir] = process.argv.slice(2);
const log = (...a) => console.log("[e2e]", ...a);

(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(vidDir, req.url === "/" ? "index.html" : req.url.split("?")[0]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const type = f.endsWith(".webm") ? "video/webm" : "text/html";
    const data = fs.readFileSync(f);
    const range = req.headers.range;
    if (range) { // Chromium needs range support for looping video
      const m = /bytes=(\d+)-(\d*)/.exec(range); const s = +m[1], e = m[2] ? +m[2] : data.length - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${s}-${e}/${data.length}`, "Accept-Ranges": "bytes", "Content-Length": e - s + 1 });
      return res.end(data.subarray(s, e + 1));
    }
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": data.length }); res.end(data);
  }).listen(8123);

  const ctx = await chromium.launchPersistentContext(path.join(outDir, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
           "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 800, height: 450 },
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  log("service worker up:", sw.url());
  const page = await ctx.newPage();
  page.on("console", (m) => { if (/3D Viewing|d3d/i.test(m.text())) log("page:", m.text()); });
  page.on("pageerror", (e) => log("pageerror:", e.message));
  await page.goto("http://127.0.0.1:8123/");
  await page.waitForTimeout(1500);

  // 1. disabled by default: no overlay
  let n = await page.locator("canvas[data-d3d]").count();
  log("overlay canvases while disabled:", n);
  if (n !== 0) throw new Error("overlay present while disabled");
  await page.screenshot({ path: path.join(outDir, "plain.png") });

  // 2. enable via storage (same path the popup uses)
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  let shown = false;
  for (let i = 0; i < 60 && !shown; i++) {
    await page.waitForTimeout(500);
    shown = await page.evaluate(() => { const c = document.querySelector("canvas[data-d3d]"); return !!c && c.style.display === "block"; });
  }
  log("overlay visible after enable:", shown);
  if (!shown) throw new Error("overlay never appeared (no depth received?)");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "anaglyph.png") });

  // 3. analyse the *screenshot* (a WebGL canvas can't be read back after compositing): an anaglyph shows red/cyan fringing
  //    (left/right eye views differ), the plain video does not.
  const analyse = async (file) => {
    const b64 = fs.readFileSync(file).toString("base64");
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const t = document.createElement("canvas"); t.width = 640; t.height = 360;
      const x = t.getContext("2d"); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, 640, 360).data;
      let diff = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { diff += Math.abs(d[i] - d[i + 1]); n++; }
      return diff / n;
    }, b64);
  };
  const plainScore = await analyse(path.join(outDir, "plain.png")), anaScore = await analyse(path.join(outDir, "anaglyph.png"));
  const stats = { plainScore, anaScore, nonBlack: 1, meanRedVsCyan: Math.abs(anaScore - plainScore) };
  log("red-vs-green mismatch plain/anaglyph:", plainScore.toFixed(2), anaScore.toFixed(2));
  const badge = await sw.evaluate(async () => { const tabs = await chrome.tabs.query({}); return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id }))); });
  log("badges:", JSON.stringify(badge));

  // 4. disabling removes the overlay again
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.waitForTimeout(1200);
  n = await page.locator("canvas[data-d3d]").count();
  log("overlay canvases after disable:", n);
  await ctx.close(); srv.close();
  if (n !== 0) throw new Error("overlay not removed");
  if (!(stats.meanRedVsCyan > 0.5)) throw new Error("overlay does not look like an anaglyph");
  log("PASS");
})().catch((e) => { console.error("[e2e] FAIL", e); process.exit(1); });
