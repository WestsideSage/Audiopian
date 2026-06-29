/**
 * Wires a #themeToggle button to flip data-theme and persist the choice.
 * Thin DOM adapter over the pure window.KaraokeeTheme helpers; loaded with
 * `defer` on the landing + legal pages. No-ops if the button/helper is absent.
 */
(function () {
    if (typeof document === 'undefined') return;

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function syncLabel(btn) {
        var next = window.KaraokeeTheme.nextTheme(currentTheme());
        btn.setAttribute('aria-label', next === 'light' ? 'Switch to light theme' : 'Switch to dark theme');
    }

    function wire() {
        var btn = document.getElementById('themeToggle');
        if (!btn || !window.KaraokeeTheme) return;
        syncLabel(btn);
        btn.addEventListener('click', function () {
            var next = window.KaraokeeTheme.nextTheme(currentTheme());
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem(window.KaraokeeTheme.THEME_STORAGE_KEY, next); } catch (e) {}
            syncLabel(btn);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
