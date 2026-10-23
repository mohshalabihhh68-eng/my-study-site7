/**
 * Coursatk Open Proxy (no auth / no Firebase)
 * - Hardcoded COURSATK token
 * - Stream-Weave key unwrap + AES-128 segment decrypt
 * - Built-in HTML test player at /
 * - Permissive host allow for stream URLs
 */
import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "512kb" }));
app.use(compression());

// ═══════════════════════════════════════════════════════════
// CONFIG — open / hardcoded
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  // Fixed token (as requested)
  COURSATK_TOKEN:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  DEFAULT_YEAR_ID: 4,
  // Broad list + runtime learning of hosts from play responses
  STREAM_HOSTS: [
    "api.coursatk.online",
    "stream-weave.com",
    "player.stream-weave.com",
    "floravon.online",
    "floravon.shop",
    "c-cdn.online",
    "cdn.stream-weave.com",
    "media.stream-weave.com",
    "coursatk.online",
    "api.stream-weave.com"
  ],
  STREAM_ORIGIN: "https://coursatk.online",
  STREAM_REFERER: "https://coursatk.online/",
  STREAM_X_REQUESTED_WITH: "com.mycompany.app.soulbrowser",
  STREAM_UA:
    "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  PLAYER_JS: "https://player.stream-weave.com/assets/player.js?v=1.1.1",
  STREAM_SESSION_MS: 30 * 60 * 1000, // 30 min for testing
  MAX_PROXY_BYTES: 20 * 1024 * 1024
};

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════
function now() {
  return Date.now();
}

function jsonError(res, status, message, detail = null) {
  const body = { success: false, message, status };
  if (detail != null) body.detail = detail;
  return res.status(status).json(body);
}

async function getCoursatkToken() {
  return CONFIG.COURSATK_TOKEN;
}

// ═══════════════════════════════════════════════════════════
// Stream sessions (in-memory only)
// ═══════════════════════════════════════════════════════════
const streamSessions = new Map();

function getStreamSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  const last = s.lastUsed || s.createdAt;
  if (now() - last > CONFIG.STREAM_SESSION_MS) {
    streamSessions.delete(id);
    return null;
  }
  s.lastUsed = now();
  return s;
}

// ═══════════════════════════════════════════════════════════
// Stream-Weave decrypt (server-only)
// ═══════════════════════════════════════════════════════════
let decryptPlaybackKeyFn = null;

async function loadDecryptionUtils() {
  const cachePath = path.join(__dirname, "player.stream-weave.cache.js");
  let source = null;
  try {
    if (fs.existsSync(cachePath)) source = fs.readFileSync(cachePath, "utf8");
  } catch {}
  if (!source) {
    console.log("[crypto] fetching player.js…");
    const r = await fetch(CONFIG.PLAYER_JS, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" }
    });
    if (!r.ok) throw new Error(`player.js HTTP ${r.status}`);
    source = await r.text();
    try {
      fs.writeFileSync(cachePath, source);
    } catch {}
  }
  const { webcrypto } = crypto;
  const sandbox = {
    window: {},
    self: {},
    globalThis: {},
    global: {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Date,
    Map,
    Set,
    WeakMap,
    Symbol,
    Proxy,
    Reflect,
    document: {
      createElement: () => ({
        style: {},
        setAttribute() {},
        appendChild() {},
        remove() {}
      }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      querySelector: () => null,
      addEventListener() {}
    },
    navigator: { userAgent: "Node" },
    location: { href: "https://coursatk.online/" },
    HTMLElement: class {},
    HTMLVideoElement: class {},
    MediaSource: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {
      constructor(p) {
        this.p = p;
      }
    },
    fetch: async () => ({ ok: false }),
    XMLHttpRequest: class {
      open() {}
      send() {}
      setRequestHeader() {}
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  vm.runInNewContext(source, sandbox, { timeout: 8000 });
  const du = sandbox.DecryptionUtils;
  if (!du?.decryptPlaybackKey) throw new Error("DecryptionUtils missing");
  decryptPlaybackKeyFn = du.decryptPlaybackKey.bind(du);
  console.log("[crypto] ready");
}

async function unwrapKey(wrappedBuf, videoId) {
  if (!decryptPlaybackKeyFn) throw new Error("crypto not loaded");
  const wrapped = Buffer.isBuffer(wrappedBuf)
    ? new Uint8Array(wrappedBuf)
    : new Uint8Array(wrappedBuf);
  if (wrapped.byteLength === 16) return Buffer.from(wrapped);
  const result = await decryptPlaybackKeyFn(wrapped, String(videoId));
  const key = result?.key;
  if (!key) throw new Error("empty key");
  const aes = Buffer.isBuffer(key)
    ? key
    : key instanceof ArrayBuffer
      ? Buffer.from(key)
      : Buffer.from(key.buffer || key, key.byteOffset || 0, key.byteLength || key.length);
  if (aes.length !== 16) throw new Error(`key len ${aes.length}`);
  return aes;
}

function decryptSegment(encrypted, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function parseIvHex(hex) {
  const h = String(hex || "")
    .replace(/^0x/i, "")
    .trim();
  if (!/^[0-9a-fA-F]{32}$/.test(h)) return null;
  return Buffer.from(h, "hex");
}

function ivFromMediaSequence(seq) {
  const iv = Buffer.alloc(16, 0);
  iv.writeUInt32BE(Number(seq) >>> 0, 12);
  return iv;
}

// Upstream helpers
async function upstreamHeaders(extra = {}) {
  const tok = await getCoursatkToken();
  return {
    Authorization: `Bearer ${tok}`,
    Accept: "application/json",
    ...extra
  };
}

async function upstreamJson(apiPath, options = {}) {
  const url = `${CONFIG.COURSATK_API}${apiPath}`;
  let r;
  try {
    r = await fetch(url, {
      ...options,
      headers: await upstreamHeaders(options.headers || {})
    });
  } catch (e) {
    throw new Error(`Upstream network: ${e.message} | url=${url}`);
  }
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Upstream non-JSON (${r.status}) | body=${text.slice(0, 400)} | url=${url}`
    );
  }
  if (!r.ok) {
    throw new Error(
      `Upstream HTTP ${r.status}: ${data?.message || JSON.stringify(data).slice(0, 300)} | url=${url}`
    );
  }
  return data;
}

/** Very permissive: any https host, or known list + session learned hosts */
function allowedStreamUrl(raw, session = null) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    // For open test mode: allow any https URL
    return true;
  } catch {
    return false;
  }
}

function isMediaCdnHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      /c-cdn\.online$/i.test(h) ||
      /floravon\.(online|shop)$/i.test(h) ||
      /(^|\.)cdn\./i.test(h) ||
      /(^|\.)media\./i.test(h) ||
      /\.woff2(\?|$)/i.test(url) ||
      /\/seg-\d+/i.test(url)
    );
  } catch {
    return false;
  }
}

/** Build headers for upstream stream requests. mode: "full" | "media" | "minimal" */
function buildStreamHeaders(session, url, clientHeaders, extra, mode) {
  const ch = clientHeaders || {};
  const ua = ch["user-agent"] || ch["User-Agent"] || CONFIG.STREAM_UA;
  const headers = {
    Accept: "*/*",
    "User-Agent": ua
  };

  if (mode === "full") {
    // master playlist / key on stream-weave
    headers["Cache-Control"] = "no-cache";
    headers.Origin = CONFIG.STREAM_ORIGIN;
    headers.Referer = CONFIG.STREAM_REFERER;
    headers["X-Requested-With"] = CONFIG.STREAM_X_REQUESTED_WITH;
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  } else if (mode === "media") {
    // CDN segments: query token only — no Authorization (browser doesn't send it)
    headers.Referer = CONFIG.STREAM_REFERER;
    headers.Origin = CONFIG.STREAM_ORIGIN;
    // do NOT set Authorization / X-Requested-With
  } else {
    // minimal: UA + Accept only (last resort on 403)
  }

  for (const name of [
    "sec-ch-ua-platform",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "accept-language"
  ]) {
    const v = ch[name] || ch[name.toLowerCase()];
    if (v) headers[name] = v;
  }
  // media-like fetch metadata when client sent them
  if (mode !== "minimal") {
    if (ch["sec-fetch-site"]) headers["sec-fetch-site"] = ch["sec-fetch-site"];
    if (ch["sec-fetch-mode"]) headers["sec-fetch-mode"] = ch["sec-fetch-mode"];
    if (ch["sec-fetch-dest"]) headers["sec-fetch-dest"] = ch["sec-fetch-dest"];
  }

  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== "") headers[k] = v;
  }
  return headers;
}

async function streamFetch(session, url, extra = {}, clientHeaders = null) {
  if (!allowedStreamUrl(url, session)) {
    throw new Error(`URL غير مسموح: ${url}`);
  }

  const media = isMediaCdnHost(url);
  const modes = media ? ["media", "minimal", "full"] : ["full", "media", "minimal"];

  let lastRes = null;
  let lastErr = null;

  for (const mode of modes) {
    const headers = buildStreamHeaders(session, url, clientHeaders, extra, mode);
    try {
      const r = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
      lastRes = r;
      // success or non-403 error → return (caller handles status)
      if (r.ok || r.status === 206 || r.status !== 403) return r;
      // 403 → try next mode
      console.warn(`[streamFetch] ${r.status} mode=${mode} host=${new URL(url).hostname}`);
      // consume body so connection can close before retry
      try {
        await r.arrayBuffer();
      } catch {}
    } catch (e) {
      lastErr = e;
      console.warn(`[streamFetch] network mode=${mode}: ${e.message}`);
    }
  }

  if (lastRes) return lastRes;
  throw new Error(`streamFetch network: ${lastErr?.message || "unknown"} | ${url}`);
}

// ═══════════════════════════════════════════════════════════
// Built-in HTML test player
// ═══════════════════════════════════════════════════════════
const HTML_PLAYER = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Coursatk Open Catalog</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: system-ui, -apple-system, sans-serif;
      background: #0b0d12; color: #e8eaed; min-height: 100vh;
    }
    header {
      position: sticky; top: 0; z-index: 20;
      background: #12151c; border-bottom: 1px solid #2a2f3a;
      padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    }
    header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; flex: 1; }
    .crumb { font-size: 0.8rem; color: #9aa0a6; width: 100%; }
    .crumb span { cursor: pointer; color: #60a5fa; }
    .crumb span:hover { text-decoration: underline; }
    main { padding: 16px; max-width: 1100px; margin: 0 auto; }
    .toolbar {
      display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center;
    }
    .toolbar select, .toolbar input, .toolbar button {
      padding: 8px 12px; border-radius: 8px; border: 1px solid #3a4050;
      background: #1a1d24; color: #e8eaed; font-size: 0.9rem;
    }
    .toolbar button {
      background: #3b82f6; border: none; cursor: pointer; font-weight: 600;
    }
    .toolbar button:hover { background: #2563eb; }
    .toolbar button.ghost { background: #2a2f3a; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    .item {
      background: #1a1d24; border: 1px solid #2a2f3a; border-radius: 12px;
      overflow: hidden; cursor: pointer; transition: border-color .15s, transform .1s;
      display: flex; flex-direction: column;
    }
    .item:hover { border-color: #3b82f6; transform: translateY(-2px); }
    .item .thumb {
      aspect-ratio: 16/10; background: #0f1218 center/cover no-repeat;
      display: flex; align-items: center; justify-content: center;
      color: #4b5563; font-size: 2rem;
    }
    .item .body { padding: 10px; flex: 1; }
    .item .title { font-size: 0.9rem; font-weight: 600; line-height: 1.3; margin: 0 0 4px; }
    .item .sub { font-size: 0.75rem; color: #9aa0a6; }
    .item.playable .thumb::after {
      content: "▶"; font-size: 1.5rem; color: #fff;
      background: rgba(59,130,246,.75); width: 42px; height: 42px;
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
    }
    .player-box {
      position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 50;
      display: none; flex-direction: column; align-items: center; justify-content: center;
      padding: 16px;
    }
    .player-box.open { display: flex; }
    .player-box .inner {
      width: 100%; max-width: 900px; background: #12151c; border-radius: 12px;
      border: 1px solid #2a2f3a; overflow: hidden;
    }
    .player-box .bar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; border-bottom: 1px solid #2a2f3a;
    }
    .player-box .bar button {
      background: #374151; border: none; color: #fff; padding: 6px 12px;
      border-radius: 6px; cursor: pointer;
    }
    video { width: 100%; aspect-ratio: 16/9; background: #000; display: block; }
    .log {
      font-family: ui-monospace, monospace; font-size: 0.7rem;
      background: #0a0c10; padding: 8px 12px; max-height: 100px; overflow: auto;
      color: #a5b4c8; white-space: pre-wrap; word-break: break-all;
    }
    .empty, .loading, .err-msg {
      text-align: center; padding: 40px 16px; color: #9aa0a6;
    }
    .err-msg { color: #f87171; }
    .ok { color: #4ade80; }
    .err { color: #f87171; }
    .manual {
      margin-top: 24px; padding: 14px; background: #1a1d24; border-radius: 12px;
      border: 1px solid #2a2f3a;
    }
    .manual label { font-size: 0.8rem; color: #9aa0a6; display: block; margin-bottom: 4px; }
    .manual input { width: 100%; padding: 8px; border-radius: 8px; border: 1px solid #3a4050;
      background: #12151a; color: #e8eaed; margin-bottom: 8px; }
  </style>
</head>
<body>
  <header>
    <h1>Coursatk Open Catalog</h1>
    <div class="toolbar" style="margin:0">
      <select id="yearId">
        <option value="4">سنة 4 (افتراضي)</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="5">5</option>
      </select>
      <button id="btnHome" class="ghost">المواد</button>
      <button id="btnStop" class="ghost">إيقاف الفيديو</button>
    </div>
    <div class="crumb" id="crumb">—</div>
  </header>

  <main>
    <div id="content" class="loading">جاري التحميل…</div>

    <div class="manual">
      <label>تشغيل يدوي بـ Video ID</label>
      <div class="toolbar" style="margin:0">
        <input id="manualId" type="text" placeholder="Video ID" style="flex:1;min-width:120px" />
        <button id="btnManual">تشغيل</button>
      </div>
    </div>
  </main>

  <div class="player-box" id="playerBox">
    <div class="inner">
      <div class="bar">
        <span id="playerTitle">—</span>
        <button id="btnClosePlayer">إغلاق</button>
      </div>
      <video id="player" controls playsinline></video>
      <div class="log" id="log"></div>
    </div>
  </div>

  <script>
    const YEAR_DEFAULT = 4;
    const content = document.getElementById("content");
    const crumbEl = document.getElementById("crumb");
    const logEl = document.getElementById("log");
    const video = document.getElementById("player");
    const playerBox = document.getElementById("playerBox");
    let hls = null;
    let stack = []; // navigation stack { type, id, title, data? }

    function log(msg, cls) {
      const t = new Date().toLocaleTimeString();
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = "[" + t + "] " + msg;
      logEl.prepend(line);
    }

    function stop() {
      if (hls) { hls.destroy(); hls = null; }
      video.removeAttribute("src");
      video.load();
    }

    function closePlayer() {
      stop();
      playerBox.classList.remove("open");
    }

    function openPlayer(title) {
      document.getElementById("playerTitle").textContent = title || "فيديو";
      playerBox.classList.add("open");
      logEl.innerHTML = "";
    }

    async function api(path, opts) {
      const r = await fetch(path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || ("HTTP " + r.status));
      return j;
    }

    function renderCrumb() {
      if (!stack.length) {
        crumbEl.innerHTML = "<span data-i=\\"-1\\">المواد</span>";
        return;
      }
      let html = "<span data-i=\\"-1\\">المواد</span>";
      stack.forEach((s, i) => {
        html += " › <span data-i=\\"" + i + "\\">" + escapeHtml(s.title) + "</span>";
      });
      crumbEl.innerHTML = html;
      crumbEl.querySelectorAll("span").forEach((el) => {
        el.onclick = () => {
          const i = Number(el.dataset.i);
          if (i < 0) { stack = []; loadSubjects(); return; }
          stack = stack.slice(0, i + 1);
          const top = stack[stack.length - 1];
          if (top.type === "subject") loadTeachers(top.id, top.title, true);
          else if (top.type === "teacher") loadChapters(top.id, top.title, true);
          else if (top.type === "chapter") loadLectures(top.id, top.title, true);
          else if (top.type === "lecture") loadContent(top.id, top.title, true);
        };
      });
    }

    function escapeHtml(s) {
      return String(s || "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
      );
    }

    function card(opts) {
      const div = document.createElement("div");
      div.className = "item" + (opts.playable ? " playable" : "");
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (opts.image) thumb.style.backgroundImage = "url(" + opts.image + ")";
      else thumb.textContent = opts.icon || "📁";
      const body = document.createElement("div");
      body.className = "body";
      body.innerHTML =
        "<div class=\\"title\\">" + escapeHtml(opts.title) + "</div>" +
        (opts.sub ? "<div class=\\"sub\\">" + escapeHtml(opts.sub) + "</div>" : "");
      div.appendChild(thumb);
      div.appendChild(body);
      div.onclick = opts.onClick;
      return div;
    }

    function showGrid(items) {
      content.innerHTML = "";
      if (!items.length) {
        content.innerHTML = "<div class=\\"empty\\">لا يوجد عناصر</div>";
        return;
      }
      const grid = document.createElement("div");
      grid.className = "grid";
      items.forEach((it) => grid.appendChild(it));
      content.appendChild(grid);
    }

    // ── Catalog navigation ──
    async function loadSubjects() {
      content.innerHTML = "<div class=\\"loading\\">جاري جلب المواد…</div>";
      renderCrumb();
      const yearId = document.getElementById("yearId").value || YEAR_DEFAULT;
      try {
        const j = await api("/api/subjects/" + encodeURIComponent(yearId));
        const list = Array.isArray(j.data) ? j.data : [];
        showGrid(
          list.map((s) =>
            card({
              title: s.name || ("مادة " + s.id),
              sub: "ID: " + s.id,
              image: s.image_url || s.image || null,
              icon: "📚",
              onClick: () => loadTeachers(s.id, s.name || String(s.id))
            })
          )
        );
      } catch (e) {
        content.innerHTML = "<div class=\\"err-msg\\">" + escapeHtml(e.message) + "</div>";
      }
    }

    async function loadTeachers(subjectId, title, keepStack) {
      if (!keepStack) stack = [{ type: "subject", id: subjectId, title: title }];
      content.innerHTML = "<div class=\\"loading\\">جاري جلب المدرسين…</div>";
      renderCrumb();
      try {
        const j = await api("/api/subjects/" + encodeURIComponent(subjectId) + "/teachers");
        // upstream shape varies: data may be object with teachers array, or array
        let list = [];
        const d = j.data;
        if (Array.isArray(d)) list = d;
        else if (d && Array.isArray(d.teachers)) list = d.teachers;
        else if (d && Array.isArray(d.data)) list = d.data;
        else if (d && (d.id || d.name)) list = [d]; // single teacher-ish
        // also try common keys
        if (!list.length && d) {
          for (const k of Object.keys(d)) {
            if (Array.isArray(d[k]) && d[k].length && d[k][0]?.id) {
              list = d[k];
              break;
            }
          }
        }
        showGrid(
          list.map((t) =>
            card({
              title: t.name || t.teacher_name || ("مدرس " + t.id),
              sub: "ID: " + (t.id || t.teacher_id),
              image: t.image_url || t.image || t.avatar || null,
              icon: "👤",
              onClick: () =>
                loadChapters(t.id || t.teacher_id, t.name || t.teacher_name || String(t.id))
            })
          )
        );
        if (!list.length) {
          content.innerHTML =
            "<div class=\\"empty\\">لا مدرسين — رد الـ API:<br><pre style=\\"text-align:right;font-size:11px;overflow:auto\\">" +
            escapeHtml(JSON.stringify(j, null, 2).slice(0, 1500)) +
            "</pre></div>";
        }
      } catch (e) {
        content.innerHTML = "<div class=\\"err-msg\\">" + escapeHtml(e.message) + "</div>";
      }
    }

    async function loadChapters(teacherId, title, keepStack) {
      if (!keepStack) {
        stack = stack.filter((s) => s.type === "subject");
        stack.push({ type: "teacher", id: teacherId, title: title });
      }
      content.innerHTML = "<div class=\\"loading\\">جاري جلب الفصول…</div>";
      renderCrumb();
      try {
        const j = await api("/api/teachers/" + encodeURIComponent(teacherId) + "/chapters");
        let list = Array.isArray(j.data) ? j.data : [];
        if (!list.length && j.data && Array.isArray(j.data.chapters)) list = j.data.chapters;
        showGrid(
          list.map((c) =>
            card({
              title: c.name || c.title || ("فصل " + c.id),
              sub: "ID: " + c.id,
              icon: "📂",
              onClick: () => loadLectures(c.id, c.name || c.title || String(c.id))
            })
          )
        );
        if (!list.length) {
          content.innerHTML =
            "<div class=\\"empty\\">لا فصول — رد:<br><pre style=\\"text-align:right;font-size:11px\\">" +
            escapeHtml(JSON.stringify(j, null, 2).slice(0, 1500)) +
            "</pre></div>";
        }
      } catch (e) {
        content.innerHTML = "<div class=\\"err-msg\\">" + escapeHtml(e.message) + "</div>";
      }
    }

    async function loadLectures(chapterId, title, keepStack) {
      if (!keepStack) {
        stack = stack.filter((s) => s.type === "subject" || s.type === "teacher");
        stack.push({ type: "chapter", id: chapterId, title: title });
      }
      content.innerHTML = "<div class=\\"loading\\">جاري جلب المحاضرات…</div>";
      renderCrumb();
      try {
        const j = await api("/api/chapters/" + encodeURIComponent(chapterId) + "/lectures");
        let list = Array.isArray(j.data) ? j.data : [];
        if (!list.length && j.data && Array.isArray(j.data.lectures)) list = j.data.lectures;
        showGrid(
          list.map((l) =>
            card({
              title: l.name || l.title || ("محاضرة " + l.id),
              sub: "ID: " + l.id,
              icon: "🎬",
              onClick: () => loadContent(l.id, l.name || l.title || String(l.id))
            })
          )
        );
        if (!list.length) {
          content.innerHTML =
            "<div class=\\"empty\\">لا محاضرات — رد:<br><pre style=\\"text-align:right;font-size:11px\\">" +
            escapeHtml(JSON.stringify(j, null, 2).slice(0, 1500)) +
            "</pre></div>";
        }
      } catch (e) {
        content.innerHTML = "<div class=\\"err-msg\\">" + escapeHtml(e.message) + "</div>";
      }
    }

    async function loadContent(lectureId, title, keepStack) {
      if (!keepStack) {
        stack = stack.filter(
          (s) => s.type === "subject" || s.type === "teacher" || s.type === "chapter"
        );
        stack.push({ type: "lecture", id: lectureId, title: title });
      }
      content.innerHTML = "<div class=\\"loading\\">جاري جلب محتوى المحاضرة…</div>";
      renderCrumb();
      try {
        const j = await api("/api/lectures/" + encodeURIComponent(lectureId) + "/content");
        const d = j.data || j;
        // Collect video-like items from various shapes
        let videos = [];
        const pushVid = (v, idx) => {
          if (!v) return;
          const id =
            v.video_id ||
            v.videoId ||
            v.stream_weave_id ||
            v.id ||
            v.content_id ||
            null;
          const name = v.name || v.title || v.file_name || ("فيديو " + (id || idx));
          if (id) videos.push({ id: String(id), name, raw: v });
        };

        if (Array.isArray(d)) d.forEach(pushVid);
        else if (Array.isArray(d.contents)) d.contents.forEach(pushVid);
        else if (Array.isArray(d.videos)) d.videos.forEach(pushVid);
        else if (Array.isArray(d.data)) d.data.forEach(pushVid);
        else if (d.video_id || d.id) pushVid(d);

        // deep scan for objects that look like videos
        if (!videos.length && d && typeof d === "object") {
          const walk = (obj, depth) => {
            if (!obj || depth > 4) return;
            if (Array.isArray(obj)) {
              obj.forEach((x) => walk(x, depth + 1));
              return;
            }
            if (typeof obj === "object") {
              if (
                obj.video_id ||
                obj.stream_weave_id ||
                (obj.type && String(obj.type).toLowerCase().includes("video"))
              ) {
                pushVid(obj);
              }
              for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
            }
          };
          walk(d, 0);
        }

        // dedupe by id
        const seen = new Set();
        videos = videos.filter((v) => {
          if (seen.has(v.id)) return false;
          seen.add(v.id);
          return true;
        });

        if (!videos.length) {
          content.innerHTML =
            "<div class=\\"empty\\">مفيش فيديوهات واضحة — رد الـ API كامل:<br><pre style=\\"text-align:right;font-size:11px;max-height:400px;overflow:auto\\">" +
            escapeHtml(JSON.stringify(j, null, 2).slice(0, 4000)) +
            "</pre><p>انسخ video_id وشغّله من الخانة اليدوية تحت</p></div>";
          return;
        }

        showGrid(
          videos.map((v) =>
            card({
              title: v.name,
              sub: "Video ID: " + v.id,
              icon: "▶️",
              playable: true,
              onClick: () => playVideo(v.id, v.name)
            })
          )
        );
      } catch (e) {
        content.innerHTML = "<div class=\\"err-msg\\">" + escapeHtml(e.message) + "</div>";
      }
    }

    function playManifest(url) {
      stop();
      log("Loading: " + url);
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          log("Manifest OK", "ok");
          video.play().catch((e) => log("play: " + e.message, "err"));
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          log(
            "HLS " + data.type + " " + data.details + " fatal=" + data.fatal,
            data.fatal ? "err" : ""
          );
          if (data.response)
            log(
              "  HTTP " + data.response.code + " " + String(data.response.text || "").slice(0, 100),
              "err"
            );
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.play();
      } else {
        log("HLS not supported", "err");
      }
    }

    async function playVideo(videoId, title) {
      openPlayer(title || ("Video " + videoId));
      log("POST /api/play/" + videoId);
      try {
        const j = await api("/api/play/" + encodeURIComponent(videoId), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" }
        });
        if (!j.success || !j.data?.manifest_url) {
          log("Play failed: " + JSON.stringify(j), "err");
          return;
        }
        log("session=" + j.data.session + " video_id=" + j.data.video_id, "ok");
        playManifest(j.data.manifest_url);
      } catch (e) {
        log("Error: " + e.message, "err");
      }
    }

    document.getElementById("btnHome").onclick = () => {
      stack = [];
      loadSubjects();
    };
    document.getElementById("yearId").onchange = () => {
      stack = [];
      loadSubjects();
    };
    document.getElementById("btnStop").onclick = closePlayer;
    document.getElementById("btnClosePlayer").onclick = closePlayer;
    document.getElementById("btnManual").onclick = () => {
      const id = document.getElementById("manualId").value.trim();
      if (!id) return log("اكتب Video ID", "err");
      playVideo(id, "Video " + id);
    };

    // boot
    loadSubjects();
  </script>
</body>
</html>
`;

// ═══════════════════════════════════════════════════════════
// Routes — open (no auth)
// ═══════════════════════════════════════════════════════════
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coursatk-open-proxy",
    cryptoReady: Boolean(decryptPlaybackKeyFn),
    decryptSegments: true,
    mode: "open-no-auth",
    now: new Date().toISOString()
  });
});

// Built-in HTML player
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML_PLAYER);
});

// Catalog proxies (optional, open)
app.get("/api/subjects/:id", async (req, res) => {
  try {
    const yearId = Number(req.params.id) || CONFIG.DEFAULT_YEAR_ID;
    const data = await upstreamJson(`/user/subjects/${encodeURIComponent(yearId)}`);
    res.json(data);
  } catch (e) {
    console.error("[subjects]", e.message);
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

app.get("/api/subjects/:id/teachers", async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/subjects/${encodeURIComponent(req.params.id)}/teachers`)
    );
  } catch (e) {
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

app.get("/api/teachers/:id/chapters", async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/teachers/${encodeURIComponent(req.params.id)}/chapters`)
    );
  } catch (e) {
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

app.get("/api/chapters/:id/lectures", async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/chapters/${encodeURIComponent(req.params.id)}/lectures`)
    );
  } catch (e) {
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

app.get("/api/lectures/:id/content", async (req, res) => {
  try {
    res.json(
      await upstreamJson(`/user/lectures/${encodeURIComponent(req.params.id)}/content`)
    );
  } catch (e) {
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

// ── Play: get stream-weave token + create local session ──
app.post("/api/play/:videoId", async (req, res) => {
  try {
    const videoId = req.params.videoId;
    console.log("[play] videoId=", videoId);
    const data = await upstreamJson(
      `/video/${encodeURIComponent(videoId)}/stream-weave/play`,
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (!data?.success || !data?.data?.token || !data?.data?.stream_url || !data?.data?.video_id) {
      return jsonError(res, 502, "Playback response ناقص", { upstream: data });
    }
    const id = crypto.randomUUID();
    const host = (() => {
      try {
        return new URL(data.data.stream_url).hostname;
      } catch {
        return null;
      }
    })();
    streamSessions.set(id, {
      id,
      videoId: String(data.data.video_id),
      token: data.data.token,
      streamUrl: data.data.stream_url,
      playId: String(videoId),
      createdAt: now(),
      lastUsed: now(),
      plainKey: null,
      defaultIv: null,
      allowedHosts: host ? new Set([host]) : new Set()
    });
    console.log("[play] session=", id, "stream=", data.data.stream_url);
    res.json({
      success: true,
      data: {
        session: id,
        video_id: data.data.video_id,
        manifest_url: `/api/stream/manifest/${id}`,
        stream_url_raw: data.data.stream_url
      }
    });
  } catch (e) {
    console.error("[play]", e.message);
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

async function refreshPlayback(session) {
  const data = await upstreamJson(
    `/video/${encodeURIComponent(session.playId)}/stream-weave/play`,
    { method: "POST", headers: { Accept: "application/json" } }
  );
  if (!data?.success || !data?.data?.token || !data?.data?.stream_url) {
    throw new Error("فشل تجديد التوكن: " + JSON.stringify(data).slice(0, 200));
  }
  session.token = data.data.token;
  session.streamUrl = data.data.stream_url;
  try {
    session.allowedHosts.add(new URL(session.streamUrl).hostname);
  } catch {}
  session.lastUsed = now();
  console.log(`[refresh] playback token renewed for ${session.videoId}`);
}

app.get("/api/stream/manifest/:sessionId", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    return jsonError(res, 404, "جلسة التشغيل منتهية أو غير موجودة", {
      sessionId: req.params.sessionId,
      activeSessions: streamSessions.size
    });
  }

  try {
    let master = await streamFetch(session, session.streamUrl, {}, req.headers);
    if (master.status === 401 && session.playId) {
      console.log("[manifest] 401 → refresh token");
      await refreshPlayback(session);
      master = await streamFetch(session, session.streamUrl, {}, req.headers);
    }
    if (!master.ok) {
      const body = (await master.text().catch(() => "")).slice(0, 400);
      throw new Error(`Stream master HTTP ${master.status} body=${body}`);
    }
    const masterText = await master.text();
    const lines = masterText.split(/\r?\n/);

    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith("#")) {
          variant = new URL(next, session.streamUrl).href;
          break;
        }
      }
    }

    if (variant) {
      let variantRes = await streamFetch(session, variant, {}, req.headers);
      if (variantRes.status === 401 && session.playId) {
        await refreshPlayback(session);
        variantRes = await streamFetch(session, variant, {}, req.headers);
      }
      if (!variantRes.ok) {
        const body = (await variantRes.text().catch(() => "")).slice(0, 300);
        throw new Error(`Variant HTTP ${variantRes.status} body=${body}`);
      }
      return rewritePlaylist(
        req.params.sessionId,
        session,
        await variantRes.text(),
        variant,
        res,
        req.headers
      );
    }
    return rewritePlaylist(
      req.params.sessionId,
      session,
      masterText,
      session.streamUrl,
      res,
      req.headers
    );
  } catch (e) {
    console.error("[manifest]", e.message);
    jsonError(res, 502, e.message, { stack: e.stack });
  }
});

async function rewritePlaylist(sessionId, session, text, baseUrl, res, clientHeaders) {
  try {
    session.allowedHosts.add(new URL(baseUrl).hostname);
  } catch {}
  const lines = text.split(/\r?\n/);
  const out = [];
  let mediaSeq = 0;
  let currentIv = null;
  let keyFetched = false;

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0;
  }

  let segIndex = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      const ivHex = line.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i)?.[1];
      if (ivHex) currentIv = parseIvHex(ivHex);
      if (uri && !keyFetched && session.plainKey) {
        session.defaultIv = currentIv;
        keyFetched = true;
      } else if (uri && !keyFetched) {
        const keyUrl = new URL(uri, baseUrl).href;
        try {
          session.allowedHosts.add(new URL(keyUrl).hostname);
        } catch {}
        const keyRes = await streamFetch(session, keyUrl, {}, clientHeaders);
        if (!keyRes.ok) {
          const body = (await keyRes.text().catch(() => "")).slice(0, 200);
          throw new Error(`Key HTTP ${keyRes.status} body=${body} url=${keyUrl}`);
        }
        const wrapped = Buffer.from(await keyRes.arrayBuffer());
        session.plainKey = await unwrapKey(wrapped, session.videoId);
        session.defaultIv = currentIv;
        keyFetched = true;
        console.log(`[key] unwrapped for ${session.videoId} len=${session.plainKey.length}`);
      }
      continue; // strip KEY — segments returned plain
    }
    if (line && !line.startsWith("#")) {
      const segmentUrl = new URL(line, baseUrl).href;
      try {
        session.allowedHosts.add(new URL(segmentUrl).hostname);
      } catch {}
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromMediaSequence(seq);
      const payload = Buffer.from(
        JSON.stringify({ u: segmentUrl, iv: iv.toString("hex"), s: seq }),
        "utf8"
      ).toString("base64url");
      out.push(`/api/stream/segment/${sessionId}/${payload}`);
      segIndex++;
      continue;
    }
    out.push(raw);
  }
  if (!session.plainKey) {
    throw new Error("فشل تجهيز مفتاح التشفير (لا يوجد EXT-X-KEY أو فشل unwrap)");
  }

  res.set({
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.send(out.join("\n"));
}

app.get("/api/stream/segment/:sessionId/:encoded", async (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    return jsonError(res, 404, "جلسة التشغيل منتهية", { sessionId: req.params.sessionId });
  }
  if (!session.plainKey) {
    return jsonError(res, 404, "مفتاح غير متاح — أعد طلب المانيفست");
  }

  let meta;
  try {
    meta = JSON.parse(Buffer.from(req.params.encoded, "base64url").toString("utf8"));
  } catch (e) {
    return jsonError(res, 400, "segment meta غير صالح", { err: e.message });
  }
  const url = meta?.u;
  if (!url || !allowedStreamUrl(url, session)) {
    return jsonError(res, 403, "رابط غير مسموح", { url });
  }

  const iv = parseIvHex(meta.iv) || session.defaultIv || ivFromMediaSequence(meta.s || 0);
  try {
    // Prefer no Range on first segment fetch — some CDNs 403 ranged requests from datacenter IPs
    const upstream = await streamFetch(session, url, {}, req.headers);
    if (!upstream.ok && upstream.status !== 206) {
      const body = (await upstream.text().catch(() => "")).slice(0, 400);
      const info = {
        status: upstream.status,
        host: new URL(url).hostname,
        server: upstream.headers.get("server"),
        cfRay: upstream.headers.get("cf-ray"),
        cfMitigated: upstream.headers.get("cf-mitigated"),
        body: body.slice(0, 200)
      };
      console.error("[segment-fail]", info);
      throw new Error(
        `Segment HTTP ${upstream.status} host=${info.host} cf=${info.cfRay || "-"} body=${info.body}`
      );
    }
    const encrypted = Buffer.from(await upstream.arrayBuffer());
    if (encrypted.length > CONFIG.MAX_PROXY_BYTES) {
      return jsonError(res, 413, "المقطع كبير", { len: encrypted.length });
    }
    let plain;
    try {
      plain = decryptSegment(encrypted, session.plainKey, iv);
    } catch (decErr) {
      console.warn("[segment-decrypt-fail]", {
        host: new URL(url).hostname,
        len: encrypted.length,
        err: decErr.message
      });
      // fallback: send encrypted (may fail to play)
      plain = encrypted;
    }
    res.status(200);
    res.set({
      "Content-Type": "video/mp2t",
      "Content-Length": String(plain.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(plain);
  } catch (e) {
    console.error("[segment]", e.message);
    if (!res.headersSent) jsonError(res, 502, e.message, { stack: e.stack });
    else res.end();
  }
});

// Fallback
app.use((req, res) => {
  jsonError(res, 404, "المسار غير موجود", { path: req.path });
});

// Cleanup
setInterval(() => {
  const t = now();
  for (const [k, s] of streamSessions) {
    if (t - (s.lastUsed || s.createdAt) > CONFIG.STREAM_SESSION_MS) {
      streamSessions.delete(k);
    }
  }
}, 60_000).unref();

// Boot
await loadDecryptionUtils();

app.listen(CONFIG.PORT, () => {
  console.log(`[OPEN] http://localhost:${CONFIG.PORT}`);
  console.log(`[OPEN] HTML player at /  |  health at /health`);
  console.log(`[OPEN] token hardcoded · no Firebase · no auth`);
});
