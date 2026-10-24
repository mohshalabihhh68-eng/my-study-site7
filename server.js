import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "512kb" }));
app.use(compression());

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  FIREBASE: "https://my-platform-e46a6-default-rtdb.europe-west1.firebasedatabase.app",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin123",
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN: process.env.COURSATK_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  STREAM_UA: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  CODE_TYPES: {
    trial: { label: "تجربة", ms: 1 * 3600 * 1000 },
    month: { label: "شهر", ms: 30 * 24 * 3600 * 1000 },
    term:  { label: "ترم", ms: 180 * 24 * 3600 * 1000 },
    year:  { label: "سنة", ms: 365 * 24 * 3600 * 1000 }
  },
  STUDENT_SESSION_MS: 7 * 24 * 3600 * 1000,
  ADMIN_SESSION_MS: 12 * 3600 * 1000,
};

// Firebase REST
async function fbGet(p) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${p} → ${r.status}`);
  return r.json();
}
async function fbSet(p, data) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PUT ${p} → ${r.status}`);
  return r.json();
}
async function fbPatch(p, data) {
  const r = await fetch(`${CONFIG.FIREBASE}/${p}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${p} → ${r.status}`);
  return r.json();
}
async function fbDelete(p) {
  await fetch(`${CONFIG.FIREBASE}/${p}.json`, { method: "DELETE" });
  return true;
}

const now = () => Date.now();
const randomToken = (b = 32) => crypto.randomBytes(b).toString("base64url");
const randomCode7 = () => String(Math.floor(1000000 + Math.random() * 9000000));

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

const studentSessions = new Map();
const adminSessions = new Map();

async function requireStudent(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return jsonError(res, 401, "مطلوب تسجيل الدخول");
    let sess = studentSessions.get(token);
    if (!sess) {
      const remote = await fbGet(`sessions/${token}`);
      if (!remote) return jsonError(res, 401, "جلسة غير صالحة");
      sess = remote;
      studentSessions.set(token, sess);
    }
    if (sess.expiresAt && now() > sess.expiresAt) return jsonError(res, 401, "انتهت الجلسة");
    const student = await fbGet(`students/${sess.code}`);
    if (!student || student.active === false) return jsonError(res, 401, "الحساب موقوف");
    if (student.expiresAt && now() > student.expiresAt) return jsonError(res, 403, "انتهت الصلاحية");
    req.student = student;
    req.session = sess;
    req.sessionToken = token;
    next();
  } catch (e) { jsonError(res, 500, e.message); }
}

function requireAdmin(req, res, next) {
  const token = getBearer(req);
  if (!token) return jsonError(res, 401, "مطلوب دخول الأدمن");
  const sess = adminSessions.get(token);
  if (!sess) return jsonError(res, 401, "جلسة أدمن غير صالحة");
  req.adminSession = sess;
  req.adminToken = token;
  next();
}

// مساعد كورساتك
async function upstreamJson(apiPath, options = {}, req = null) {
  const clientAuth = req?.headers?.authorization || "";
  let tokenToUse = CONFIG.COURSATK_TOKEN;
  if (clientAuth.startsWith("Bearer ")) tokenToUse = clientAuth.slice(7).trim();

  const r = await fetch(`${CONFIG.COURSATK_API}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenToUse}`,
      Accept: "application/json",
      Origin: "https://coursatk.online",
      Referer: "https://coursatk.online/",
      "User-Agent": CONFIG.STREAM_UA,
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Upstream non-JSON (${r.status})`); }
  if (!r.ok) throw new Error(data?.message || `Upstream HTTP ${r.status}`);
  return data;
}

// Auth Routes
app.post("/api/auth/login", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!/^\d{7}$/.test(code)) return jsonError(res, 400, "الكود 7 أرقام");
    const student = await fbGet(`students/${code}`);
    if (!student || student.active === false) return jsonError(res, 401, "كود غير صحيح");
    if (student.expiresAt && now() > student.expiresAt) return jsonError(res, 403, "انتهت الصلاحية");
    
    const token = randomToken(32);
    const sess = { token, code, deviceId, name: student.name, expiresAt: now() + CONFIG.STUDENT_SESSION_MS };
    studentSessions.set(token, sess);
    await fbSet(`sessions/${token}`, sess);
    res.json({ success: true, data: { token, student: { name: student.name, code } } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/auth/logout", requireStudent, async (req, res) => {
  studentSessions.delete(req.sessionToken);
  await fbDelete(`sessions/${req.sessionToken}`);
  res.json({ success: true });
});

app.get("/api/auth/me", requireStudent, (req, res) => {
  res.json({ success: true, data: { name: req.student.name } });
});

// Course Routes (Proxy)
app.get("/api/years", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson("/user/years", {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/subjects/:id", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/subjects/${req.params.id}`, {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/subjects/:id/teachers", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/subjects/${req.params.id}/teachers`, {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/teachers/:id/chapters", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/teachers/${req.params.id}/chapters`, {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/chapters/:id/lectures", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/chapters/${req.params.id}/lectures`, {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/lectures/:id/content", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson(`/user/lectures/${req.params.id}/content`, {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

app.get("/api/profile", requireStudent, async (req, res) => {
  try { res.json(await upstreamJson("/user/profile", {}, req)); } catch (e) { jsonError(res, 502, e.message); }
});

// Admin Routes
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== CONFIG.ADMIN_USERNAME || password !== CONFIG.ADMIN_PASSWORD) return jsonError(res, 401, "بيانات خطأ");
  const token = randomToken(32);
  adminSessions.set(token, { username, expiresAt: now() + CONFIG.ADMIN_SESSION_MS });
  res.json({ success: true, data: { token, username } });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  adminSessions.delete(req.adminToken);
  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, data: { username: req.adminSession.username } });
});

app.get("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const all = (await fbGet("students")) || {};
    const list = Object.entries(all).map(([code, s]) => ({
      code, name: s.name, expiresAt: s.expiresAt, active: s.active !== false
    }));
    res.json({ success: true, data: list });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const { name, type, code: customCode } = req.body;
    if (!name) return jsonError(res, 400, "الاسم مطلوب");
    let code = customCode;
    if (!code) {
      for (let i = 0; i < 30; i++) {
        code = randomCode7();
        if (!(await fbGet(`students/${code}`))) break;
      }
    }
    const record = { name, type, active: true, createdAt: now(), expiresAt: now() + (CONFIG.CODE_TYPES[type]?.ms || 2592000000) };
    await fbSet(`students/${code}`, record);
    res.json({ success: true, data: { code, ...record } });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.delete("/api/admin/students/:code", requireAdmin, async (req, res) => {
  try {
    await fbDelete(`students/${req.params.code}`);
    res.json({ success: true });
  } catch (e) { jsonError(res, 500, e.message); }
});

// Static Serving
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ success: false, message: "Not found" });
  if (req.path.endsWith(".html")) return res.sendFile(path.join(__dirname, "public", req.path));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
});
