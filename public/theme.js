/* theme.js — نظام الثيم المشترك لمنصة ثانوية club
   ✅ الافتراضي: أبيض (مطابق لتصميم منصة الثانوية)
   ✅ الوضع الليلي متاح عبر زر التبديل
*/
(function () {
  'use strict';

  var STORAGE_KEY = 'thanawya_theme';
  var VERSION_KEY = 'thanawya_theme_ver';
  var CURRENT_VERSION = '2'; // نسخة الثيم الجديد (أبيض)
  var DEFAULT_THEME = 'light';
  var META_COLORS = { light: '#f8fafc', dark: '#070b14' };

  // ✅ حقن CSS الثيم الأبيض الجديد (مطابق لتصميم منصة الثانوية)
  function injectLightStyles() {
    if (document.getElementById('thanawya-light-theme')) return;
    var s = document.createElement('style');
    s.id = 'thanawya-light-theme';
    s.textContent = `
      /* ===== الثيم الأبيض الجديد (مطابق لتصميم منصة الثانوية) ===== */
      [data-theme="light"] {
        --bg: #f8fafc;
        --bg-alt: #ffffff;
        --card: #ffffff;
        --card-hover: #f1f5f9;
        --card-inner: #f1f5f9;
        --panel: #ffffff;
        --panel2: #f1f5f9;
        --ink: #1e293b;
        --muted: #64748b;
        --line: rgba(108, 99, 255, 0.10);
        --line-soft: rgba(108, 99, 255, 0.05);
        --blue: #6c63ff;
        --blue2: #00d4ff;
        --blue3: #5a52d5;
        --green: #10b981;
        --red: #ef4444;
        --purple: #8b5cf6;
        --nav-bg: rgba(255, 255, 255, 0.85);
        --nav-bg-scrolled: rgba(255, 255, 255, 0.95);
        --back-btn-bg: #ffffff;
        --back-btn-bg-hover: #f1f5f9;
        --placeholder-bg: linear-gradient(135deg, #e2e8f0, #f1f5f9);
        --video-card-bg: #ffffff;
        --bg-pattern: radial-gradient(circle at top right, rgba(108, 99, 255, 0.05), transparent 40%);
        --shadow: 0 10px 30px rgba(108, 99, 255, 0.15);
        --shadow-hover: 0 20px 40px rgba(108, 99, 255, 0.25);
      }

      /* body الجديد بالألوان الناعمة */
      [data-theme="light"] body {
        background-color: #f8fafc;
        color: #1e293b;
      }
      [data-theme="light"] body:before {
        background:
          radial-gradient(ellipse at 78% 0%, rgba(108, 99, 255, 0.08), transparent 35%),
          radial-gradient(ellipse at 5% 48%, rgba(0, 212, 255, 0.05), transparent 30%),
          linear-gradient(180deg, #f8fafc, #f1f5f9 60%, #f8fafc) !important;
      }

      /* الأزرار الأساسية تاخد التدرج البنفسجي→سماوي */
      [data-theme="light"] .action-btn,
      [data-theme="light"] .view-btn,
      [data-theme="light"] .btn-primary,
      [data-theme="light"] .price-card .btn,
      [data-theme="light"] .nav-btn {
        background: linear-gradient(135deg, #6c63ff 0%, #00d4ff 100%) !important;
        box-shadow: 0 10px 25px rgba(108, 99, 255, 0.3) !important;
        color: #fff !important;
      }
      [data-theme="light"] .action-btn:hover,
      [data-theme="light"] .view-btn:hover,
      [data-theme="light"] .btn-primary:hover {
        box-shadow: 0 15px 35px rgba(108, 99, 255, 0.45) !important;
        transform: translateY(-2px);
      }

      /* الأيقونات الداخلية تاخد البنفسجي */
      [data-theme="light"] .section-title-icon,
      [data-theme="light"] .feature-icon,
      [data-theme="light"] .price-icon,
      [data-theme="light"] .mini-icon,
      [data-theme="light"] .file-icon,
      [data-theme="light"] .admin-avatar {
        background: rgba(108, 99, 255, 0.10) !important;
        color: #6c63ff !important;
      }

      /* شارات "active" البنفسجية */
      [data-theme="light"] .tag.active,
      [data-theme="light"] .badge,
      [data-theme="light"] .live-pill,
      [data-theme="light"] .popular,
      [data-theme="light"] .eyebrow,
      [data-theme="light"] .hero-badge,
      [data-theme="light"] .section-header .subtitle {
        background: rgba(108, 99, 255, 0.10) !important;
        color: #6c63ff !important;
        border-color: rgba(108, 99, 255, 0.20) !important;
      }

      /* أرقام الكروت */
      [data-theme="light"] .stat b,
      [data-theme="light"] .lectures-badge,
      [data-theme="light"] .videos-badge,
      [data-theme="light"] .name-span {
        color: #6c63ff !important;
      }
      [data-theme="light"] .lectures-badge,
      [data-theme="light"] .videos-badge {
        background: linear-gradient(135deg, #6c63ff 0%, #00d4ff 100%) !important;
        color: #fff !important;
      }

      /* التدرجات النصية */
      [data-theme="light"] .gradient {
        background: linear-gradient(100deg, #6c63ff 0%, #00d4ff 100%) !important;
        -webkit-background-clip: text !important;
        background-clip: text !important;
        -webkit-text-fill-color: transparent !important;
        color: transparent !important;
      }

      /* التمرير */
      [data-theme="light"] ::-webkit-scrollbar-thumb {
        background: rgba(108, 99, 255, 0.3);
      }
    `;
    document.head.appendChild(s);
  }

  function applyTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') theme = DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_COLORS[theme]);
  }

  function getSaved() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME; }
    catch (e) { return DEFAULT_THEME; }
  }

  function updateBtnLabels(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-label', theme === 'dark' ? 'التبديل للوضع النهاري' : 'التبديل للوضع الليلي');
      b.setAttribute('title', theme === 'dark' ? 'الوضع النهاري ☀️' : 'الوضع الليلي 🌙');
    });
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    updateBtnLabels(next);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  }

  function bind() {
    injectLightStyles();
    var cur = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    updateBtnLabels(cur);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      if (b.__themeBound) return;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleTheme();
      });
      b.__themeBound = true;
    });
  }

  // ✅ ترقية النسخة: أول مرة بعد التحديث، نعمل reset للأبيض
  try {
    var v = localStorage.getItem(VERSION_KEY);
    if (v !== CURRENT_VERSION) {
      localStorage.setItem(STORAGE_KEY, 'light');
      localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
    }
  } catch (e) {}

  // حقن الستايل أول حاجة
  injectLightStyles();
  applyTheme(getSaved());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else { bind(); }

  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY && e.newValue) {
      applyTheme(e.newValue);
      updateBtnLabels(e.newValue);
    }
  });

  window.ThemeManager = {
    toggle: toggleTheme,
    current: function () { return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME; }
  };
})();
