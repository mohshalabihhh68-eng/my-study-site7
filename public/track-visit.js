/**
 * Thanawya — تسجيل زيارة مفصّلة (v5 — أقوى كشف موديل ممكن من المتصفح)
 * <script src="/track-visit.js" defer></script>
 *
 * يجمع الموديل من: Client Hints + UA + كاش محلي + GPU تلميح
 * وبيبعت fetch أولاً عشان الـ JSON يوصل كامل للسيرفر
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
      if (!ext) return (gl.getParameter(gl.RENDERER) || "").slice(0, 120);
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "").slice(0, 120);
    } catch (e) {
      return "";
    }
  }

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
        var denied = false;
        try { denied = localStorage.getItem("tw_geo_denied") === "1"; } catch (e) {}
        if (denied) return finish(null);
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
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

  function isBadModel(m) {
    m = String(m || "").trim();
    if (!m || m.length < 2) return true;
    if (/^(K|U|wv|Linux|Android|Mobile|Phone|null|undefined|\?0|\?1|Web Browser|Unknown)$/i.test(m)) return true;
    return false;
  }

  function inferBrand(model, brand) {
    var m = String(model || "");
    if (brand) return brand;
    if (/^SM-|^GT-|Galaxy/i.test(m)) return "Samsung";
    if (/^RMX|^2404ARN|^2409|^RMX/i.test(m)) return "Realme";
    if (/^CPH/i.test(m)) return "OPPO";
    if (/Redmi|POCO|Mi\s|Xiaomi/i.test(m)) return "Xiaomi";
    if (/Infinix|TECNO|ITE/i.test(m)) return "Infinix/Tecno";
    if (/iPhone|iPad|Macintosh/i.test(m)) return "Apple";
    if (/Pixel/i.test(m)) return "Google";
    if (/V\d{4}|vivo/i.test(m)) return "Vivo";
    if (/Huawei|Honor|ANE-|LYA-|CLT-/i.test(m)) return "Huawei";
    if (/Nokia|TA-/i.test(m)) return "Nokia";
    if (/Moto|Motorola/i.test(m)) return "Motorola";
    return brand || "";
  }

  function loadCachedDevice() {
    try {
      var raw = localStorage.getItem("tw_device_model") || sessionStorage.getItem("tw_device_model");
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (j && j.model && !isBadModel(j.model)) return j;
    } catch (e) {}
    return null;
  }

  function saveCachedDevice(model, brand) {
    if (isBadModel(model)) return;
    try {
      var data = JSON.stringify({ model: String(model).slice(0, 80), brand: String(brand || "").slice(0, 40), at: Date.now() });
      try { localStorage.setItem("tw_device_model", data); } catch (e1) {
        try { sessionStorage.setItem("tw_device_model", data); } catch (e2) {}
      }
    } catch (e) {}
  }

  function parseModelFromUA(ua) {
    ua = String(ua || "");
    if (!ua) return "";
    var patterns = [
      /Android\s[\d.]+;\s*([^);]+?)(?:\s+Build|[);])/i,
      /\b((?:SM|GT|SC|SGH|SCH|SHV)-[A-Z0-9]+)\b/i,
      /\b((?:RMX|CPH|V\d{4}|ANE|LYA|CLT|MAR|ELS|JNY|POT|STK)-[A-Z0-9]+)\b/i,
      /\b(SM-[A-Z0-9]+)\b/i,
      /\b(240\d[A-Z]{2,6}\d[A-Z]?\d*)\b/i,
      /\b((?:Redmi|POCO)\s+[^);/]{2,30})\b/i,
      /\b(Mi\s+\d[^);/]{0,20})\b/i,
      /\b((?:Infinix|TECNO|ITEL)[\s\-][^);/]{2,25})\b/i,
      /\b(Nokia\s+[^);/]{2,20})\b/i,
      /\b((?:Moto|Motorola)\s+[^);/]{2,20})\b/i,
      /\b(Pixel\s?\d[^);/]{0,12})\b/i,
      /\b(Galaxy\s+[^);/]{2,25})\b/i
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = ua.match(patterns[i]);
      if (m && m[1] && !isBadModel(m[1])) {
        return m[1].replace(/\s*Build.*/i, "").replace(/\/.*$/, "").trim();
      }
    }
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    return "";
  }

  /** محاولة Client Hints مع إعادة محاولة واحدة (أحيانًا أول طلب قبل Accept-CH) */
  async function tryClientHints() {
    var out = { model: "", brand: "", platform: "", platformVersion: "" };
    if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return out;
    var fields = ["model", "platform", "platformVersion", "architecture", "bitness", "fullVersionList", "uaFullVersion"];
    try {
      if (navigator.userAgentData.getHighEntropyValues.length) {
        // formFactor مش مدعوم في كل المتصفحات
        try { fields.push("formFactor"); } catch (e0) {}
      }
    } catch (e) {}
    function apply(ch) {
      if (!ch) return;
      if (ch.model && !isBadModel(ch.model)) out.model = ch.model;
      if (ch.platform) out.platform = ch.platform;
      if (ch.platformVersion) out.platformVersion = ch.platformVersion;
      if (ch.fullVersionList && ch.fullVersionList.length) {
        var brands = ch.fullVersionList.map(function (b) { return b.brand; }).join(" ");
        if (/Samsung/i.test(brands)) out.brand = "Samsung";
        else if (/Huawei/i.test(brands)) out.brand = "Huawei";
        else if (/Google/i.test(brands) && !/Chrome/i.test(brands)) out.brand = "Google";
      }
    }
    try {
      apply(await navigator.userAgentData.getHighEntropyValues(fields));
    } catch (e1) {
      try {
        apply(await navigator.userAgentData.getHighEntropyValues(["model", "platform", "platformVersion", "fullVersionList"]));
      } catch (e2) {}
    }
    // إعادة محاولة بعد لحظة لو الموديل لسه فاضي (بعد Critical-CH)
    if (isBadModel(out.model)) {
      await new Promise(function (r) { setTimeout(r, 350); });
      try {
        apply(await navigator.userAgentData.getHighEntropyValues(["model", "platform", "platformVersion", "fullVersionList"]));
      } catch (e3) {}
    }
    return out;
  }

  async function resolveDeviceModel() {
    var model = "";
    var brand = "";
    var platform = "";
    var platformVersion = "";

    // 1) Client Hints (مرتين لو لزم)
    try {
      var ch = await tryClientHints();
      if (ch.model && !isBadModel(ch.model)) model = ch.model;
      brand = ch.brand || brand;
      platform = ch.platform || platform;
      platformVersion = ch.platformVersion || platformVersion;
    } catch (e) {}

    // 2) UA
    if (isBadModel(model)) {
      try {
        model = parseModelFromUA(navigator.userAgent || "");
      } catch (e2) {}
    }

    // 3) كاش محلي من زيارة سابقة على نفس المتصفح
    if (isBadModel(model)) {
      var cached = loadCachedDevice();
      if (cached) {
        model = cached.model;
        brand = brand || cached.brand || "";
      }
    }

    // 4) تلميح من GPU (مش موديل دقيق — بس أفضل من فاضي على أندرويد)
    var gpu = "";
    try { gpu = gpuInfo(); } catch (e4) {}
    if (isBadModel(model) && gpu) {
      // مبنحطش GPU كموديل إلا لو مفيش أي حاجة — السيرفر يعرضه منفصل
    }

    brand = inferBrand(model, brand);
    if (!isBadModel(model)) saveCachedDevice(model, brand);

    return {
      model: model || "",
      brand: brand || "",
      platform: platform || "",
      platformVersion: platformVersion || "",
      gpu: gpu || ""
    };
  }

  async function collect() {
    var resolved = await resolveDeviceModel();
    var model = resolved.model;
    var brand = resolved.brand;
    var platform = resolved.platform;
    var platformVersion = resolved.platformVersion;
    var gpu = resolved.gpu || gpuInfo() || "";

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
    // GPS في الخلفية — متأخرش إرسال الموديل
    var geoPromise = getPreciseLocation();

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

    var payload = {
      screen: screenStr || null,
      timezone: timezone || null,
      language: (navigator.language || navigator.userLanguage || "").slice(0, 20) || null,
      page: (location.pathname + location.search).slice(0, 200),
      connection: connection,
      referrer: document.referrer || "",
      model: model || null,
      brand: brand || null,
      platform: platform || navigator.platform || "",
      platformVersion: platformVersion || "",
      cores: navigator.hardwareConcurrency || null,
      touchPoints: navigator.maxTouchPoints || 0,
      vendor: navigator.vendor || "",
      gpu: gpu || null,
      deviceMemory: navigator.deviceMemory || null,
      downlink: downlink,
      effectiveType: effectiveType,
      saveData: saveData,
      colorDepth: colorDepth,
      orientation: orientation,
      guestId: guestId || null,
      studentCode: student.studentCode || null,
      studentName: student.studentName || null,
      deviceId: student.deviceId || null,
      ua: (navigator.userAgent || "").slice(0, 400)
    };

    try {
      var geo = await geoPromise;
      if (geo) {
        payload.lat = geo.lat;
        payload.lon = geo.lon;
        payload.accuracy = geo.accuracy;
      }
    } catch (e) {}

    return payload;
  }

  function send(payload) {
    var url = "/api/track-visit";
    var body = JSON.stringify(payload);
    // fetch أولاً — Content-Type JSON مضمون
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

  // إرسال أول بأول بعد جمع الموديل — ولو فشل نعيد بعد ثانية (بعد Client Hints)
  function run() {
    collect().then(function (payload) {
      send(payload);
      // لو الموديل فاضي: إعادة محاولة واحدة بعد Client Hints/Critical-CH
      if (!payload.model || isBadModel(payload.model)) {
        setTimeout(function () {
          collect().then(function (p2) {
            if (p2 && p2.model && !isBadModel(p2.model)) send(p2);
          }).catch(function () {});
        }, 800);
      }
    }).catch(function () {
      send({
        page: location.pathname,
        language: navigator.language || null,
        referrer: document.referrer || "",
        guestId: getOrCreateGuestId(),
        ua: (navigator.userAgent || "").slice(0, 400)
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
