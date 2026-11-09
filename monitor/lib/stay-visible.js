// Runs first in every frame of the game window. Many games pause, or stop updating their results,
// when their tab is hidden or loses focus. This makes the page always see itself as visible and
// focused, so rounds keep arriving while you look at the monitor or another tab.
(() => {
  if (window.__aviatorStayVisible) return;
  window.__aviatorStayVisible = true;
  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, {configurable: true, get: () => value}); } catch {}
  };
  define(Document.prototype, 'hidden', false);
  define(Document.prototype, 'webkitHidden', false);
  define(Document.prototype, 'visibilityState', 'visible');
  define(Document.prototype, 'webkitVisibilityState', 'visible');
  try { Document.prototype.hasFocus = () => true; } catch {}
  // Registered before any page script, so these events never reach the game.
  const swallow = e => { e.stopImmediatePropagation(); };
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) document.addEventListener(type, swallow, true);
  for (const type of ['blur', 'pagehide', 'freeze']) window.addEventListener(type, e => { if (e.target === window || e.target === document) swallow(e); }, true);
})();
