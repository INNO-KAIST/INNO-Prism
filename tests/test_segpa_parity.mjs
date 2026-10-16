// SegPA JS ↔ Python reference parity on the 288-scan corpus (576 branches).
// Inputs + Python outputs: tests/segpa_proto/parity_*.json (dump_parity.py).
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const F = require("../src/fit2.js");
const files = ["segpa_proto/parity_0.json", "segpa_proto/parity_144.json", "segpa_proto/parity_synth.json"].map((f) => new URL(f, import.meta.url));
let n = 0, bad = 0, t0 = Date.now(); const worst = [];
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
for (const f of files) for (const c of JSON.parse(fs.readFileSync(f))) {
  n++;
  let js, err = null;
  try { js = F.segPA(c.input.P, c.input.reps ? { reps: c.input.reps } : { I: c.input.I, se: c.input.se }); } catch (e) { err = String(e.message); }
  const py = c.py || [];
  let why = null;
  if (err || c.err) { if (!(err && c.err)) why = `error mismatch js=${err} py=${c.err}`; }
  else if (js.regimes.length !== py.length) why = `nreg js=${js.regimes.length} py=${py.length}`;
  else {
    js.regimes.forEach((q, k) => {
      const p = py[k];
      if (rel(q.head, p.head) > 1e-6 || rel(q.headLo, p.headLo) > 1e-6) why = why || `head ${q.head} vs ${p.head}`;
      if (Math.abs(q.bracket[0] - p.br0) > 1e-9 || Math.abs(q.bracket[1] - p.br1) > 1e-9) why = why || `bracket`;
      if (q.cls !== p.cls || q.status !== p.status || q.kind !== p.kind) why = why || `labels ${q.cls}/${q.status}/${q.kind} vs ${p.cls}/${p.status}/${p.kind}`;
      if ((q.main == null) !== (p.main == null) || (q.main && rel(q.main.slope, p.main) > 1e-6)) why = why || `main ${q.main && q.main.slope} vs ${p.main}`;
    });
  }
  if (why) { bad++; if (worst.length < 12) worst.push(`${c.rel} [${c.branch}] ${why}`); }
}
console.log(`SegPA parity: ${n - bad}/${n} branches identical to Python reference (${((Date.now() - t0) / n).toFixed(1)} ms/branch)`);
worst.forEach((w) => console.log("  ✗", w));
process.exit(bad ? 1 : 0);
