/**
 * Thanawya — تسجيل زيارة مفصّلة (v4 — كل زائر حتى غير المسجّل + guestId)
 * لازم يتضاف في كل الصفحات العامة (الصفحة الرئيسية / تسجيل الدخول / بعد الدخول):
 * <script src="/track-visit.js" defer></script>
 */
(function () {
  if (window.__twVisitTracked) return;
  window.__twVisitTracked = true;

  function gpuInfo() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return "";
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (!ext) return "";
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "").slice(0, 120);
    } catch (e) {
      return "";
    }
  }

  /** معرّف ثابت للزائر حتى لو مش مسجّل — عشان نجمّع زياراته في لوحة الأدمن */
  function getOrCreateGuestId() {
    try {
      var key = "tw_guest_id";
      var id = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (id && /^[a-zA-Z0-9_\-]{8,64}$/.test(id)) return id;
      id = "g_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem(key, id); } catch (e1) {
        try { sessionStorage.setItem(key, id); } catch (e2) {}
      }
      return id;
    } catch (e) {
      return "g_" + Math.random().toString(36).slice(2, 12);
    }
  }

  function readStudentHint() {
    try {
      var keys = ["tw_student", "student", "thanawya_student", "auth", "session"];
      for (var i = 0; i < keys.length; i++) {
        var raw = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]);
        if (!raw) continue;
        try {
          var j = JSON.parse(raw);
          var code = (j && (j.code || (j.student && j.student.code) || j.studentCode)) || "";
          var name = (j && (j.name || (j.student && j.student.name) || j.studentName)) || "";
          var deviceId = (j && (j.deviceId || (j.student && j.student.deviceId))) || "";
          if (code) return { studentCode: String(code), studentName: String(name || ""), deviceId: String(deviceId || "") };
        } catch (e2) {}
      }
    } catch (e) {}
    return {};
  }

  function getPreciseLocation() {
    return new Promise(function (resolve) {
      try {
        if (!navigator.geolocation) return resolve(null);
        var done = false;
        var finish = function (v) {
          if (done) return;
          done = true;
          resolve(v);
        };
        // محاولة GPS — لو المستخدم رفض مرة مش هنتكرر كل تحميل
        var denied = false;
        try { denied = localStorage.getItem("tw_geo_denied") === "1"; } catch (e) {}
        if (denied) return finish(null);

        navigator.geolocation.getCurrentPosition(
          function (pos) {
            finish({
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracy: pos.coords.accuracy
            });
          },
          function (err) {
            if (err && err.code === 1) {
              try { localStorage.setItem("tw_geo_denied", "1"); } catch (e2) {}
            }
            finish(null);
          },
          { enableHighAccuracy: true, maximumAge: 120000, timeout: 2500 }
        );
        setTimeout(function () { finish(null); }, 2800);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function collect() {
    var model = "";
    var brand = "";
    var platform = "";
    var platformVersion = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        var ch = await navigator.userAgentData.getHighEntropyValues([
          "model", "platform", "platformVersion", "architecture", "bitness", "fullVersionList", "uaFullVersion"
        ]);
        model = ch.model || "";
        platform = ch.platform || "";
        platformVersion = ch.platformVersion || "";
        if (ch.fullVersionList && ch.fullVersionList.length) {
          var brands = ch.fullVersionList.map(function (b) { return b.brand; }).join(" ");
          if (/Samsung/i.test(brands)) brand = "Samsung";
          else if (/Google Chrome/i.test(brands) === false && /Google/i.test(brands)) brand = "Google";
          else if (/Huawei/i.test(brands)) brand = "Huawei";
        }
      }
    } catch (e) {}

    if (!model || model === "K" || model.length < 2) {
      try {
        var ua = navigator.userAgent || "";
        var m =
          ua.match(/Android\s[\d.]+;\s*([^);]+?)(?:\s+Build|[);])/i) ||
          ua.match(/\b((?:SM|RMX|CPH|V\d{4}|ANE|LYA|CLT|MAR|ELS)-[A-Z0-9]+)\b/i) ||
          ua.match(/\b(SM-[A-Z0-9]+)\b/i) ||
          ua.match(/\b((?:Redmi|POCO|Mi|Infinix|TECNO|ITE|Nokia|Moto|Galaxy)[^);/]{2,40})\b/i);
        if (m && m[1] && !/^(K|U|wv|Linux)$/i.test(m[1].trim())) {
          model = m[1].replace(/\s*Build.*/i, "").trim();
        }
        // Client Hints (حتى لو مش mobile flag)
        if ((!model || model.length < 3) && navigator.userAgentData) {
          try {
            var ch2 = await navigator.userAgentData.getHighEntropyValues(["model", "platform", "platformVersion"]);
            if (ch2 && ch2.model && ch2.model.length > 1 && ch2.model !== "K") model = ch2.model;
            if (!platform && ch2.platform) platform = ch2.platform;
            if (!platformVersion && ch2.platformVersion) platformVersion = ch2.platformVersion;
          } catch (e3) {}
        }
      } catch (e2) {}
    }
    if (model && /^SM-[XT]/i.test(model) && !brand) brand = "Samsung";
    if (model && /^RMX/i.test(model) && !brand) brand = "Realme";
    if (model && /^CPH/i.test(model) && !brand) brand = "OPPO";
    if (model && /Redmi|POCO|Mi\s/i.test(model) && !brand) brand = "Xiaomi";
    if (model && /Infinix|TECNO|ITE/i.test(model) && !brand) brand = "Infinix/Tecno";
    if (!model) {
      try {
        var ua2 = navigator.userAgent || "";
        if (/iPhone/i.test(ua2)) { model = "iPhone"; brand = brand || "Apple"; }
        else if (/iPad/i.test(ua2)) { model = "iPad"; brand = brand || "Apple"; }
      } catch (e4) {}
    }

    var connection = null;
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        connection = [c.effectiveType, c.type, c.downlink != null ? c.downlink + "Mbps" : "", c.rtt != null ? c.rtt + "ms" : ""]
          .filter(Boolean)
          .join(" · ") || null;
      }
    } catch (e) {}

    var timezone = "";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}

    var screenStr = "";
    try {
      screenStr = (window.screen && screen.width && screen.height) ? screen.width + "x" + screen.height : "";
      if (window.devicePixelRatio) screenStr += (screenStr ? " @" : "") + window.devicePixelRatio + "x";
    } catch (e) {}

    var student = readStudentHint();
    var guestId = getOrCreateGuestId();
    var geo = await getPreciseLocation();

    var downlink = null, effectiveType = null, saveData = false;
    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        if (conn.downlink != null) downlink = conn.downlink;
        if (conn.effectiveType) effectiveType = conn.effectiveType;
        saveData = !!conn.saveData;
      }
    } catch (e) {}
    var colorDepth = null, orientation = null;
    try { colorDepth = (window.screen && screen.colorDepth) || null; } catch (e) {}
    try { orientation = (screen.orientation && screen.orientation.type) || null; } catch (e) {}

    // بيتبعت دايمًا — حتى لو مفيش studentCode (زائر غير مسجّل)
    var payload = {
      screen: screenStr || null,
      timezone: timezone || null,
      language: (navigator.language || navigator.userLanguage || "").slice(0, 20) || null,
      page: (location.pathname + location.search).slice(0, 200),
      connection: connection,
      referrer: document.referrer || "",
      model: model,
      brand: brand,
      platform: platform || navigator.platform || "",
      platformVersion: platformVersion || "",
      cores: navigator.hardwareConcurrency || null,
      touchPoints: navigator.maxTouchPoints || 0,
      vendor: navigator.vendor || "",
      gpu: gpuInfo() || null,
      deviceMemory: navigator.deviceMemory || null,
      downlink: downlink,
      effectiveType: effectiveType,
      saveData: saveData,
      colorDepth: colorDepth,
      orientation: orientation,
      guestId: guestId || null,
      studentCode: student.studentCode || null,
      studentName: student.studentName || null,
      deviceId: student.deviceId || null
    };
    if (geo) {
      payload.lat = geo.lat;
      payload.lon = geo.lon;
      payload.accuracy = geo.accuracy;
    }
    return payload;
  }

  function send(payload) {
    var url = "/api/track-visit";
    var body = JSON.stringify(payload);
    // fetch أولاً (Content-Type مضمون + keepalive) — sendBeacon كان بيرجع true
    // من غير ما الـ body يتفسّر JSON أحيانًا، فالسيرفر بيسجّل زيارة فاضية/ناقصة
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body,
        keepalive: true,
        credentials: "same-origin"
      }).catch(function () {
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
          }
        } catch (e2) {}
      });
      return;
    } catch (e) {}
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      }
    } catch (e3) {}
  }

  collect().then(send).catch(function () {
    var gid = null;
    try { gid = getOrCreateGuestId(); } catch (e) {}
    send({
      page: location.pathname + (location.search || ""),
      language: navigator.language || null,
      referrer: document.referrer || "",
      guestId: gid
    });
  });
})();
