/**
 * upstream catalog + stream adapter (internal)
 * AES-128-CBC segment path
 *
 * SECURITY:
 * - Never hardcode device/session.
 * - Creds only via env TALEB_DEVICE / TALEB_SESSION or runtime update.
 * - Client-facing errors stay generic.
 */

const TALEB_BASE = "https://talep.pro";
const TALEB_VIDEO_BASE = "https://video.talep.pro";
const TALEB_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

function requireUpstreamCreds() {
  const device = String(process.env.TALEB_DEVICE || "").trim();
  const session = String(process.env.TALEB_SESSION || "").trim();
  if (!device || !session) {
    const err = new Error("خدمة البث غير مهيأة حالياً");
    err.status = 503;
    err.expose = true;
    throw err;
  }
  return { device, session };
}

const SUBJECT_NAME_AR = {
  biology: "أحياء",
  chemistry: "كيمياء",
  physics: "فيزياء",
  math: "رياضة",
  maths: "رياضة",
  arabic: "عربي",
  english: "إنجليزي",
  french: "فرنساوي",
  history: "تاريخ",
  geography: "جغرافيا",
  philosophy: "فلسفة",
  psychology: "علم نفس",
  geology: "جيولوجيا",
  pure_math: "رياضة بحتة",
  applied_math: "رياضة تطبيقية",
  statistics: "إحصاء",
  general: "عام"
};

function talebHeaders(extra = {}) {
  const device = String(process.env.TALEB_DEVICE || "").trim();
  const session = String(process.env.TALEB_SESSION || "").trim();
  const headers = {
    "user-agent": TALEB_UA,
    accept: "*/*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: TALEB_BASE,
    referer: TALEB_BASE + "/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra
  };
  // الكوكيز اختيارية لزحف الكتالوج العام — مطلوبة للبث فقط
  if (device && session) {
    headers.cookie = `taleb-device=${device}; taleb-session=${session}`;
  } else if (device) {
    headers.cookie = `taleb-device=${device}`;
  }
  return headers;
}

function talebVideoHeaders(extra = {}) {
  return {
    ...talebHeaders({ "sec-fetch-site": "same-site" }),
    ...extra
  };
}

async function talebFetch(url, opts = {}, timeout = 25_000) {
  const signal = AbortSignal.timeout(timeout);
  return fetch(url, { ...opts, signal });
}

async function talebText(url, timeout = 30_000) {
  const r = await talebFetch(url, { headers: talebHeaders({ accept: "text/html" }) }, timeout);
  if (!r.ok) {
    const err = new Error("تعذر جلب الصفحة");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  return r.text();
}

// ---------- API القديمة (إشعارات) ----------
export async function getTalebNotifications() {
  const r = await talebFetch(`${TALEB_BASE}/api/notifications`, {
    headers: talebHeaders({ pragma: "no-cache", "cache-control": "no-cache" })
  });
  if (!r.ok) {
    const err = new Error("تعذر جلب الإشعارات");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  return r.json();
}

export async function getTalebPlaylist(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`;
  const r = await talebFetch(url, { headers: talebVideoHeaders() });
  if (!r.ok) {
    const err = new Error("تعذر جلب قائمة التشغيل");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  const text = await r.text();
  if (!text.includes("#EXTM3U")) {
    const err = new Error("قائمة التشغيل غير صالحة");
    err.status = 502;
    throw err;
  }
  return text;
}

export async function getTalebKey(partId) {
  const url = `${TALEB_VIDEO_BASE}/api/video/${partId}/key`;
  const r = await talebFetch(url, { headers: talebVideoHeaders({ accept: "*/*" }) });
  if (!r.ok) {
    const err = new Error("تعذر جلب مفتاح التشفير");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length !== 16) {
    const err = new Error("مفتاح التشفير غير صالح");
    err.status = 502;
    throw err;
  }
  return buf;
}

// ---------- زحف الكتالوج الكامل ----------
const catalogCache = { exp: 0, data: null };
export function clearTalebCatalogCache() { catalogCache.exp = 0; catalogCache.data = null; }

const partIdCache = new Map(); // watchKey -> uuid
const COURSE_CONCURRENCY = 4;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function subjectNameAr(sid) {
  return SUBJECT_NAME_AR[String(sid || "").toLowerCase()] || String(sid || "مادة");
}

const SUBJECT_ORDER = ["arabic", "english", "chemistry", "physics", "biology"];
const SUBJECT_ALLOWED = new Set(SUBJECT_ORDER);

function sortSubjects(list) {
  const rank = new Map(SUBJECT_ORDER.map((s, i) => [s, i]));
  return [...(list || [])]
    .filter((s) => SUBJECT_ALLOWED.has(String(s.id || "")))
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : 100;
      const rb = rank.has(b.id) ? rank.get(b.id) : 100;
      if (ra !== rb) return ra - rb;
      return String(a.name || "").localeCompare(String(b.name || ""), "ar");
    });
}

function cleanCourseTitle(title, teacherName, courseId) {
  let n = String(title || "").replace(/\s+/g, " ").trim();
  const tn = String(teacherName || "").replace(/\s+/g, " ").trim();
  // شيل لاحقة اسم المدرس: " - أ. فلان" أو " و أ. فلان" أو "| فلان"
  if (tn) {
    const escaped = tn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n = n.replace(new RegExp("\\s*[-–—|]?\\s*" + escaped + "\\s*$", "i"), "");
    n = n.replace(new RegExp("\\s+و\\s+" + escaped + "\\s*$", "i"), "");
    // جزء من الاسم
    const first = tn.split(/\s+/).filter(Boolean)[0];
    if (first && first.length >= 3) {
      n = n.replace(new RegExp("\\s*[-–—|]?\\s*(?:أ\\.?|د\\.?|مستر)?\\s*" + first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "i"), "");
    }
  }
  n = n.replace(/\s*[-–—|]\s*(?:أ\.?|د\.?|مستر)\s*[؀-ۿ].*$/u, "");
  n = n.replace(/\s+و\s+(?:أ\.?|د\.?|مستر)\s*[؀-ۿ].*$/u, "");
  n = n.replace(/\s*\|\s*طالب\s*برو.*$/i, "").trim();
  if (!n || looksLikeTeacherName(n, tn) || /^كورس\s*\d+$/i.test(n)) {
    return courseId ? `كورس ${courseId}` : (n || "كورس");
  }
  return n;
}

/** تنظيم زي الموقع: نحتفظ باسم المجموعة الأصلي، والملفات لوحدها */
function normalizeGroup(raw, kind, title) {
  const s = String(raw || "").trim();
  const t = String(title || "");
  if (kind === "file" || /ملف|مذكر|pdf|سبورة|نموذج الإجابة/i.test(s + " " + t) || /فتح الملف/i.test(t)) {
    return "الملفات";
  }
  if (!s) {
    if (/امتحان|اختبار/i.test(t)) return "الامتحان";
    if (/حل\s|واجب|تدريب/i.test(t)) return "الحل";
    return "الشرح";
  }
  return s; // نفس اسم المجموعة من الموقع (الشرح / التطبيق التفاعلي / تسليم الواجب / ...)
}

function looksLikeTeacherName(title, teacherName) {
  const a = String(title || "").replace(/\s+/g, " ").trim();
  const b = String(teacherName || "").replace(/\s+/g, " ").trim();
  if (!a || a.length < 3) return true;
  if (/^كورس\s*\d+$/i.test(a)) return true;
  if (b && (a === b || a.includes(b) || b.includes(a))) return true;
  // اسم شخص بدون كلمة كورس/شهر/باب
  if (/^(أ\.|د\.|مستر|مستر\.|أ |د )\s*/u.test(a) && !/كورس|شهر|باب|وحدة|الفصل|المحاضرة/i.test(a)) {
    return true;
  }
  return false;
}


function cleanArName(s, fallback = "") {
  s = String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // شيل بقايا UI
  s = s.replace(/^(د\.?|دكتور|أ\.?|أستاذ)\s*/i, (m) => m) // keep title prefix if present
       .replace(/طالب\s*برو/gi, "")
       .replace(/talep\.pro|taleb/gi, "")
       .replace(/["']+/g, "")
       .replace(/\s{2,}/g, " ")
       .trim();
  // لو الاسم قصير أو أرقام فقط
  if (!s || s.length < 2 || /^[\d\s]+$/.test(s)) return fallback || s;
  // خُد أول جملة عربية معقولة
  const m = s.match(/[\u0600-\u06FF][\u0600-\u06FF\s.·\-ـ]{1,60}/);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  return s.slice(0, 80);
}

function absUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (!u || u.startsWith("data:")) return null;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return TALEB_BASE + u;
  if (/^https?:\/\//i.test(u)) return u;
  return TALEB_BASE + "/" + u.replace(/^\.\//, "");
}

function extractImagesFromHtml(html, limit = 12) {
  const out = [];
  const re = /(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit * 2) {
    const u = absUrl(m[1]);
    if (!u) continue;
    if (/logo|icon|sprite|placeholder|flag|emoji|favicon|svg|1x1|pixel/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, limit);
}

function extractHomeCatalog(html) {
  function pyUnescape(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== "\\") { out += s[i]; continue; }
      const n = s[i + 1];
      if (n === "u" && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 5; continue;
      }
      if (n === '"') { out += '"'; i++; continue; }
      if (n === "\\") { out += "\\"; i++; continue; }
      if (n === "/") { out += "/"; i++; continue; }
      if (n === "n") { out += "\n"; i++; continue; }
      if (n === "r") { out += "\r"; i++; continue; }
      if (n === "t") { out += "\t"; i++; continue; }
      if (n != null) { out += n; i++; continue; }
      out += "\\";
    }
    return out;
  }
  function extractBetween(key, nextKey) {
    const tokens = [key + '\\":', '"' + key + '":', key + '":'];
    let a = -1;
    for (const tok of tokens) {
      a = html.indexOf(tok);
      if (a >= 0) break;
    }
    if (a < 0) return [];
    a = html.indexOf("[", a);
    if (a < 0) return [];
    let b = -1;
    if (nextKey) {
      for (const nk of [',\\"' + nextKey + '\\":', ',"' + nextKey + '":', ',"' + nextKey + '":']) {
        b = html.indexOf(nk, a);
        if (b >= 0) break;
      }
    }
    if (b < 0) b = Math.min(html.length, a + 400000);
    const raw = html.slice(a, b);
    const last = raw.lastIndexOf("]");
    if (last < 0) return [];
    const arrRaw = raw.slice(0, last + 1);
    // جرّب parse مباشر ثم unescape
    for (const candidate of [arrRaw, pyUnescape(arrRaw)]) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [];
  }
  return {
    subjects: extractBetween("subjects", "teachers"),
    teachers: extractBetween("teachers", "courses"),
    courses: extractBetween("courses", "lectures")
  };
}

function parseSourceRefNumber(ref, prefix) {
  const s = String(ref || "");
  // c:864 | t:159 | th:t:50 | th:c:400
  const re = new RegExp("(?:^|:)" + prefix + ":(\\d+)(?:$|[^0-9])", "i");
  const m = s.match(re);
  if (m) return m[1];
  const re2 = new RegExp(prefix + ":(\\d+)", "i");
  const m2 = s.match(re2);
  return m2 ? m2[1] : null;
}

async function parseCourseParts(courseId) {
  let html = "";
  try {
    html = await talebText(`${TALEB_BASE}/courses/${courseId}`, 45_000);
  } catch {
    html = await talebText(`${TALEB_BASE}/course/${courseId}`, 45_000);
  }

  let courseTitle = "";
  const h1 = html.match(new RegExp("<h1[^>]*id=[\"']course-title[\"'][^>]*>([^<]+)</h1>", "i"))
    || html.match(new RegExp("<h1[^>]*>([^<]{3,120})</h1>", "i"));
  if (h1) courseTitle = h1[1];
  if (!courseTitle) {
    const og = html.match(new RegExp("property=[\"']og:title[\"'][^>]*content=[\"']([^\"']+)[\"']", "i"));
    if (og) courseTitle = og[1];
  }
  if (!courseTitle) {
    const titleM = html.match(new RegExp("<title>([^<]+)</title>", "i"));
    if (titleM) courseTitle = titleM[1];
  }
  courseTitle = cleanArName(
    String(courseTitle || "")
      .replace(new RegExp("\\s*[|\\-]\\s*.*$"), "")
      .replace(new RegExp("طالب\\s*برو", "gi"), "")
      .trim(),
    `كورس ${courseId}`
  );
  const imgs = extractImagesFromHtml(html, 6);
  const courseImage = imgs[0] || null;

  const items = [];
  const lectureBlocks = html.split(/class="cv-lecture"/i).slice(1);
  let lectureOrdinal = 0;

  for (const block of lectureBlocks) {
    lectureOrdinal += 1;
    let lecName = "";
    const ln = block.match(new RegExp("cv-lecture-name[^>]*>\\s*<strong>([^<]+)</strong>", "i"))
      || block.match(new RegExp("<strong>([^<]*محاضرة[^<]*)</strong>", "i"));
    if (ln) lecName = cleanArName(ln[1], `محاضرة ${lectureOrdinal}`);
    else lecName = `محاضرة ${lectureOrdinal}`;

    let lectureNum = String(lectureOrdinal);
    const watchInLec = block.match(new RegExp("/watch/" + String(courseId) + "/(\\d+)/(\\d+)"));
    if (watchInLec) lectureNum = watchInLec[1];

    const groupChunks = block.split(/class="cv-group"/i).slice(1);
    let partOrdinal = 0;

    for (const gchunk of groupChunks) {
      let groupTitle = "الشرح";
      const gt = gchunk.match(new RegExp("cv-group-title[^>]*>([^<]+)<", "i"));
      if (gt) groupTitle = cleanArName(gt[1], groupTitle);

      const itemChunks = gchunk.split(/class="cv-item"/i).slice(1);
      for (const ichunk of itemChunks) {
        partOrdinal += 1;
        let itemTitle = "";
        const it = ichunk.match(new RegExp("cv-item-title[^>]*>([^<]+)", "i"));
        if (it) itemTitle = it[1];
        itemTitle = String(itemTitle || "").split("<")[0];
        itemTitle = cleanArName(itemTitle, `${groupTitle} ${partOrdinal}`);

        let partNum = String(partOrdinal);
        let watchPath = null;
        const wm = ichunk.match(new RegExp("/watch/(\\d+)/(\\d+)/(\\d+)"));
        if (wm && String(wm[1]) === String(courseId)) {
          lectureNum = wm[2];
          partNum = wm[3];
          watchPath = `/watch/${wm[1]}/${wm[2]}/${wm[3]}`;
        } else {
          const nm = ichunk.match(new RegExp("next=%2Fwatch%2F(\\d+)%2F(\\d+)%2F(\\d+)"));
          if (nm && String(nm[1]) === String(courseId)) {
            lectureNum = nm[2];
            partNum = nm[3];
            watchPath = `/watch/${nm[1]}/${nm[2]}/${nm[3]}`;
          } else {
            watchPath = `/watch/${courseId}/${lectureNum}/${partNum}`;
          }
        }

        let kind = "video";
        if (/ملف|pdf|مذكر|سبورة|نموذج|تحليل/i.test(itemTitle) || /فتح الملف/i.test(ichunk) || /ملف/i.test(groupTitle)) kind = "file";
        else if (/امتحان|اختبار/i.test(groupTitle) || /امتحان/i.test(itemTitle)) kind = "exam";
        else if (/واجب|حل|تطبيق|تدريب|تسليم/i.test(groupTitle)) kind = "solution";
        const normGroup = normalizeGroup(groupTitle, kind, itemTitle);
        if (normGroup === "الملفات") kind = "file";

        items.push({
          courseId: String(courseId),
          lectureNum: String(lectureNum),
          partNum: String(partNum),
          lectureTitle: lecName,
          title: itemTitle,
          group: normGroup,
          kind,
          watchPath: kind === "file" ? null : watchPath
        });
      }
    }

    if (!groupChunks.length) {
      const itemChunks = block.split(/class="cv-item"/i).slice(1);
      for (const ichunk of itemChunks) {
        partOrdinal += 1;
        const it = ichunk.match(new RegExp("cv-item-title[^>]*>([^<]+)", "i"));
        let itemTitle = cleanArName(it ? it[1] : `جزء ${partOrdinal}`, `جزء ${partOrdinal}`);
        let partNum = String(partOrdinal);
        let watchPath = `/watch/${courseId}/${lectureNum}/${partNum}`;
        const wm = ichunk.match(new RegExp("/watch/(\\d+)/(\\d+)/(\\d+)"));
        if (wm && String(wm[1]) === String(courseId)) {
          lectureNum = wm[2];
          partNum = wm[3];
          watchPath = `/watch/${wm[1]}/${wm[2]}/${wm[3]}`;
        }
        const k2 = /ملف|pdf/i.test(itemTitle) ? "file" : "video";
        items.push({
          courseId: String(courseId),
          lectureNum: String(lectureNum),
          partNum: String(partNum),
          lectureTitle: lecName,
          title: itemTitle,
          group: normalizeGroup(null, k2, itemTitle),
          kind: k2,
          watchPath: k2 === "file" ? null : watchPath
        });
      }
    }
  }

  if (!items.length) {
    const linkRe = new RegExp('href="(/watch/(\\d+)/(\\d+)/(\\d+))"', "g");
    let m;
    const seen = new Set();
    while ((m = linkRe.exec(html))) {
      if (String(m[2]) !== String(courseId)) continue;
      const key = `${m[2]}/${m[3]}/${m[4]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        courseId: String(m[2]),
        lectureNum: String(m[3]),
        partNum: String(m[4]),
        lectureTitle: `محاضرة ${m[3]}`,
        title: `محاضرة ${m[3]} — جزء ${m[4]}`,
        group: "الشرح",
        kind: "video",
        watchPath: m[1]
      });
    }
  }

  items.sort((a, b) => Number(a.lectureNum) - Number(b.lectureNum) || Number(a.partNum) - Number(b.partNum));
  const groups = [];
  const seenG = new Set();
  for (const it of items) {
    if (it.group && !seenG.has(it.group)) {
      seenG.add(it.group);
      groups.push(it.group);
    }
  }
  return { courseTitle, items, groups, courseImage };
}

function ensureTeacher(subjects, teachersFlat, subjectSlug, name) {
  const first = String(name).split(/\s+/).filter(Boolean)[0] || name;
  const exists = teachersFlat.some((t) =>
    String(t.subjectSlug || t.subjectId) === subjectSlug &&
    String(t.name || "").includes(first)
  );
  if (exists) return;
  const teacherObj = {
    id: `taleb_t_${subjectSlug}_manual_${String(name).replace(/\s+/g, "_")}`,
    name,
    image_url: null,
    subjectId: subjectSlug,
    subjectSlug,
    numericId: null,
    courses: [],
    lectures: [],
    manual: true
  };
  teachersFlat.push(teacherObj);
  let sub = subjects.find((s) => s.id === subjectSlug);
  if (!sub) {
    sub = { id: subjectSlug, name: subjectNameAr(subjectSlug), image_url: null, teachers: [] };
    subjects.push(sub);
  }
  (sub.teachers = sub.teachers || []).push(teacherObj);
}

export async function crawlTalebFullCatalog() {
  const nowMs = Date.now();
  if (catalogCache.data && nowMs < catalogCache.exp && (catalogCache.data.subjects || []).length) {
    return catalogCache.data;
  }

  console.log("[catalog] refresh start");
  let html = "";
  for (const path of ["/home", "/", "/tracks/science"]) {
    try {
      html = await talebText(`${TALEB_BASE}${path}`);
      if (html && html.length > 5000) break;
    } catch (e) {
      console.warn("[catalog] fetch", path, e && e.message);
    }
  }

  let subjectRows = [];
  let teacherRows = [];
  let courseRows = [];
  if (html) {
    const home = extractHomeCatalog(html);
    subjectRows = Array.isArray(home.subjects) ? home.subjects : [];
    teacherRows = Array.isArray(home.teachers) ? home.teachers : [];
    courseRows = Array.isArray(home.courses) ? home.courses : [];
  }
  console.log("[catalog] home-json", {
    subjects: subjectRows.length,
    teachers: teacherRows.length,
    courses: courseRows.length,
    htmlLen: html ? html.length : 0
  });

  // ——— Fallback: زحف HTML لو JSON فاضي ———
  if (!subjectRows.length || !teacherRows.length) {
    console.warn("[catalog] fallback HTML crawl");
    const baseSlugs = ["arabic", "english", "chemistry", "physics", "biology"];
    const slugSet = new Set(baseSlugs);
    if (html) {
      for (const m of html.matchAll(/\/subjects\/([a-zA-Z0-9_-]+)/g)) {
        if (m[1] !== "teachers") slugSet.add(m[1]);
      }
    }
    subjectRows = [...slugSet].map((id, i) => ({
      id,
      name: subjectNameAr(id),
      image: null,
      position: i,
      teacherIds: []
    }));
    teacherRows = [];
    courseRows = [];

    for (const sr of subjectRows) {
      try {
        const sh = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(sr.id)}`);
        const ids = [...new Set([...sh.matchAll(new RegExp(`/subjects/${sr.id}/teachers/(\\d+)`, "g"))].map((x) => x[1]))];
        for (const id of ids) {
          const uuid = `html-${sr.id}-${id}`;
          // اسم المدرس
          let name = `مدرس ${id}`;
          const idx = sh.indexOf(`/subjects/${sr.id}/teachers/${id}`);
          if (idx >= 0) {
            const slice = sh.slice(Math.max(0, idx - 800), idx + 800);
            const alt = slice.match(/alt=["']([^"']*[\u0600-\u06FF][^"']{1,50})["']/i);
            if (alt) name = alt[1];
            else {
              const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s.·]{2,40}/);
              if (ar && !/مادة|عرض|رجوع|فصل|متاح/i.test(ar[0])) name = ar[0];
            }
          }
          name = cleanArName(name, `مدرس ${id}`);
          if (/رجوع|المواد|عرض|اختر/i.test(name)) name = `مدرس ${id}`;
          let image = null;
          if (idx >= 0) {
            const imgs = extractImagesFromHtml(sh.slice(Math.max(0, idx - 800), idx + 800), 3);
            if (imgs[0]) image = imgs[0].replace(TALEB_BASE, "") || imgs[0];
          }
          teacherRows.push({
            id: uuid,
            sourceRef: `t:${id}`,
            number: Number(id) || null,
            name,
            image,
            position: teacherRows.length
          });
          sr.teacherIds.push(uuid);

          // كورسات المدرس
          try {
            const th = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(sr.id)}/teachers/${id}`);
            const cids = [...new Set([...th.matchAll(/\/courses\/(\d+)/g)].map((x) => x[1]))];
            for (const cid of cids) {
              let title = "";
              const cidx = th.indexOf(`/courses/${cid}`);
              if (cidx >= 0) {
                const slice = th.slice(Math.max(0, cidx - 200), cidx + 600);
                const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s\w.+ـ\-]{3,80}/);
                if (ar && !/عرض|تفاصيل|رجوع/i.test(ar[0])) title = ar[0];
              }
              courseRows.push({
                id: `html-c-${cid}`,
                sourceRef: `c:${cid}`,
                number: Number(cid) || null,
                subjectId: sr.id,
                teacherId: uuid,
                title: cleanArName(title, ""),
                image: null,
                status: "published",
                position: courseRows.length
              });
            }
          } catch (e) {
            console.warn("[catalog] teacher courses skip", sr.id, id);
          }
        }
      } catch (e) {
        console.warn("[catalog] subject skip", sr.id);
      }
    }
    console.log("[catalog] fallback done", {
      subjects: subjectRows.length,
      teachers: teacherRows.length,
      courses: courseRows.length
    });
  }

  const teacherByUuid = new Map();
  for (const tr of teacherRows) {
    const uuid = String(tr.id || "");
    if (!uuid) continue;
    const numericId = parseSourceRefNumber(tr.sourceRef, "t") || (tr.number != null ? String(tr.number) : null);
    teacherByUuid.set(uuid, {
      uuid,
      numericId: numericId ? String(numericId) : null,
      name: cleanArName(tr.name || "", tr.name || "مدرس"),
      image_url: absUrl(tr.image || "") || null
    });
  }

  const coursesByTeacher = new Map();
  for (const cr of courseRows) {
    if (cr.status && String(cr.status).toLowerCase() !== "published") continue;
    const tid = String(cr.teacherId || "");
    if (!tid) continue;
    const num = parseSourceRefNumber(cr.sourceRef, "c") || (cr.number != null ? String(cr.number) : null);
    if (!num) continue;
    const row = {
      id: String(num),
      uuid: String(cr.id || ""),
      title: cleanArName(cr.title || "", `كورس ${num}`),
      image_url: absUrl(cr.image || "") || null,
      subjectId: cr.subjectId || null,
      teacherId: tid,
      position: cr.position ?? 0
    };
    if (!coursesByTeacher.has(tid)) coursesByTeacher.set(tid, []);
    coursesByTeacher.get(tid).push(row);
  }
  for (const [, arr] of coursesByTeacher) {
    arr.sort((a, b) => (a.position - b.position) || Number(a.id) - Number(b.id));
  }

  // المواد الأساسية فقط
  subjectRows = subjectRows.filter((sr) => SUBJECT_ALLOWED.has(String(sr.id || "")));
  // لو JSON رجّع فاضي للمواد المسموحة، كمّل من القائمة
  if (!subjectRows.length) {
    subjectRows = SUBJECT_ORDER.map((id, i) => ({ id, name: subjectNameAr(id), image: null, position: i, teacherIds: [] }));
  }

  const subjects = [];
  const teachersFlat = [];

  for (const sr of subjectRows) {
    const slug = String(sr.id || "");
    if (!slug) continue;
    const subjectTeachers = [];
    for (const tid of (sr.teacherIds || [])) {
      const meta = teacherByUuid.get(String(tid));
      if (!meta) continue;
      const subjectCourses = (coursesByTeacher.get(String(tid)) || [])
        .filter((c) => !c.subjectId || c.subjectId === slug);

      const courseDetails = await mapPool(subjectCourses, COURSE_CONCURRENCY, async (c) => {
        try {
          const parsed = await parseCourseParts(c.id);
          let finalTitle = c.title || "";
          const parsedTitle = parsed.courseTitle || "";
          if (looksLikeTeacherName(finalTitle, meta.name)) {
            if (parsedTitle && !looksLikeTeacherName(parsedTitle, meta.name)) finalTitle = parsedTitle;
            else if (parsedTitle) finalTitle = parsedTitle;
            else finalTitle = `كورس ${c.id}`;
          } else if (!finalTitle || /^كورس\s*\d+$/i.test(finalTitle)) {
            if (parsedTitle && !looksLikeTeacherName(parsedTitle, meta.name) && !/^كورس\s*\d+$/i.test(parsedTitle)) {
              finalTitle = parsedTitle;
            } else {
              finalTitle = finalTitle || parsedTitle || `كورس ${c.id}`;
            }
          }
          return {
            ...c,
            title: finalTitle,
            image_url: c.image_url || parsed.courseImage || null,
            parts: (parsed.items || []).filter((it) => String(it.courseId) === String(c.id)),
            groups: parsed.groups || []
          };
        } catch {
          return { ...c, parts: [], groups: [] };
        }
      });

      const lectures = [];
      const coursesOut = [];
      for (const c of courseDetails) {
        const byLec = new Map();
        for (const p of c.parts || []) {
          const ln = String(p.lectureNum);
          if (!byLec.has(ln)) byLec.set(ln, []);
          byLec.get(ln).push(p);
        }
        const courseLectures = [];
        for (const ln of [...byLec.keys()].sort((a, b) => Number(a) - Number(b))) {
          const parts = (byLec.get(ln) || []).sort((a, b) => Number(a.partNum) - Number(b.partNum));
          const lecTitle = cleanArName(
            parts[0]?.lectureTitle || parts.find((p) => p.kind === "video")?.title || `محاضرة ${ln}`,
            `محاضرة ${ln}`
          );
          const lec = {
            id: `taleb_lec_${c.id}_${ln}`,
            title: lecTitle.slice(0, 120),
            courseId: String(c.id),
            lectureNum: String(ln),
            courseTitle: c.title,
            image_url: c.image_url || null,
            parts: parts.map((p) => ({
              id: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`,
              title: p.title,
              group: p.group || null,
              kind: p.kind || "video",
              courseId: String(p.courseId),
              lectureNum: String(p.lectureNum),
              partNum: String(p.partNum),
              watchPath: p.watchPath,
              videoId: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`
            }))
          };
          courseLectures.push(lec);
          lectures.push(lec);
        }
        coursesOut.push({
          id: String(c.id),
          title: cleanCourseTitle(c.title, meta.name, c.id),
          image_url: c.image_url || null,
          partsCount: (c.parts || []).length,
          lecturesCount: courseLectures.length,
          lectures: courseLectures
        });
      }

      const teacherObj = {
        id: `taleb_t_${slug}_${meta.numericId || meta.uuid.slice(0, 8)}`,
        uuid: meta.uuid,
        name: meta.name,
        image_url: meta.image_url,
        subjectId: slug,
        subjectSlug: slug,
        numericId: meta.numericId,
        courses: coursesOut,
        lectures
      };
      subjectTeachers.push(teacherObj);
      teachersFlat.push(teacherObj);
    }

    subjects.push({
      id: slug,
      name: sr.name || subjectNameAr(slug),
      image_url: absUrl(sr.image || "") || null,
      teachers: subjectTeachers
    });
  }

  // لو لسه فاضي تمامًا — مواد أساسية على الأقل
  if (!subjects.length) {
    for (const slug of SUBJECT_ORDER) {
      subjects.push({ id: slug, name: subjectNameAr(slug), image_url: null, teachers: [] });
    }
  }

  ensureTeacher(subjects, teachersFlat, "biology", "أحمد رضوان");
  ensureTeacher(subjects, teachersFlat, "biology", "حسام عيسى");
  ensureTeacher(subjects, teachersFlat, "english", "شريف المصري");

  const data = {
    subjects: sortSubjects(subjects),
    teachers: teachersFlat,
    crawledAt: nowMs,
    stats: {
      subjects: subjects.length,
      teachers: teachersFlat.length,
      courses: teachersFlat.reduce((a, t) => a + (t.courses || []).length, 0),
      lectures: teachersFlat.reduce((a, t) => a + (t.lectures || []).length, 0),
      parts: teachersFlat.reduce(
        (a, t) => a + (t.lectures || []).reduce((b, l) => b + (l.parts || []).length, 0),
        0
      )
    }
  };
  console.log("[catalog] ready", data.stats);
  // متكاشِفش نتيجة فاضية من المدرسين
  if (teachersFlat.length > 0) {
    catalogCache.data = data;
    catalogCache.exp = nowMs + 30 * 60_000;
  } else {
    catalogCache.data = data;
    catalogCache.exp = nowMs + 60_000; // إعادة محاولة سريعة
  }
  return data;
}



export async function resolveTalebPartId(courseId, lectureNum, partNum) {
  const key = `${courseId}/${lectureNum}/${partNum}`;
  if (partIdCache.has(key)) return partIdCache.get(key);

  const html = await talebText(`${TALEB_BASE}/watch/${courseId}/${lectureNum}/${partNum}`, 40_000);
  let m = html.match(/\\"part\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"/);
  if (!m) m = html.match(/"part":\{"id":"([0-9a-f-]{36})"/);
  if (!m) m = html.match(/data-subject="[^"]*"[\s\S]{0,200}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!m) {
    const idx = html.search(/part\\":\{/);
    if (idx >= 0) {
      const slice = html.slice(idx, idx + 500);
      const m2 = slice.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (m2) m = m2;
    }
  }
  if (!m) {
    const err = new Error("تعذر تحديد مصدر الفيديو");
    err.status = 502;
    throw err;
  }
  const uuid = m[1];
  partIdCache.set(key, uuid);
  return uuid;
}



export async function getTalebTeachers() {
  try {
    const cat = await crawlTalebFullCatalog();
    return cat.teachers.map((t) => ({
      id: t.id,
      name: t.name,
      image_url: t.image_url || null,
      subjectId: t.subjectId,
      subjectIcon: null,
      courses: t.courses || [],
      lectures: (t.lectures || []).flatMap((lec) =>
        (lec.parts || []).map((p) => ({
          courseId: p.courseId,
          lectureId: p.lectureNum,
          partId: p.id,
          title: p.title || lec.title,
          createdAt: null,
          videoId: p.videoId,
          courseTitle: lec.courseTitle || null,
          image_url: lec.image_url || null
        }))
      )
    }));
  } catch (e) {
    console.warn("[catalog] full crawl failed, fallback path");
    const data = await getTalebNotifications();
    const items = data.items || [];
    const teacherMap = new Map();
    for (const item of items) {
      if (!item.teacherName) continue;
      const key = item.teacherName;
      if (!teacherMap.has(key)) {
        teacherMap.set(key, {
          id: `taleb_t_${key.replace(/\s+/g, "_")}`,
          name: item.teacherName,
          image_url: null,
          subjectId: item.subjectId || null,
          subjectIcon: item.subjectIcon || null,
          courses: [],
          lectures: []
        });
      }
      const urlMatch = (item.url || "").match(/\/watch\/([^/]+)\/([^/]+)\/([^/]+)/);
      if (urlMatch) {
        teacherMap.get(key).lectures.push({
          courseId: urlMatch[1],
          lectureId: urlMatch[2],
          partId: urlMatch[3],
          title: item.lectureTitle || item.body || item.title,
          createdAt: item.createdAt,
          videoId: `taleb_w_${urlMatch[1]}_${urlMatch[2]}_${urlMatch[3]}`
        });
      }
    }
    return [...teacherMap.values()];
  }
}

export async function buildTalebSource(partId) {
  const playlistText = await getTalebPlaylist(partId);
  const plainKey = await getTalebKey(partId);

  const lines = playlistText.split(/\r?\n/);
  let mediaSeq = 0;
  let targetDuration = 13;
  let currentIv = null;
  let segIndex = 0;
  const segs = [];
  const SID_TOKEN = "{{SID}}";
  const outLines = [];

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSeq = Number(t.split(":")[1]) || 0;
    if (t.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(t.split(":")[1]) || targetDuration;
    if (t.startsWith("#EXT-X-KEY:")) {
      const ivM = t.match(/IV=(0x[0-9a-fA-F]+|[0-9a-fA-F]{32})/i);
      if (ivM) {
        const h = ivM[1].replace(/^0x/i, "");
        currentIv = Buffer.from(h.padStart(32, "0"), "hex");
      }
    }
  }

  function ivFromSeq(seq) {
    const iv = Buffer.alloc(16, 0);
    iv.writeUInt32BE(seq >>> 0, 12);
    return iv;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#EXT-X-KEY:")) continue;
    if (t.startsWith("#EXTINF:")) {
      outLines.push(raw);
      continue;
    }
    if (t && !t.startsWith("#")) {
      let segUrl;
      if (t.startsWith("http")) segUrl = t;
      else segUrl = `${TALEB_VIDEO_BASE}${t.startsWith("/") ? "" : "/"}${t}`;
      const seq = mediaSeq + segIndex;
      const iv = currentIv || ivFromSeq(seq);
      segs.push({
        u: segUrl,
        iv: iv.toString("hex"),
        s: seq,
        i: segIndex,
        dur: targetDuration
      });
      outLines.push(`/api/hls/${SID_TOKEN}/seg/${segIndex}`);
      segIndex++;
      continue;
    }
    outLines.push(raw);
  }

  if (!segs.length) {
    const err = new Error("لا توجد مقاطع فيديو");
    err.status = 502;
    throw err;
  }

  return {
    reqVideoId: `taleb_${partId}`,
    videoId: partId,
    mode: "taleb",
    token: "taleb",
    streamUrl: `${TALEB_VIDEO_BASE}/api/video/${partId}/index.m3u8`,
    allowedHosts: new Set(["video.talep.pro", "talep.pro"]),
    plainKey,
    defaultIv: currentIv || ivFromSeq(mediaSeq),
    mediaSeq,
    targetDuration,
    segs,
    playlist: outLines.join("\n"),
    createdAt: Date.now(),
    directSegments: false,
    cipherMode: "cbc",
    ivMode: "playlist"
  };
}

/**
 * تشغيل من معرّف مرن:
 * - taleb_{uuid}
 * - taleb_w_{course}_{lec}_{part}
 * - uuid خام
 */
export async function buildTalebSourceFromAnyId(rawId) {
  let id = String(rawId || "").trim();

  // إزالة تكرار البادئة: taleb_taleb_w_... أو taleb_taleb_...
  while (/^taleb_taleb_/i.test(id)) {
    id = id.replace(/^taleb_/i, "");
  }

  // taleb_w_{course}_{lec}_{part}
  let wm = id.match(/^taleb_w_(\d+)_(\d+)_(\d+)$/i);
  if (!wm) wm = id.match(/^w_(\d+)_(\d+)_(\d+)$/i);
  if (wm) {
    const courseId = wm[1], lectureNum = wm[2], partNum = wm[3];
    const uuid = await resolveTalebPartId(courseId, lectureNum, partNum);
    const src = await buildTalebSource(uuid);
    src.reqVideoId = `taleb_w_${courseId}_${lectureNum}_${partNum}`;
    return src;
  }

  // watch path: 91/1/12
  let pm = id.match(/^(\d+)[\/_](\d+)[\/_](\d+)$/);
  if (pm) {
    const uuid = await resolveTalebPartId(pm[1], pm[2], pm[3]);
    const src = await buildTalebSource(uuid);
    src.reqVideoId = `taleb_w_${pm[1]}_${pm[2]}_${pm[3]}`;
    return src;
  }

  // أزل taleb_ مرة واحدة لو موجود
  if (/^taleb_/i.test(id)) id = id.replace(/^taleb_/i, "");

  // uuid
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const src = await buildTalebSource(id);
    src.reqVideoId = `taleb_${id}`;
    return src;
  }

  const err = new Error("معرّف الفيديو غير معروف");
  err.status = 400;
  throw err;
}

export const TALEB_STREAM_HOSTS = ["video.talep.pro", "talep.pro"];

export function updateTalebCookies(device, session) {
  if (device) process.env.TALEB_DEVICE = device;
  if (session) process.env.TALEB_SESSION = session;
  catalogCache.exp = 0;
  catalogCache.data = null;
  partIdCache.clear();
}

export { subjectNameAr };
