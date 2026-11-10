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
  while ((m = re.exec(html)) && out.length < limit) {
    const u = absUrl(m[1]);
    if (u && !/logo|icon|sprite|placeholder|flag|emoji|favicon/i.test(u) && !out.includes(u)) out.push(u);
  }
  const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og) {
    const u = absUrl(og[1]);
    if (u && !out.includes(u)) out.unshift(u);
  }
  return out;
}

function extractTeacherCard(html, subjectSlug, id) {
  const needle = `/subjects/${subjectSlug}/teachers/${id}`;
  const idx = html.indexOf(needle);
  let name = `مدرس ${id}`;
  let image_url = null;
  if (idx >= 0) {
    const slice = html.slice(Math.max(0, idx - 500), idx + 800);
    const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s.\d]{2,50}/);
    if (ar) name = ar[0].replace(/\s+/g, " ").trim();
    const imgs = extractImagesFromHtml(slice, 4);
    if (imgs[0]) image_url = imgs[0];
  }
  name = String(name || "").replace(/["'].*$/, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || `مدرس ${id}`;
  return { name, image_url };
}

function extractCourseCard(html, courseId) {
  const needle = `/courses/${courseId}`;
  const idx = html.indexOf(needle);
  let title = `كورس ${courseId}`;
  let image_url = null;
  if (idx >= 0) {
    const slice = html.slice(Math.max(0, idx - 200), idx + 900);
    const ar = slice.match(/[\u0600-\u06FF][\u0600-\u06FF\s\w.+ـ\-]{3,90}/);
    if (ar) title = ar[0].replace(/\s+/g, " ").trim();
    const imgs = extractImagesFromHtml(slice, 4);
    if (imgs[0]) image_url = imgs[0];
  }
  return { title, image_url };
}

/** اكتشاف المواد من الصفحة الرئيسية */
async function discoverSubjects() {
  const html = await talebText(`${TALEB_BASE}/home`);
  const slugs = [...new Set([...html.matchAll(/\/subjects\/([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  const base = ["biology", "chemistry", "physics", "arabic", "english", "geology", "history", "geography", "math", "maths", "pure_math", "applied_math"];
  for (const s of base) if (!slugs.includes(s)) slugs.push(s);
  const filtered = slugs.filter((s) => s && s !== "teachers");
  const images = {};
  for (const slug of filtered) {
    const idx = html.indexOf(`/subjects/${slug}`);
    if (idx >= 0) {
      const slice = html.slice(Math.max(0, idx - 400), idx + 600);
      const imgs = extractImagesFromHtml(slice, 3);
      if (imgs[0]) images[slug] = imgs[0];
    }
  }
  return { slugs: filtered, images };
}

/** مدرسو مادة */
async function discoverTeachers(subjectSlug) {
  const html = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(subjectSlug)}`);
  const ids = [...new Set([...html.matchAll(new RegExp(`/subjects/${subjectSlug}/teachers/(\\d+)`, "g"))].map((m) => m[1]))];
  const teachers = [];
  for (const id of ids) {
    const card = extractTeacherCard(html, subjectSlug, id);
    teachers.push({
      id: `taleb_t_${subjectSlug}_${id}`,
      numericId: id,
      name: card.name,
      image_url: card.image_url,
      subjectId: subjectSlug,
      subjectSlug
    });
  }
  return teachers;
}

/** كورسات مدرس */
async function discoverCourses(subjectSlug, teacherNumericId) {
  const html = await talebText(`${TALEB_BASE}/subjects/${encodeURIComponent(subjectSlug)}/teachers/${teacherNumericId}`);
  const ids = [...new Set([...html.matchAll(/\/courses\/(\d+)/g)].map((m) => m[1]))];
  const courses = [];
  for (const id of ids) {
    const card = extractCourseCard(html, id);
    courses.push({
      id,
      title: card.title,
      image_url: card.image_url,
      subjectSlug,
      teacherNumericId
    });
  }
  return courses;
}

/** محاضرات/أجزاء كورس من cv-item */
async function parseCourseParts(courseId) {
  const html = await talebText(`${TALEB_BASE}/courses/${courseId}`, 45_000);
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  let courseTitle = titleM ? titleM[1].replace(/\s*\|\s*.*$/i, "").trim() : `كورس ${courseId}`;
  courseTitle = courseTitle.replace(/^طالب\s*برو\s*\|\s*/i, "").trim();
  const imgs = extractImagesFromHtml(html, 6);
  const courseImage = imgs[0] || null;

  const items = [];
  const re = /<a class="cv-item" href="\/watch\/(\d+)\/(\d+)\/(\d+)"[^>]*>[\s\S]*?<span class="cv-item-title"[^>]*>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    items.push({
      courseId: m[1],
      lectureNum: m[2],
      partNum: m[3],
      title: m[4].replace(/\s+/g, " ").trim(),
      watchPath: `/watch/${m[1]}/${m[2]}/${m[3]}`
    });
  }
  if (!items.length) {
    const re2 = /href="\/watch\/(\d+)\/(\d+)\/(\d+)"/g;
    while ((m = re2.exec(html))) {
      items.push({
        courseId: m[1],
        lectureNum: m[2],
        partNum: m[3],
        title: `محاضرة ${m[2]} — جزء ${m[3]}`,
        watchPath: `/watch/${m[1]}/${m[2]}/${m[3]}`
      });
    }
  }
  const groups = [...html.matchAll(/cv-group-title[^>]*>([^<]+)/g)].map((x) => x[1].trim());
  return { courseTitle, items, groups, courseImage };
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
          return {
            ...c,
            title: parsed.courseTitle || c.title,
            image_url: parsed.courseImage || c.image_url || null,
            parts: parsed.items || [],
            groups: parsed.groups || []
          };
        } catch (e) {
          console.warn("[catalog] course skip");
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
        const sortedKeys = [...byLec.keys()].sort((a, b) => Number(a) - Number(b));
        for (const ln of sortedKeys) {
          const parts = byLec.get(ln) || [];
          parts.sort((a, b) => Number(a.partNum) - Number(b.partNum));
          const mainTitle = (parts[0]?.title || `محاضرة ${ln}`).replace(/\s+/g, " ").trim();
          const lec = {
            id: `taleb_lec_${c.id}_${ln}`,
            title: mainTitle.slice(0, 120),
            courseId: String(c.id),
            lectureNum: ln,
            courseTitle: c.title,
            image_url: c.image_url || null,
            parts: parts.map((p) => ({
              id: `taleb_w_${p.courseId}_${p.lectureNum}_${p.partNum}`,
              title: p.title,
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

    subjects.push({
      id: slug,
      name: subjectNameAr(slug),
      image_url: subjectImages[slug] || null,
      teachers: subjectTeachers
    });
  }

  // مدرسين مطلوبين لو ناقصين من الزحف
  ensureTeacher(subjects, teachersFlat, "biology", "أحمد رضوان");
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
