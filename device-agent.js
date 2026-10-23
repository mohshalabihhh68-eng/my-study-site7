/**
 * وكيل محلي على جهازك — يطلب floravon من IP العادي (يتجنب CF داتا سنتر)
 * ويعيد المقطع للصفحة مع CORS مفتوح.
 *
 * تشغيل:
 *   node device-agent.js
 *
 * الصفحة على Railway هتتصل بـ http://127.0.0.1:3921
 */
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.AGENT_PORT || 3921);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (u.pathname === "/health" || u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent: "device-agent", port: PORT }));
    return;
  }

  if (u.pathname === "/proxy") {
    const target = u.searchParams.get("url");
    if (!target || !/^https:\/\//i.test(target)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "url مطلوب (https)" }));
      return;
    }
    // أمان بسيط: floravon / stream-weave / coursak فقط
    let host = "";
    try {
      host = new URL(target).hostname;
    } catch {
      res.writeHead(400);
      res.end("bad url");
      return;
    }
    if (
      !/floravon\.(shop|online)$/i.test(host) &&
      !/stream-weave\.com$/i.test(host) &&
      !/coursatk\.online$/i.test(host)
    ) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "host غير مسموح" }));
      return;
    }

    try {
      const up = await fetch(target, {
        headers: {
          Accept: "*/*",
          "User-Agent": UA,
          Origin: "https://api.stream-weave.com",
          Referer: "https://api.stream-weave.com/",
          "Accept-Language": "ar,en;q=0.9"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(60000)
      });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, {
        "Content-Type": up.headers.get("content-type") || "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=60"
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: e.message || "proxy fail" }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[device-agent] http://127.0.0.1:${PORT}`);
  console.log(`[device-agent] افتح الموقع واترك النافذة دي مفتوحة أثناء التشغيل`);
});
