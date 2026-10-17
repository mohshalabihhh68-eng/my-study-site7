const state = {
  view: "years",
  year: null,
  subject: null,
  teacher: null,
  chapter: null,
  lecture: null,
};

let hls = null;
let hbTimer = null;
let cryptoUtils = null;
let currentKeyBlobUrl = null;
let currentPlaylistBlobUrl = null;

async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || "HTTP " + res.status);
  }
  return data.data !== undefined ? data.data : data;
}

function findCrypto() {
  if (
    window.DecryptionUtils &&
    typeof window.DecryptionUtils.decryptPlaybackKey === "function"
  ) {
    return window.DecryptionUtils;
  }
  var names = Object.getOwnPropertyNames(window);
  for (var i = 0; i < names.length; i++) {
    try {
      var obj = window[names[i]];
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.decryptPlaybackKey === "function"
      ) {
        return obj;
      }
    } catch (e) {}
  }
  return null;
}

function loadPlayerScript() {
  return new Promise(function (resolve, reject) {
    if (findCrypto()) return resolve(findCrypto());
    var existing = document.querySelector('script[src*="player.stream-weave.com"]');
    if (existing) {
      var tries = 0;
      var t = setInterval(function () {
        var c = findCrypto();
        if (c) {
          clearInterval(t);
          resolve(c);
        } else if (++tries > 40) {
          clearInterval(t);
          reject(new Error("timeout crypto"));
        }
      }, 150);
      return;
    }
    var s = document.createElement("script");
    s.src = "https://player.stream-weave.com/assets/player.js?v=1.1.1";
    s.onload = function () {
      var tries = 0;
      var t = setInterval(function () {
        var c = findCrypto();
        if (c) {
          clearInterval(t);
          resolve(c);
        } else if (++tries > 40) {
          clearInterval(t);
          reject(new Error("crypto not found"));
        }
      }, 150);
    };
    s.onerror = function () {
      reject(new Error("failed to load player.js"));
    };
    document.head.appendChild(s);
  });
}

function goHome() {
  state.view = "years";
  state.year = null;
  state.subject = null;
  state.teacher = null;
  state.chapter = null;
  state.lecture = null;
  render();
}

function setView(view, extra) {
  if (extra) {
    for (var k in extra) state[k] = extra[k];
  }
  state.view = view;
  render();
}

var appEl = document.getElementById("app");

async function render() {
  appEl.innerHTML = '<div class="loading">جاري التحميل...</div>';
  try {
    if (state.view === "years") await renderYears();
    else if (state.view === "subjects") await renderSubjects();
    else if (state.view === "teachers") await renderTeachers();
    else if (state.view === "chapters") await renderChapters();
    else if (state.view === "lectures") await renderLectures();
    else if (state.view === "content") await renderContent();
  } catch (e) {
    appEl.innerHTML = '<div class="error">خطأ: ' + e.message + "</div>";
  }
}

async function renderYears() {
  var years = await api("/api/years");
  var html = "<h1>السنوات الدراسية</h1><div class='grid'>";
  for (var i = 0; i < years.length; i++) {
    var y = years[i];
    html +=
      "<div class='card' onclick='setView(\"subjects\"," +
      JSON.stringify({ year: y }) +
      ")'><img src='" +
      (y.image_url || "") +
      "' onerror=\"this.style.display='none'\"/><div class='body'><div class='title'>" +
      y.name +
      "</div></div></div>";
  }
  html += "</div>";
  appEl.innerHTML = html;
}

async function renderSubjects() {
  var subjects = await api("/api/subjects/" + state.year.id);
  var html =
    "<div class='crumbs'><span class='link' onclick='goHome()'>الرئيسية</span> / " +
    state.year.name +
    "</div><h1>المواد</h1><div class='grid'>";
  for (var i = 0; i < subjects.length; i++) {
    var s = subjects[i];
    html +=
      "<div class='card' onclick='setView(\"teachers\"," +
      JSON.stringify({ subject: s }) +
      ")'><img src='" +
      (s.image_url || "") +
      "' onerror=\"this.style.display='none'\"/><div class='body'><div class='title'>" +
      s.name +
      "</div></div></div>";
  }
  html += "</div>";
  appEl.innerHTML = html;
}

async function renderTeachers() {
  var data = await api("/api/subjects/" + state.subject.id + "/teachers");
  var teachers = data.teachers || [];
  var html =
    "<div class='crumbs'><span class='link' onclick='goHome()'>الرئيسية</span> / " +
    state.subject.name +
    "</div><h1>المدرسين</h1><div class='grid'>";
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    html +=
      "<div class='card' onclick='setView(\"chapters\"," +
      JSON.stringify({ teacher: t }) +
      ")'><img src='" +
      (t.image_url || "") +
      "' onerror=\"this.style.display='none'\"/><div class='body'><div class='title'>" +
      t.name +
      "</div><div class='meta'>" +
      (t.chapter_count || 0) +
      " فصل</div></div></div>";
  }
  html += "</div>";
  appEl.innerHTML = html;
}

async function renderChapters() {
  var chapters = await api("/api/teachers/" + state.teacher.id + "/chapters");
  var html =
    "<div class='crumbs'><span class='link' onclick='goHome()'>الرئيسية</span> / " +
    state.teacher.name +
    "</div><h1>الفصول</h1><div class='list'>";
  for (var i = 0; i < chapters.length; i++) {
    var c = chapters[i];
    html +=
      "<div class='list-item' onclick='setView(\"lectures\"," +
      JSON.stringify({ chapter: c }) +
      ")'><img src='" +
      (c.image_url || "") +
      "' onerror=\"this.style.opacity=0.3\"/><div><div class='title'>" +
      c.name +
      "</div><div class='meta'>" +
      (c.lecture_count || 0) +
      " محاضرة</div></div></div>";
  }
  html += "</div>";
  appEl.innerHTML = html;
}

async function renderLectures() {
  var lectures = await api("/api/chapters/" + state.chapter.id + "/lectures");
  var html =
    "<div class='crumbs'><span class='link' onclick='goHome()'>الرئيسية</span> / " +
    state.chapter.name +
    "</div><h1>المحاضرات</h1><div class='list'>";
  for (var i = 0; i < lectures.length; i++) {
    var l = lectures[i];
    html +=
      "<div class='list-item' onclick='setView(\"content\"," +
      JSON.stringify({ lecture: l }) +
      ")'><img src='" +
      (l.image_url || "") +
      "' onerror=\"this.style.opacity=0.3\"/><div><div class='title'>" +
      l.name +
      "</div><div class='meta'>" +
      (l.video_count || 0) +
      " فيديو</div></div></div>";
  }
  html += "</div>";
  appEl.innerHTML = html;
}

async function renderContent() {
  var content = await api("/api/lectures/" + state.lecture.id + "/content");
  var videos = content.videos || [];
  var pdfs = content.pdfs || [];
  var html =
    "<div class='crumbs'><span class='link' onclick='goHome()'>الرئيسية</span> / " +
    state.lecture.name +
    "</div><h1>" +
    state.lecture.name +
    "</h1><h3 style='color:#f97316;margin:12px 0'>الفيديوهات</h3>";
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    var title = String(v.title).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    html +=
      "<button class='btn' onclick=\"playVideo(" +
      v.id +
      ",'" +
      title +
      "')\"><span>▶</span><span>" +
      v.title +
      "</span></button>";
  }
  html += "<h3 style='color:#f97316;margin:16px 0 8px'>الملفات</h3>";
  for (var j = 0; j < pdfs.length; j++) {
    var p = pdfs[j];
    html +=
      "<a class='btn' href='" +
      p.url +
      "' target='_blank' rel='noopener'><span>📄</span><span>" +
      p.title +
      "</span></a>";
  }
  appEl.innerHTML = html;
}

// ==================== Player Helpers ====================

function toB64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(value) {
  var s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

function joinRel(base, rel) {
  var q = "";
  var relPath = String(rel);
  var qi = relPath.indexOf("?");
  if (qi !== -1) {
    q = relPath.slice(qi);
    relPath = relPath.slice(0, qi);
  }
  var stack = String(base || "").split("/");
  if (
    stack.length &&
    stack[stack.length - 1] !== "" &&
    /\.[a-z0-9]+$/i.test(stack[stack.length - 1])
  ) {
    stack.pop();
  }
  if (stack.length && stack[stack.length - 1] === "") stack.pop();
  relPath.split("/").forEach(function (part) {
    if (!part || part === ".") return;
    if (part === "..") stack.pop();
    else stack.push(part);
  });
  return stack.join("/") + q;
}

function resolveMedia(uri, variantBasePath, streamToken, variantFileUrl) {
  if (/^(blob:|data:)/i.test(uri)) return uri;
  if (uri.indexOf("/api/stream") === 0 || uri.indexOf("/api/cdn") === 0) {
    return location.origin + uri;
  }
  if (/^https?:\/\//i.test(uri)) {
    return location.origin + "/api/cdn?u=" + toB64url(uri);
  }
  if (variantFileUrl) {
    try {
      return location.origin + "/api/cdn?u=" + toB64url(new URL(uri, variantFileUrl).href);
    } catch (e) {}
  }
  return (
    location.origin +
    "/api/stream?path=" +
    encodeURIComponent(joinRel(variantBasePath || "", uri)) +
    "&t=" +
    encodeURIComponent(streamToken)
  );
}

function rewritePlaylist(text, streamToken, keyBlobUrl, variantBasePath, variantFileUrl) {
  return text
    .split("\n")
    .map(function (line) {
      var s = line.trim();
      if (!s) return line;
      if (s.charAt(0) === "#") {
        if (s.indexOf("#EXT-X-KEY:") === 0 && keyBlobUrl) {
          return s.replace(/URI="[^"]+"/, 'URI="' + keyBlobUrl + '"');
        }
        return s.replace(/URI="([^"]+)"/g, function (_m, uri) {
          return 'URI="' + resolveMedia(uri, variantBasePath, streamToken, variantFileUrl) + '"';
        });
      }
      return resolveMedia(s, variantBasePath, streamToken, variantFileUrl);
    })
    .join("\n");
}

// ==================== Main Play Function ====================

async function playVideo(videoId, title) {
  var modal = document.getElementById("player-modal");
  var video = document.getElementById("video");
  var status = document.getElementById("player-status");
  document.getElementById("player-title").textContent = title;
  status.textContent = "جاري فتح الجلسة...";
  modal.classList.remove("hidden");
  stopPlayback();

  try {
    var session = await api("/api/video/" + videoId + "/play", { method: "POST" });
    var streamToken = session.token;
    var swVideoId = session.video_id;
    var hbUrl = session.heartbeat_url;

    if (!streamToken || !swVideoId) {
      throw new Error("الجلسة ناقصة (مفيش token أو video_id)");
    }

    status.textContent = "تحميل أدوات فك التشفير...";
    if (!cryptoUtils) cryptoUtils = await loadPlayerScript();

    status.textContent = "جلب قائمة التشغيل...";
    var masterUrl =
      "/api/stream?path=" +
      encodeURIComponent("videos/" + swVideoId + "/stream/master.m3u8") +
      "&t=" +
      encodeURIComponent(streamToken);

    var masterRes = await fetch(masterUrl);
    if (!masterRes.ok) throw new Error("master.m3u8 → HTTP " + masterRes.status);
    var masterText = await masterRes.text();

    var variantRel = masterText
      .split("\n")
      .map(function (l) {
        return l.trim();
      })
      .find(function (l) {
        return l && l.charAt(0) !== "#";
      });

    if (!variantRel) throw new Error("مفيش variant في الـ master");

    var variantUrl;
    var variantBasePath = "videos/" + swVideoId + "/stream/";
    var variantFileUrl = null;

    if (variantRel.indexOf("/api/stream") === 0 || variantRel.indexOf("/api/cdn") === 0) {
      variantUrl = variantRel;
      try {
        var vu = new URL(variantRel, location.origin);
        if (vu.pathname.indexOf("/api/stream") === 0 && vu.searchParams.get("path")) {
          variantBasePath = vu.searchParams.get("path");
        }
        if (vu.pathname.indexOf("/api/cdn") === 0 && vu.searchParams.get("u")) {
          variantFileUrl = fromB64url(vu.searchParams.get("u"));
        }
      } catch (e) {}
    } else if (variantRel.indexOf("http") === 0) {
      variantFileUrl = variantRel;
      variantUrl = "/api/cdn?u=" + toB64url(variantRel);
    } else {
      variantBasePath = "videos/" + swVideoId + "/stream/" + variantRel;
      variantUrl =
        "/api/stream?path=" +
        encodeURIComponent(variantBasePath) +
        "&t=" +
        encodeURIComponent(streamToken);
    }

    var variantRes = await fetch(variantUrl);
    if (!variantRes.ok) throw new Error("variant → HTTP " + variantRes.status);
    var variantText = await variantRes.text();

    status.textContent = "فك المفتاح...";
    var keyLine = variantText.split("\n").find(function (l) {
      return l.indexOf("EXT-X-KEY") !== -1;
    });

    var keyPath = "videos/" + swVideoId + "/key";
    var ivHex = null;
    if (keyLine) {
      var keyUriMatch = keyLine.match(/URI="([^"]+)"/);
      var ivMatch = keyLine.match(/IV=0x([0-9a-fA-F]+)/i);
      if (ivMatch) ivHex = ivMatch[1];
      if (keyUriMatch) {
        var uri = keyUriMatch[1];
        if (uri.indexOf("/api/stream") === 0 || uri.indexOf(location.origin + "/api/stream") === 0) {
          try {
            var u = new URL(uri, location.origin);
            var pth = u.searchParams.get("path");
            if (pth) keyPath = pth;
          } catch (e) {}
        } else if (uri.indexOf("http") !== 0 && uri.indexOf("/api/cdn") !== 0) {
          keyPath = uri.replace(/^\//, "").replace(/^api\/v1\//, "");
        }
      }
    }

    var keyUrl =
      "/api/stream?path=" +
      encodeURIComponent(keyPath) +
      "&t=" +
      encodeURIComponent(streamToken);

    var keyRes = await fetch(keyUrl);
    if (!keyRes.ok) throw new Error("key → HTTP " + keyRes.status);
    var wrappedKey = new Uint8Array(await keyRes.arrayBuffer());

    var keyResult = await cryptoUtils.decryptPlaybackKey(wrappedKey, swVideoId);
    var aesKey = keyResult && keyResult.key;
    if (!aesKey || aesKey.byteLength !== 16) {
      throw new Error("المفتاح غير صالح (مش 16 بايت)");
    }

    // Blob URLs (أفضل من memory://)
    var keyBytes =
      aesKey instanceof ArrayBuffer
        ? aesKey
        : aesKey.buffer.slice(aesKey.byteOffset, aesKey.byteOffset + aesKey.byteLength);

    var keyBlob = new Blob([keyBytes], { type: "application/octet-stream" });
    currentKeyBlobUrl = URL.createObjectURL(keyBlob);

    var fixedVariant = rewritePlaylist(
      variantText,
      streamToken,
      currentKeyBlobUrl,
      variantBasePath,
      variantFileUrl
    );

    if (fixedVariant.indexOf("#EXTM3U") !== 0) {
      fixedVariant = "#EXTM3U\n" + fixedVariant.replace(/^#EXTM3U\s*/m, "");
    }
    if (fixedVariant.indexOf("EXT-X-KEY") === -1) {
      var ivPart = ivHex ? ",IV=0x" + ivHex : "";
      fixedVariant =
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="' +
        currentKeyBlobUrl +
        '"' +
        ivPart +
        "\n" +
        fixedVariant.replace(/^#EXTM3U\s*/m, "");
    }

    var playlistBlob = new Blob([fixedVariant], {
      type: "application/vnd.apple.mpegurl",
    });
    currentPlaylistBlobUrl = URL.createObjectURL(playlistBlob);

    status.textContent = "جاري التشغيل...";

    // Heartbeat كل 25 ثانية
    hbTimer = setInterval(function () {
      fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: hbUrl, token: streamToken }),
      }).catch(function () {});
    }, 25000);

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });

      hls.loadSource(currentPlaylistBlobUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        status.textContent = "";
        video.play().catch(function () {
          status.textContent = "اضغط Play يدويًا";
        });
      });

      hls.on(Hls.Events.ERROR, function (_, data) {
        console.error("HLS error:", data);
        if (!data.fatal) return;
        var msg = data.type + (data.details ? " / " + data.details : "");
        if (data.response && data.response.code) msg += " HTTP " + data.response.code;
        status.textContent = "خطأ HLS: " + msg;
      });
    } else {
      status.textContent = "المتصفح لا يدعم HLS.js";
    }
  } catch (e) {
    console.error(e);
    status.textContent = "فشل: " + (e.message || e);
  }
}

function stopPlayback() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (currentKeyBlobUrl) {
    URL.revokeObjectURL(currentKeyBlobUrl);
    currentKeyBlobUrl = null;
  }
  if (currentPlaylistBlobUrl) {
    URL.revokeObjectURL(currentPlaylistBlobUrl);
    currentPlaylistBlobUrl = null;
  }
  var video = document.getElementById("video");
  if (video) {
    video.removeAttribute("src");
    video.load();
  }
}

function closePlayer() {
  stopPlayback();
  document.getElementById("player-modal").classList.add("hidden");
}

// تحميل الـ crypto من الأول
loadPlayerScript()
  .then(function (c) {
    cryptoUtils = c;
  })
  .catch(function () {});

render();
