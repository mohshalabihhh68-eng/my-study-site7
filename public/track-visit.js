/**
 * Thanawya — تسجيل زيارة مفصّلة
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

  async function collect() {
    var model = "";
    var brand = "";
    var platform = "";
    var platformVersion = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        var ch = await navigator.userAgentData.getHighEntropyValues([
          "model",
          "platform",
          "platformVersion",
          "architecture",
          "bitness",
          "fullVersionList",
          "uaFullVersion"
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

    // fallback من UA لو الموديل فاضي
    if (!model || model === "K" || model.length < 2) {
      try {
        var ua = navigator.userAgent || "";
        var m =
          ua.match(/Android\s[\d.]+;\s*([^);]+?)(?:\s+Build|[);])/i) ||
          ua.match(/\b((?:SM|RMX|CPH|V\d{4})-[A-Z0-9]+)\b/i);
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
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {}

    var screenStr = "";
    try {
      screenStr = (window.screen && screen.width && screen.height)
        ? screen.width + "x" + screen.height
        : "";
      if (window.devicePixelRatio) screenStr += (screenStr ? " @" : "") + window.devicePixelRatio + "x";
    } catch (e) {}

    return {
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
      gpu: gpuInfo() || null
    };
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
