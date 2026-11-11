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
  const { device, session } = requireUpstreamCreds();
  return {
    "user-agent": TALEB_UA,
    accept: "*/*",
    "accept-language": "ar-AE,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: TALEB_BASE,
    referer: TALEB_BASE + "/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: `taleb-device=${device}; taleb-session=${session}`,
    ...extra
  };
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
    const startTok = key + '\\":';
    let a = html.indexOf(startTok);
    if (a < 0) return [];
    a = html.indexOf("[", a);
    if (a < 0) return [];
    let b;
    if (nextKey) {
      const endTok = ',\\"' + nextKey + '\\":';
      b = html.indexOf(endTok, a);
      if (b < 0) return [];
    } else {
      b = Math.min(html.length, a + 400000);
    }
    const raw = html.slice(a, b);
    const last = raw.lastIndexOf("]");
    if (last < 0) return [];
    const arrRaw = raw.slice(0, last + 1);
    try {
      return JSON.parse(pyUnescape(arrRaw));
    } catch (e) {
      console.warn("[catalog] parse", key, e && e.message);
      return [];
    }
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
  const html = await talebText(`${TALEB_BASE}/courses/${courseId}`, 45_000);
  let courseTitle = "";
  const h1 = html.match(new RegExp("<h1[^>]*>\\s*([^<]{3,120})\\s*</h1>", "i"));
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
  const linkRe = new RegExp('href="(/watch/(\\d+)/(\\d+)/(\\d+))"', "g");
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(html))) {
    const cId = m[2], lec = m[3], part = m[4];
    if (String(cId) !== String(courseId)) continue;
    const key = `${cId}/${lec}/${part}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const around = html.slice(Math.max(0, m.index - 800), Math.min(html.length, m.index + 600));
    let title =
      (around.match(new RegExp("cv-item-title[^>]*>([^<]+)<", "i")) || [])[1] ||
      (around.match(new RegExp("<span[^>]*class=\"[^\"]*title[^\"]*\"[^>]*>([^<]+)<", "i")) || [])[1] ||
      null;
    if (!title) {
      const ar = around.match(new RegExp("[\\u0600-\\u06FF][\\u0600-\\u06FF\\s\\w.+\\-\\u0640]{3,70}"));
      if (ar) title = ar[0];
    }
    title = cleanArName(title || `محاضرة ${lec} — جزء ${part}`, `محاضرة ${lec} — جزء ${part}`);
    let group = null;
    const before = html.slice(Math.max(0, m.index - 3000), m.index);
    const groupRe = new RegExp("cv-group-title[^>]*>([^<]+)", "gi");
    let gm;
    let lastG = null;
    while ((gm = groupRe.exec(before))) lastG = gm[1];
    if (lastG) group = cleanArName(lastG, null);
    if (!group) {
      const sec = before.match(new RegExp("(شرح\\s*المحاضرة|حل\\s*الأسئلة[^<]*|حل\\s*الكتب|الملفات[^<]*|المذكرات|امتحان|التقييم)", "i"));
      if (sec) group = cleanArName(sec[1], null);
    }
    let kind = "video";
    if (/ملف|pdf|مذكر|سبورة/i.test(title) || /ملف|مذكر/i.test(group || "")) kind = "file";
    else if (/امتحان|اختبار|تقييم/i.test(title) || /امتحان|تقييم/i.test(group || "")) kind = "exam";
    else if (/حل/i.test(group || "")) kind = "solution";
    items.push({
      courseId: String(cId),
      lectureNum: String(lec),
      partNum: String(part),
      title,
      group: group || "شرح المحاضرة",
      kind,
      watchPath: m[1]
    });
  }
  items.sort((a, b) => Number(a.lectureNum) - Number(b.lectureNum) || Number(a.partNum) - Number(b.partNum));
  const groups = [];
  const gRe = new RegExp("cv-group-title[^>]*>([^<]+)", "g");
  let gx;
  while ((gx = gRe.exec(html))) {
    const g = cleanArName(gx[1], gx[1].trim());
    if (g) groups.push(g);
  }
  return { courseTitle, items, groups, courseImage };
}

// تم تغيير الاسم لمنع التكرار
function ensureTeacher_First(subjects, teachersFlat, subjectSlug, name) {
  const first = String(name).split(/\\s+/).filter(Boolean)[0] || name;
  const exists = teachersFlat.some((t) =>
    String(t.subjectSlug || t.subjectId) === subjectSlug &&
    String(t.name || "").includes(first)
  );
  if (exists) return;
  const teacherObj = {
    id: `taleb_t_${subjectSlug}_manual_${String(name).replace(/\\s+/g, "_")}`,
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

// تم تغيير الاسم لمنع التكرار
export async function crawlTalebFullCatalog_Home() {
  const nowMs = Date.now();
  if (catalogCache.data && nowMs < catalogCache.exp) return catalogCache.data;

  console.log("[catalog] refresh start (home-json)");
  const html = await talebText(`${TALEB_BASE}/home`);
  const home = extractHomeCatalog(html);
  const subjectRows = Array.isArray(home.subjects) ? home.subjects : [];
  const teacherRows = Array.isArray(home.teachers) ? home.teachers : [];
  const courseRows = Array.isArray(home.courses) ? home.courses : [];
  console.log("[catalog] home parsed", { subjects: subjectRows.length, teachers: teacherRows.length, courses: courseRows.length });

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
    const num = parseSourceRefNumber(cr.sourceRef, "c");
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
  for (const [, arr] of coursesByTeacher) arr.sort((a, b) => (a.position - b.position) || Number(a.id) - Number(b.id));

  const subjects = [];
  const teachersFlat = [];

  for (const sr of subjectRows) {
    const slug = String(sr.id || "");
    if (!slug) continue;
    const subjectTeachers = [];
    for (const tid of (sr.teacherIds || [])) {
      const meta = teacherByUuid.get(String(tid));
      if (!meta) continue;
      const subjectCourses = (coursesByTeacher.get(String(tid)) || []).filter((c) => !c.subjectId || c.subjectId === slug);

      const courseDetails = await mapPool(subjectCourses, COURSE_CONCURRENCY, async (c) => {
        try {
          const parsed = await parseCourseParts(c.id);
          const finalTitle = (c.title && !/^كورس\\s*\\d+$/i.test(c.title))
            ? c.title
            : ((parsed.courseTitle && !/^كورس\\s*\\d+$/i.test(parsed.courseTitle)) ? parsed.courseTitle : (c.title || `كورس ${c.id}`));
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
          const main = parts.find((p) => p.kind === "video") || parts[0];
          const lecTitle = cleanArName(main?.title || `محاضرة ${ln}`, `محاضرة ${ln}`);
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
          title: c.title,
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

  // استخدام الاسم المعدل
  ensureTeacher_First(subjects, teachersFlat, "biology", "أحمد رضوان");
  ensureTeacher_First(subjects, teachersFlat, "biology", "حسام عيسى");
  ensureTeacher_First(subjects, teachersFlat, "english", "شريف المصري");

  const data = {
    subjects,
    teachers: teachersFlat,
    crawledAt: nowMs,
    stats: {
      subjects: subjects.length,
      teachers: teachersFlat.length,
      courses: teachersFlat.reduce((a, t) => a + (t.courses || []).length, 0),
      lectures: teachersFlat.reduce((a, t) => a + (t.lectures || []).length, 0),
      parts: teachersFlat.reduce((a, t) => a + (t.lectures || []).reduce((b, l) => b + (l.parts || []).length, 0), 0)
    }
  };
  console.log("[catalog] ready", data.stats);
  catalogCache.data = data;
  catalogCache.exp = nowMs + 30 * 60_000;
  return data;
}


/** تحويل مسار watch → UUID الجزء (part.id) */
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

function ensureTeacher(subjects, teachersFlat, subjectSlug, name) {
  const first = String(name).split(/\s+/)[0];
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
  sub.teachers = sub.teachers || [];
  sub.teachers.push(teacherObj);
}

/**
 * كتالوج كامل بنفس تقسيم المنصة الأصلية:
 * مادة → مدرس → كورس → محاضرة → أجزاء
 */
export async function crawlTalebFullCatalog() {
  const nowMs = Date.now();
  if (catalogCache.data && nowMs < catalogCache.exp) return catalogCache.data;

  console.log("[catalog] refresh start");
  
  // تعديل بسيط جداً: لو discoverSubjects مش موجودة، الكود هيستخدم النسخة الأولى اللي فوق بدل ما يعمل كراش
  if (typeof discoverSubjects !== "function") {
      console.warn("[catalog] discoverSubjects is not defined, falling back to home-json crawler.");
      return crawlTalebFullCatalog_Home();
  }

  const discovered = await discoverSubjects();
  const subjectSlugs = discovered.slugs || [];
  const subjectImages = discovered.images || {};
  const subjects = [];
  const teachersFlat = [];

  for (const slug of subjectSlugs) {
    let teachers = [];
    try {
      teachers = await discoverTeachers(slug);
    } catch (e) {
      console.warn("[catalog] subject skip");
      continue;
    }
    const subjectTeachers = [];

    for (const th of teachers) {
      let courses = [];
      try {
        if (th.numericId) courses = await discoverCourses(slug, th.numericId);
      } catch (e) {
        console.warn("[catalog] teacher courses skip");
      }

      const courseDetails = await mapPool(courses, COURSE_CONCURRENCY, async (c) => {
        try {
          const parsed = await parseCourseParts(c.id);
          const finalTitle = (parsed.courseTitle && !/^كورس\s*\d+$/i.test(parsed.courseTitle))
            ? parsed.courseTitle
            : (c.title && !/^كورس\s*\d+$/i.test(c.title) ? c.title : parsed.courseTitle || c.title || `كورس ${c.id}`);
          return {
            ...c,
            title: finalTitle,
            image_url: parsed.courseImage || c.image_url || null,
            parts: (parsed.items || []).filter((it) => String(it.courseId) === String(c.id)),
            groups: parsed.groups || []
          };
        } catch (e) {
          console.warn("[catalog] course skip");
          return { ...c, parts: [], groups: [] };
        }
      });

      const lectures = [];
      const coursesOut = [];
      const seenCourseIds = new Set();
      for (const c of courseDetails) {
        if (seenCourseIds.has(String(c.id))) continue;
        seenCourseIds.add(String(c.id));
        const byLec = new Map();
        for (const p of c.parts || []) {
          const ln = String(p.lectureNum);
          if (!byLec.has(ln)) byLec.set(ln, []);
          byLec.get(ln).push(p);
        }
        const courseLectures = [];
        const sortedKeys = [...byLec.keys()].sort((a, b) => Number(a) - Number(b));
        for (const ln of sortedKeys) {
          const parts = byLec.get(ln) || [];
          parts.sort((a, b) => Number(a.partNum) - Number(b.partNum));
          const mainTitle = cleanArName(parts[0]?.title || `محاضرة ${ln}`, `محاضرة ${ln}`);
          const lec = {
            id: `taleb_lec_${c.id}_${ln}`,
            title: mainTitle.slice(0, 120),
            courseId: String(c.id),
            lectureNum: ln,
            courseTitle: c.title,
            image_url: c.image_url || null,
            parts: parts.map((p) => ({
              id: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`,
              title: p.group && !String(p.title).includes(String(p.group))
                ? `${p.group} — ${p.title}`
                : p.title,
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
          title: c.title,
          image_url: c.image_url || null,
          partsCount: (c.parts || []).length,
          lecturesCount: courseLectures.length,
          lectures: courseLectures
        });
      }

      const teacherObj = {
        id: th.id,
        name: th.name,
        image_url: th.image_url || null,
        subjectId: slug,
        subjectSlug: slug,
        numericId: th.numericId,
        courses: coursesOut,
        lectures
      };
      subjectTeachers.push(teacherObj);
      teachersFlat.push(teacherObj);
    }

    // إزالة تكرار المدرسين داخل المادة بالاسم
    const uniqTeachers = [];
    const seenNames = new Set();
    for (const th of subjectTeachers) {
      const key = String(th.name || "").replace(/[^\u0600-\u06FFa-zA-Z]/g, "").toLowerCase() || th.id;
      if (seenNames.has(key)) {
        // ادمج الكورسات مع النسخة الأولى
        const prev = uniqTeachers.find((x) => (String(x.name || "").replace(/[^\u0600-\u06FFa-zA-Z]/g, "").toLowerCase() || x.id) === key);
        if (prev) {
          const have = new Set((prev.courses || []).map((c) => String(c.id)));
          for (const c of th.courses || []) if (!have.has(String(c.id))) {
            prev.courses.push(c);
            prev.lectures = (prev.lectures || []).concat(c.lectures || []);
          }
          if (!prev.image_url && th.image_url) prev.image_url = th.image_url;
        }
        continue;
      }
      seenNames.add(key);
      uniqTeachers.push(th);
    }
    // حدّث القائمة المسطحة: احذف المكرر من teachersFlat لنفس المادة
    for (let i = teachersFlat.length - 1; i >= 0; i--) {
      if (teachersFlat[i].subjectSlug === slug && !uniqTeachers.some((u) => u.id === teachersFlat[i].id)) {
        teachersFlat.splice(i, 1);
      }
    }
    subjects.push({
      id: slug,
      name: subjectNameAr(slug),
      image_url: subjectImages[slug] || null,
      teachers: uniqTeachers
    });
  }

  // مدرسين مطلوبين لو ناقصين من الزحف
  ensureTeacher(subjects, teachersFlat, "biology", "أحمد رضوان");
  ensureTeacher(subjects, teachersFlat, "biology", "حسام عيسى");
  ensureTeacher(subjects, teachersFlat, "english", "شريف المصري");

  const data = {
    subjects,
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
  catalogCache.data = data;
  catalogCache.exp = nowMs + 30 * 60_000;
  return data;
}

/** متوافق مع النسخة القديمة — يرجع مدرسين من الكتالوج الكامل */
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
