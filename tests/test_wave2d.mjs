import h5wasm from "h5wasm/node";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = require(join(here, "..", "src", "h5layer.js"));
import { openH5 } from "./h5open.mjs";
const Module = await h5wasm.ready;
// 저장소에 있는 것만 본다. 실측 파일이 있으면 절대경로를 이 배열에 더하면 된다.
const cand = [join(here, "testdata", "synth_wave2d.h5")];
const files = cand.filter((f) => fs.existsSync(f));
if (!files.length) { console.log("SKIP — testdata/synth_wave2d.h5 없음"); process.exit(0); }
for (const fn of files) {
  const f = openH5(h5wasm, Module, fn);
  const det = H.detectType(f);
  console.log(fn.split("/").pop(), "→", det.type, det.scanGroup || "");
  if (det.type === "scan2d") {
    const w = H.extractWaveScan(f, det.tree, det.scanGroup);
    if (w) {
      console.log("  wave grid:", w.y.length + "×" + w.x.length, "signals:", w.signals.map(s => `${s.name}(used ${s.nUsed}, out ${s.nOut})`).join(", "));
      const s = w.signals[0];
      // peak location check
      let mx = -1, py = 0, px = 0;
      for (let y = 0; y < w.y.length; y++) for (let x = 0; x < w.x.length; x++) {
        const v = s.z[y][x]; if (v !== null && v > mx) { mx = v; py = y; px = x; }
      }
      console.log("  peak at h=" + w.x[px] + " v=" + w.y[py] + " val=" + mx.toFixed(0), "(truth h=166 v=131)");
      const empty = s.z.flat().filter(v => v === null).length;
      console.log("  empty bins:", empty);
    } else console.log("  no wave reconstruction (direct maps only)");
    const maps = H.extract2DMaps(f, det.tree, det.scanGroup);
    console.log("  direct maps:", maps.map(m => m.path.split("/").pop() + (m.slice !== undefined ? `[${m.slice}]` : "")).join(", ") || "none");
  }
  f.close();
}
