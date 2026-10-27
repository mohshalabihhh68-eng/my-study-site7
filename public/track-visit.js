/**
 * Thanawya — تسجيل زيارة الموقع (شاشة + منطقة زمنية + اتصال + موديل الجهاز)
 * حط السكريبت في صفحات الموقع العامة:
 *   <script src="/track-visit.js" defer></script>
 * أو انسخ المحتوى جوه <script> في index.
 */
(function () {
  if (window.__twVisitTracked) return;
  window.__twVisitTracked = true;

  async function collect() {
    var model = "";
    var brand = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        var ch = await navigator.userAgentData.getHighEntropyValues([
          "model",
          "platform",
          "platformVersion",
          "architecture",
          "bitness",
          "fullVersionList"
        ]);
        model = ch.model || "";
        if (ch.fullVersionList && ch.fullVersionList.length) {
          var brands = ch.fullVersionList.map(function (b) { return b.brand; }).join(" ");
          if (/Samsung/i.test(brands)) brand = "Samsung";
          else if (/Google/i.test(brands) && /Android/i.test(ch.platform || "")) brand = "Google";
        }
      }
    } catch (e) {}

    var connection = null;
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        connection = [c.effectiveType, c.type, c.downlink != null ? c.downlink + "Mbps" : ""]
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
      brand: brand
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
      screen: null,
      timezone: null,
      language: navigator.language || null,
      page: location.pathname,
      connection: null,
      referrer: document.referrer || ""
    });
  });
})();
