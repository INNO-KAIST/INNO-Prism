/* Firebase RTDB REST + SSE 스트리밍을 최소 구현한 목 서버 (동기화 계층 검증용) */
import http from "http";
let DB = {};                 // { lenses: { key: {maker,model,mag,ts} } }
const clients = new Set();
const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
};
const broadcast = (path, data, ev = "put") => {
  const payload = `event: ${ev}\ndata: ${JSON.stringify({ path, data })}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch (e) {} }
};
const srv = http.createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.replace(/\.json$/, "").split("/").filter(Boolean);
  const wantStream = (req.headers.accept || "").includes("text/event-stream");
  if (req.method === "GET" && wantStream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    clients.add(res);
    const node = parts.reduce((o, k) => (o || {})[k], DB);
    res.write(`event: put\ndata: ${JSON.stringify({ path: "/", data: node === undefined ? null : node })}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const node = parts.reduce((o, k) => (o || {})[k], DB);
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(node ?? null)); }
    if (req.method === "PUT" || req.method === "DELETE") {
      const val = req.method === "DELETE" ? null : JSON.parse(body || "null");
      let o = DB;
      for (const k of parts.slice(0, -1)) o = (o[k] = o[k] || {});
      const last = parts[parts.length - 1];
      if (val === null) delete o[last]; else o[last] = val;
      // 스트림 구독자에게 lenses 하위 경로로 알림
      broadcast("/" + parts.slice(1).join("/"), val);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(val));
    }
    res.writeHead(405); res.end();
  });
});
srv.listen(8765, () => console.log("mock RTDB on http://127.0.0.1:8765"));
