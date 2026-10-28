/**
 * Thanawya — تسجيل زيارة مفصّلة (v3 — GPS اختياري + طالب)
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
          ua.match(/\b((?:SM|RMX|CPH|V\d{4}|ANE|LYA|CLT|MAR|ELS)-[A-Z0-9]+)\b/i);
        if (m && m[1] && !/^(K|U|wv|Linux)$/i.test(m[1].trim())) {
          model = m[1].replace(/\s*Build.*/i, "").trim();
        }
      } catch (e2) {}
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
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch (e) {}
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        credentials: "same-origin"
      }).catch(function () {});
    } catch (e) {}
  }

  collect().then(send).catch(function () {
    send({
      page: location.pathname,
      language: navigator.language || null,
      referrer: document.referrer || ""
    });
  });
})();
