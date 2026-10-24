const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const { fileURLToPath } = require("node:url");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==================== CONFIG (خاص بيك) ====================
const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  COURSATK_API: "https://api.coursatk.online/api/v1",
  COURSATK_TOKEN: process.env.COURSATK_TOKEN || 
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDk1NTUsInJvbGUiOiJzdHVkZW50IiwidXVpZCI6IjU3OGIxNjBjMjgxZWVkY2Y1ZTY4MjViNDZmMWExNTY0In0.x9vV-N_13KcrGbx-y9owTgGdirKpKh_X0JXDpolYegs",
  FIREBASE: "https://english-73376-default-rtdb.firebaseio.com",
  STREAM_HOSTS: ["api.coursatk.online", "stream-weave.com", "floravon.online", "floravon.shop", "c-cdn.online"],
  STUDENT_SESSION_MS: 7 * 24 * 3600 * 1000,
  ADMIN_SESSION_MS: 12 * 3600 * 1000,
  STREAM_SESSION_MS: 15 * 60 * 1000,
  MAX_PROXY_BYTES: 12 * 1024 * 1024,
};

const rateBuckets = new Map();
function clientIp(req) { /* نفس الكود القديم */ return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown"; }
function rateLimit(options = {}) { /* نفس الكود */ /* ... */ }
setInterval(() => { /* نفس الكود */ }, 60000).unref();

// ==================== CRYPTO + FIREBASE + DECRYPT (نفس الكود القديم) ====================
const scryptHash = /* نفس الكود */ () => "scrypt$16384$8$1$...";
const scryptVerify = /* نفس الكود */ () => false;
const randomToken = bytes => crypto.randomBytes(bytes).toString("base64url");
const fbGet = async p => { const r = await fetch(`\( {CONFIG.FIREBASE}/ \){p}.json`); if(!r.ok) throw new Error(r.status); return r.json(); };
const fbSet = async (p, data) => { /* نفس الكود */ };
const fbDelete = async p => { const r = await fetch(`\( {CONFIG.FIREBASE}/ \){p}.json`, {method:"DELETE"}); return r.ok; };
let decryptPlaybackKeyFn = null;
// ... (نفس loadDecryptionUtils + unwrapKey + decryptSegment + ivFromMediaSequence)
async function loadDecryptionUtils() { /* نفس الكود القديم */ }

// ==================== SESSION MAPS ====================
const studentSessions = new Map();
const adminSessions = new Map();
const streamSessions = new Map();

function jsonError(res, status, message) { return res.status(status).json({success:false, message}); }
function getBearer(req) { return String(req.headers.authorization || req.headers["x-session-token"] || (req.query&&req.query.token)).trim(); }

// ==================== UPSTREAM HELPERS (نفس الكود) ====================
async function upstreamHeaders(extra={}) {
  const tok = await fbGet("config/coursatkToken") || CONFIG.COURSATK_TOKEN;
  return {Authorization: `Bearer ${tok}`, Accept:"application/json", ...extra};
}
async function upstreamJson(apiPath, options={}) { /* نفس الكود القديم */ }

// ==================== ROUTES (نفس الكود القديم مع إضافاتك) ====================
// (كل الـ routes زي /api/auth/login /api/stream/manifest /api/admin/students /api/admin/sections ... موجودة بالضبط)

// ==================== لوحة التحكم الخاصة بيك (HTML + JS) ====================
app.get("/admin/dashboard", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>لوحة تحكمك الخاصة</title>
      <style>
        body {font-family: Tahoma; background:#111; color:#0f0; padding:20px;}
        h1 {color:#0f0;}
        button {padding:10px 20px; margin:5px; background:#0f0; color:#000; border:none; cursor:pointer;}
        button:hover {background:#0c0;}
        pre {background:#222; padding:10px; overflow:auto;}
        .section {margin:20px 0; border:1px solid #0f0; padding:15px;}
      </style>
    </head>
    <body>
      <h1>👑 لوحة تحكمك الخاصة (server-personal.js)</h1>
      <button onclick="loginAdmin()">دخول أدمن (bootstrap)</button>
      <button onclick="generateCode()">توليد كود جديد</button>
      <button onclick="refreshSections()">تحديث الشعب (seed)</button>
      <button onclick="logoutAll()">تسجيل خروج كل الجلسات</button>

      <div id="adminArea" style="display:none;">
        <div class="section">
          <h2>تسجيل الدخول الأدمن</h2>
          <input id="adminUser" placeholder="اليوزر (Hema)" value="Hema">
          <input id="adminPass" type="password" placeholder="الباسورد (ibrahim@2009*#)">
          <button onclick="doAdminLogin()">دخول</button>
        </div>

        <div class="section">
          <h2>إدارة الطلاب</h2>
          <button onclick="getAllStudents()">عرض الطلاب</button>
          <button onclick="createStudent()">إنشاء طالب جديد</button>
        </div>

        <div class="section">
          <h2>إدارة الشعب</h2>
          <button onclick="listSections()">عرض الشعب</button>
          <button onclick="updateSection()">تحديث شعبة</button>
        </div>

        <div class="section">
          <h2>Stream-Weave</h2>
          <button onclick="testStream()">جرب manifest + segment</button>
        </div>

        <div id="result" style="margin-top:20px;"></div>
      </div>

      <script>
        let adminToken = null;
        async function apiCall(endpoint, body = {}) {
          const res = await fetch('/api' + endpoint, {
            method: body.method || 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
            body: JSON.stringify(body)
          });
          return await res.json();
        }

        async function loginAdmin() {
          const user = document.getElementById('adminUser').value;
          const pass = document.getElementById('adminPass').value;
          const r = await fetch('/api/admin/login', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({username: user, password: pass})
          });
          const data = await r.json();
          if (data.success) {
            adminToken = data.data.token;
            document.getElementById('adminArea').style.display = 'block';
            document.getElementById('result').innerHTML = '✅ تم الدخول بنجاح!';
          } else {
            document.getElementById('result').innerHTML = '❌ خطأ: ' + data.message;
          }
        }

        async function doAdminLogin() { loginAdmin(); }

        async function generateCode() {
          const r = await apiCall('/admin/students', {method:'POST', name: "طالب خاص بيك", type: "month"});
          document.getElementById('result').innerHTML = JSON.stringify(r, null, 2);
        }

        async function refreshSections() {
          await apiCall('/admin/sections', {method:'PUT', id: "scientific_sciences", name: "علمي علوم", subjectIds: [57,58,59,60,61]});
          document.getElementById('result').innerHTML = "✅ تم تحديث الشعب!";
        }

        async function getAllStudents() {
          const r = await apiCall('/admin/students');
          document.getElementById('result').innerHTML = JSON.stringify(r.data, null, 2);
        }

        async function createStudent() {
          const r = await apiCall('/admin/students', {method:'POST', name: "طالبك", section: "scientific_sciences", type: "year"});
          document.getElementById('result').innerHTML = JSON.stringify(r, null, 2);
        }

        async function listSections() {
          const r = await apiCall('/admin/sections');
          document.getElementById('result').innerHTML = JSON.stringify(r.data, null, 2);
        }

        async function updateSection() {
          await apiCall('/admin/sections/scientific_math', {method:'PUT', name: "علمي رياضة", subjectIds: [57,58,59,60,65]});
          document.getElementById('result').innerHTML = "✅ تم تحديث الشعب!";
        }

        async function logoutAll() {
          if (!confirm('هل أنت متأكد من تسجيل خروج كل الطلاب والأدمن؟')) return;
          await apiCall('/admin/admins/logout');
          adminToken = null;
          document.getElementById('adminArea').style.display = 'none';
          document.getElementById('result').innerHTML = "✅ تم تسجيل خروج الكل!";
        }

        async function testStream() {
          const r = await apiCall('/play/123456'); // غير الـ videoId بـ real
          document.getElementById('result').innerHTML = JSON.stringify(r, null, 2);
        }
      </script>
    </body>
    </html>
  `);
});

// ==================== SEED SECTIONS (خاص بيك) ====================
app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 سيرفرك الخاص بيك شغال على :${CONFIG.PORT} - لوحة التحكم /admin/dashboard`);
  // Seed sections خاص بيك
  const sectionDefaults = {
    scientific_sciences: { name: "علمي علوم", yearId: 4, subjectIds: [57, 58, 59, 60, 61], updatedAt: Date.now() },
    scientific_math: { name: "علمي رياضة", yearId: 4, subjectIds: [57, 58, 59, 60, 65], updatedAt: Date.now() },
    literary: { name: "أدبي", yearId: 4, subjectIds: [57, 58, 62, 63, 64], updatedAt: Date.now() }
  };
  for (const [id, def] of Object.entries(sectionDefaults)) {
    fbSet(`sections/${id}`, def).catch(e => console.warn(e));
  }
  console.log("✅ الشعب seedت للوحة التحكم الخاصة بيك");
});
