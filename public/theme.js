/* theme.js — نظام الثيم المشترك لمنصة ثانوية club */
(function () {
  'use strict';
  var STORAGE_KEY = 'thanawya_theme';
  var DEFAULT_THEME = 'dark';
  var META_COLORS = { dark: '#070b14', light: '#f4f7fc' };

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
