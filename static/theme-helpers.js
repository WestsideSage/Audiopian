/**
 * Pure theme-resolution helpers for the dual light/dark system. No DOM access -
 * the caller passes the stored preference + the OS preference, so resolution is
 * testable in Node.js. Browser pages also get window.KaraokeeTheme.
 *
 * Default is DARK: stored preference wins, else the OS preference, else dark.
 */
(function (root) {
    var THEME_STORAGE_KEY = 'audiopian-theme';
    var LIGHT = 'light';
    var DARK = 'dark';

    /**
     * @param {Object} [ctx]
     * @param {string|null} [ctx.stored]    localStorage value ('light'|'dark'|null|junk).
     * @param {boolean} [ctx.prefersLight]  OS prefers-color-scheme: light.
     * @returns {'light'|'dark'}
     */
    function resolveInitialTheme(ctx) {
        ctx = ctx || {};
        if (ctx.stored === LIGHT || ctx.stored === DARK) return ctx.stored;
        return ctx.prefersLight ? LIGHT : DARK;
    }

    /** Toggle target. Anything not exactly 'light' is treated as dark. */
    function nextTheme(current) {
        return current === LIGHT ? DARK : LIGHT;
    }

    var api = {
        THEME_STORAGE_KEY: THEME_STORAGE_KEY,
        resolveInitialTheme: resolveInitialTheme,
        nextTheme: nextTheme
    };
    if (root) root.KaraokeeTheme = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
