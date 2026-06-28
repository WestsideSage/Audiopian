# UX Redesign — Phase 0: Token + Theme Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the dual light/dark design-token + component foundation and a working theme toggle, and relocate the player's inline CSS into the shared stylesheet — with **no visible redesign yet** (dark mode looks identical; the toggle is the only new visible thing).

**Architecture:** A pure `theme-helpers.js` resolves the active theme (stored → OS → default-dark); a no-FOUC inline `<head>` boot applies it as `data-theme` on `<html>` before paint; `style.css` gains a `:root[data-theme="light"]` override layer plus new neutral/type/space/shadow/motion tokens (all **additive** — existing dark values are untouched). The landing + legal pages get a wired toggle; the player page is **pinned to dark in Phase 0** (its stage isn't themed until Phase 1) and its 490-line inline `<style>` is moved verbatim into `style.css`.

**Tech Stack:** Plain HTML/CSS/JS (no build step), UMD helper pattern (`new Function`-loadable for `.cjs` tests), Flask static serving (`python app.py` → http://localhost:5000), Node for JS tests.

**Spec:** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` (this implements §3.1, §3.2, and the foundation parts of §3.6). Branch: `feat/ux-geist-redesign`.

**Phase 0 boundaries (read before starting):**
- Dark mode must look **pixel-identical** to today on every page. All token *additions* are new names or light-only overrides.
- Light mode only needs to be **functional and unbroken** (no invisible text), not polished — polish is Phase 1.
- The player page stays dark and visually unchanged; only its CSS *location* moves.
- New component classes (`.btn` variants, `.panel`, `.pill`, `.chip`) are defined but **not yet applied** to existing elements (that rewiring is Phase 1). Universal `:focus-visible` is the one intentionally-visible accessibility win.

---

## Task 1: `theme-helpers.js` — pure theme resolution (TDD)

**Files:**
- Create: `static/theme-helpers.js`
- Test: `tests/test_theme_helpers.cjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test_theme_helpers.cjs` (mirrors the loader pattern in `tests/test_browser_support.cjs`):

```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load theme-helpers.js as a plain script (simulates browser <script> loading).
var filePath = path.join(__dirname, '..', 'static', 'theme-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var T = fakeModule.exports;

assert.strictEqual(T.THEME_STORAGE_KEY, 'audiopian-theme', 'stable storage key');

// Stored preference wins over OS.
assert.strictEqual(T.resolveInitialTheme({ stored: 'light', prefersLight: false }), 'light', 'stored light wins');
assert.strictEqual(T.resolveInitialTheme({ stored: 'dark', prefersLight: true }), 'dark', 'stored dark wins');

// No stored preference -> follow OS.
assert.strictEqual(T.resolveInitialTheme({ stored: null, prefersLight: true }), 'light', 'OS light');
assert.strictEqual(T.resolveInitialTheme({ stored: null, prefersLight: false }), 'dark', 'OS dark');

// Nothing known -> default dark (block-if-unsure: app's chosen default).
assert.strictEqual(T.resolveInitialTheme({}), 'dark', 'empty -> dark');
assert.strictEqual(T.resolveInitialTheme(), 'dark', 'no ctx -> dark');

// Junk stored value is ignored (falls through to OS/default).
assert.strictEqual(T.resolveInitialTheme({ stored: 'purple', prefersLight: true }), 'light', 'junk stored -> OS');
assert.strictEqual(T.resolveInitialTheme({ stored: 'purple' }), 'dark', 'junk stored, no OS -> dark');

// nextTheme toggles; anything not 'light' is treated as dark.
assert.strictEqual(T.nextTheme('dark'), 'light', 'dark -> light');
assert.strictEqual(T.nextTheme('light'), 'dark', 'light -> dark');
assert.strictEqual(T.nextTheme('whatever'), 'light', 'unknown -> light');

console.log('All theme-helpers tests passed.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_theme_helpers.cjs`
Expected: FAIL — `ENOENT` (file `static/theme-helpers.js` does not exist) or `Cannot read properties of undefined`.

- [ ] **Step 3: Write the minimal implementation**

Create `static/theme-helpers.js`:

```js
/**
 * Pure theme-resolution helpers for the dual light/dark system. No DOM access —
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_theme_helpers.cjs`
Expected: PASS — `All theme-helpers tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/theme-helpers.js tests/test_theme_helpers.cjs
git commit -m "feat(theme): add pure theme-resolution helpers + tests"
```

---

## Task 2: Token layer in `style.css` (new tokens + light overrides; dark unchanged)

**Files:**
- Modify: `static/style.css` (`:root` block ends at line 45; `body` background at lines 54-57; hardcoded `#f4f5fb` at lines 88, 100, 219, 306, 321, 325)

All edits here are additive or light-only. **Verify dark mode is unchanged** at the end.

- [ ] **Step 1: Append new tokens inside the existing `:root` block**

In `static/style.css`, replace the line:

```css
    /* gradients */
    --grad-accent:  linear-gradient(96deg, var(--p), var(--s));
}
```

with:

```css
    /* gradients */
    --grad-accent:  linear-gradient(96deg, var(--p), var(--s));

    /* ── NEW (Phase 0 foundation) ─────────────────────────────────
       Additive only — existing dark values above are untouched.       */

    /* strong heading text (was hardcoded #f4f5fb) */
    --text-strong:  #f4f5fb;

    /* neutral gray ramp (dark-oriented; light theme remaps below) */
    --gray-50:  #101012;
    --gray-100: #161618;
    --gray-200: #1d1d20;
    --gray-300: #26262a;
    --gray-400: #3a3a40;
    --gray-500: #52525a;
    --gray-600: #71717a;
    --gray-700: #a0a0a8;
    --gray-800: #cfcfd6;
    --gray-900: #ededed;

    /* fire — third warm stop for the on-fire gradient (Phase 2) */
    --fire-c:   #ffd24a;

    /* page background wash (token so light can override the neon radials) */
    --bg-wash:
        radial-gradient(120% 80% at 100% 0%, rgba(240,70,143,.13), transparent 56%),
        radial-gradient(120% 90% at 0% 100%, rgba(45,212,238,.12), transparent 56%),
        var(--bg);

    /* type families (Inter loaded in Task 5/Phase 1; falls back gracefully) */
    --font-display: 'Space Grotesk', 'Segoe UI', system-ui, sans-serif;
    --font-text:    'Inter', 'Segoe UI', system-ui, sans-serif;
    --font-mono:    ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;

    /* type scale */
    --text-xs:   .72rem;
    --text-sm:   .85rem;
    --text-base: .95rem;
    --text-md:   1.05rem;
    --text-lg:   1.3rem;
    --text-xl:   1.7rem;
    --text-2xl:  2.2rem;
    --text-3xl:  3rem;

    /* spacing scale (4px base) */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
    --space-7: 40px;
    --space-8: 48px;

    /* radius (adds the pill; --r/--r-sm/--r-lg already exist) */
    --r-pill: 999px;

    /* shadow tokens (replace copy-pasted literals in Phase 1) */
    --shadow-card:  0 1px 2px rgba(0,0,0,.4);
    --shadow-modal: 0 24px 60px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.02);
    --glow:         0 0 22px;
}
```

- [ ] **Step 2: Add the light-theme override block immediately after the `:root` block**

Right after the closing `}` of `:root` (now the line after `--glow`), insert:

```css
/* ── Light theme overrides ────────────────────────────────────────
   Phase 0: functional + unbroken, not yet polished (that's Phase 1).
   Only semantic tokens flip; brand accents stay vivid.               */
:root[data-theme="light"] {
    --bg:           #ffffff;
    --bg-deep:      #fafafa;
    --surface:      #ffffff;
    --surface-2:    #f5f5f5;
    --surface-3:    #ededed;
    --line:         #eaeaea;
    --line-strong:  #d4d4d8;

    --text:         #171717;
    --text-dim:     #52525a;
    --text-faint:   #8a8a93;
    --text-strong:  #0a0a0a;

    --gray-50:  #fafafa;
    --gray-100: #f5f5f5;
    --gray-200: #ededed;
    --gray-300: #e4e4e7;
    --gray-400: #d4d4d8;
    --gray-500: #a1a1aa;
    --gray-600: #71717a;
    --gray-700: #52525a;
    --gray-800: #27272a;
    --gray-900: #0a0a0a;

    --bg-wash:
        radial-gradient(120% 80% at 100% 0%, rgba(240,70,143,.05), transparent 56%),
        radial-gradient(120% 90% at 0% 100%, rgba(45,212,238,.05), transparent 56%),
        var(--bg);

    --shadow-card:  0 1px 2px rgba(0,0,0,.06);
    --shadow-modal: 0 24px 60px rgba(0,0,0,.14), inset 0 0 0 1px rgba(0,0,0,.02);
}
```

- [ ] **Step 3: Point `body` background at the wash token**

In `static/style.css`, replace the `body` background declaration (lines 54-57):

```css
    background:
        radial-gradient(120% 80% at 100% 0%, rgba(240,70,143,.13), transparent 56%),
        radial-gradient(120% 90% at 0% 100%, rgba(45,212,238,.12), transparent 56%),
        var(--bg);
```

with:

```css
    background: var(--bg-wash);
```

(Dark `--bg-wash` is the exact same radial stack, so dark mode is byte-for-byte identical.)

- [ ] **Step 4: Replace hardcoded `#f4f5fb` heading colors with `var(--text-strong)`**

In `static/style.css`, change each `#f4f5fb` to `var(--text-strong)`. There are 6 occurrences:
- `.wordmark` → `color: var(--text-strong);` (was line 88)
- bare `h1` → `color: var(--text-strong);` (was line 100)
- `.unsupported-overlay h2` → `color: var(--text-strong);` (was line 219)
- `.legal .doc-home` → `color: var(--text-strong);` (was line 306)
- `.legal h1.doc-title` → `color: var(--text-strong);` (was line 321)
- `.legal h2` → `color: var(--text-strong);` (was line 325)

Run this to confirm none remain:

Run: `grep -n "#f4f5fb" static/style.css`
Expected: no output.

- [ ] **Step 5: Verify dark mode is unchanged + existing tests pass**

Run: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q`
Expected: PASS (CSS change cannot affect these, but confirm nothing else regressed).

Start the app and eyeball the landing/legal pages in **dark** (no `data-theme` yet, so `:root` defaults apply):

Run: `python app.py` then open http://localhost:5000 and http://localhost:5000/static/terms.html
Expected: visually identical to before this task (neon dark). The wordmark, headings, and legal text all render correctly.

- [ ] **Step 6: Commit**

```bash
git add static/style.css
git commit -m "feat(tokens): add neutral/type/space/shadow tokens + light override layer"
```

---

## Task 3: Motion tokens + global reduced-motion guard

**Files:**
- Modify: `static/style.css` (append at end of file)

- [ ] **Step 1: Append motion tokens to the `:root` block**

In `static/style.css`, inside `:root`, just before its closing `}` (right after the `--glow` line added in Task 2), add:

```css
    /* motion */
    --dur-fast:   120ms;
    --dur-base:   200ms;
    --dur-slow:   360ms;
    --ease-out:   cubic-bezier(.2,.7,.2,1);
    --ease-spring: cubic-bezier(.2,1.3,.4,1);
```

- [ ] **Step 2: Append the global reduced-motion guard at the end of `style.css`**

Append to the end of `static/style.css`:

```css
/* ============================================================
   Accessibility: honor prefers-reduced-motion globally.
   Animations/transitions collapse to (near) instant; visual
   states remain intact (e.g. on-fire stays vivid, just static).
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
        scroll-behavior: auto !important;
    }
}
```

- [ ] **Step 3: Verify**

Run: `python app.py` then open http://localhost:5000
Expected: unchanged appearance. (Optionally enable OS "reduce motion" and confirm hover transitions no longer animate.)

- [ ] **Step 4: Commit**

```bash
git add static/style.css
git commit -m "feat(motion): add motion tokens + global prefers-reduced-motion guard"
```

---

## Task 4: Component base classes + universal `:focus-visible` (additive)

**Files:**
- Modify: `static/style.css` (append a "Components" section at end)

These classes are defined now and applied during Phase 1. The focus ring is the one immediately-visible change (accessibility).

- [ ] **Step 1: Append the components section**

Append to the end of `static/style.css`:

```css
/* ============================================================
   Reusable components (Phase 0 foundation; applied in Phase 1)
   ============================================================ */

/* Button system — .btn + variant. Existing global button{} rules on the
   landing are untouched; .btn is opt-in and used during the Phase 1 re-skin. */
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: auto;
    padding: 10px 16px;
    border-radius: var(--r);
    border: 1px solid transparent;
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    transition: filter var(--dur-fast), background var(--dur-fast),
                border-color var(--dur-fast), transform var(--dur-fast);
}
.btn:active { transform: translateY(1px); }
.btn--primary   { background: var(--p); color: #04121a; }
.btn--primary:hover { filter: brightness(1.07); }
.btn--secondary { background: var(--surface-2); color: var(--text); border-color: var(--line); }
.btn--secondary:hover { background: var(--surface-3); border-color: var(--line-strong); }
.btn--ghost     { background: transparent; color: var(--text-dim); }
.btn--ghost:hover { color: var(--text); background: var(--surface-2); }
.btn:disabled  { background: var(--surface-2); color: var(--text-faint); cursor: not-allowed; filter: none; }

.panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r);
    box-shadow: var(--shadow-card);
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 3px 10px;
    border-radius: var(--r-pill);
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: .04em;
}

.chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--surface-2);
    font-size: var(--text-sm);
}

/* Universal keyboard focus ring (reuses the input ring idiom). Visible only
   for keyboard users; does not affect mouse interaction. */
:focus-visible {
    outline: none;
    border-radius: var(--r-sm);
    box-shadow: 0 0 0 3px var(--p-soft), 0 0 0 1px var(--p-line);
}
```

- [ ] **Step 2: Verify**

Run: `python app.py` then open http://localhost:5000 and Tab through the search box / button / results.
Expected: visible focus ring appears on keyboard focus; mouse clicks look unchanged; no layout shifts.

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "feat(components): add .btn/.panel/.pill/.chip + universal :focus-visible"
```

---

## Task 5: No-FOUC theme boot (landing + legal honor preference; player pinned dark)

**Files:**
- Modify: `static/index.html` (`<head>`, after line 9)
- Modify: `static/terms.html`, `static/privacy.html`, `static/dmca.html` (each `<head>`, after its `style.css` link)
- Modify: `static/player.html` (`<head>`, after line 9 `style.css` link, before the `<style>` block on line 10)

- [ ] **Step 1: Add the boot to `index.html`**

In `static/index.html`, immediately after line 9 (`<link rel="stylesheet" href="/static/style.css">`), insert:

```html
    <!-- Theme boot: set data-theme before first paint to avoid a flash. -->
    <script src="/static/theme-helpers.js"></script>
    <script>
      (function () {
        try {
          var stored = localStorage.getItem(window.KaraokeeTheme.THEME_STORAGE_KEY);
          var prefersLight = window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: light)').matches;
          document.documentElement.setAttribute(
            'data-theme',
            window.KaraokeeTheme.resolveInitialTheme({ stored: stored, prefersLight: prefersLight })
          );
        } catch (e) {
          document.documentElement.setAttribute('data-theme', 'dark');
        }
      })();
    </script>
```

- [ ] **Step 2: Add the identical boot to the three legal pages**

In each of `static/terms.html`, `static/privacy.html`, `static/dmca.html`, find the `<link rel="stylesheet" href="/static/style.css">` line in `<head>` and insert the **exact same** two `<script>` blocks from Step 1 immediately after it.

- [ ] **Step 3: Pin the player to dark (Phase 0)**

In `static/player.html`, immediately after line 9 (`<link rel="stylesheet" href="/static/style.css">`) and before the `<style>` block (line 10), insert:

```html
    <!-- Phase 0: the player stage is not themed yet, so pin dark to keep it
         visually unchanged. Phase 1 replaces this with the shared theme boot
         (script src theme-helpers.js + resolveInitialTheme) once the stage is
         token-driven. -->
    <script>
      document.documentElement.setAttribute('data-theme', 'dark');
    </script>
```

- [ ] **Step 4: Verify the toggle target exists and dark is still default**

Run: `python app.py` then open http://localhost:5000.
In DevTools console:

```js
document.documentElement.getAttribute('data-theme')
```

Expected: `'dark'` on a fresh profile (no stored pref, OS dark) — landing unchanged. Then:

```js
document.documentElement.setAttribute('data-theme','light')
```

Expected: landing flips to a **functional light** version (white surfaces, dark readable text, visible wordmark — not polished, but nothing invisible/broken). Open http://localhost:5000/static/terms.html and repeat — legal page flips cleanly. Open http://localhost:5000/player — confirm it stays dark/unchanged regardless.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/terms.html static/privacy.html static/dmca.html static/player.html
git commit -m "feat(theme): no-FOUC theme boot (landing+legal honor pref; player pinned dark)"
```

---

## Task 6: Theme toggle — `theme-toggle.js` + button UI (landing + legal)

**Files:**
- Create: `static/theme-toggle.js`
- Modify: `static/style.css` (append toggle styles)
- Modify: `static/index.html` (add toggle button + script include)
- Modify: `static/terms.html`, `static/privacy.html`, `static/dmca.html` (add toggle button + script include)

- [ ] **Step 1: Create the toggle wiring file**

Create `static/theme-toggle.js`:

```js
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
```

- [ ] **Step 2: Append toggle button styles to `style.css`**

Append to the end of `static/style.css`:

```css
/* ============================================================
   Theme toggle button (fixed, top-right; landing + legal)
   ============================================================ */
.theme-toggle {
    position: fixed;
    top: 14px;
    right: 14px;
    width: 38px;
    height: 38px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    color: var(--text-dim);
    cursor: pointer;
    z-index: 10000;
    transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.theme-toggle:hover { color: var(--text); border-color: var(--line-strong); }
.theme-toggle svg { width: 18px; height: 18px; display: block; }
/* Show sun in dark mode (click -> go light), moon in light mode. */
.theme-toggle .ico-moon { display: none; }
.theme-toggle .ico-sun  { display: block; }
:root[data-theme="light"] .theme-toggle .ico-sun  { display: none; }
:root[data-theme="light"] .theme-toggle .ico-moon { display: block; }
```

- [ ] **Step 3: Add the toggle button to `index.html`**

In `static/index.html`, immediately after `<body class="has-footer">` (line 11), insert:

```html
    <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch theme" title="Switch theme">
      <svg class="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      <svg class="ico-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
```

- [ ] **Step 4: Include `theme-toggle.js` on `index.html`**

In `static/index.html`, immediately before the closing `</body>` (line 452), add:

```html
    <script src="/static/theme-toggle.js" defer></script>
```

- [ ] **Step 5: Add the toggle button + script include to the three legal pages**

In each of `static/terms.html`, `static/privacy.html`, `static/dmca.html`:
- Insert the **same** `<button id="themeToggle" …>…</button>` markup from Step 3 immediately after the opening `<body …>` tag.
- Insert `<script src="/static/theme-toggle.js" defer></script>` immediately before `</body>`.

- [ ] **Step 6: Verify the toggle works end-to-end**

Run: `python app.py` then open http://localhost:5000.
- Click the top-right toggle: page flips dark↔light; the sun/moon icon swaps.
- Reload: the chosen theme **persists** (localStorage).
- In console: `localStorage.getItem('audiopian-theme')` returns the last choice.
- Repeat on http://localhost:5000/static/terms.html.
- Confirm http://localhost:5000/player has **no** toggle and stays dark.

- [ ] **Step 7: Commit**

```bash
git add static/theme-toggle.js static/style.css static/index.html static/terms.html static/privacy.html static/dmca.html
git commit -m "feat(theme): add persistent theme toggle to landing + legal pages"
```

---

## Task 7: Extract `player.html` inline `<style>` into `style.css` (verbatim, dark-pinned)

**Files:**
- Modify: `static/player.html` (remove the inline `<style>…</style>` block that begins at line 10)
- Modify: `static/style.css` (append the extracted rules under a "Player" section)

This is a **pure relocation** — no rule changes. The player must look pixel-identical afterward.

- [ ] **Step 1: Read the full inline style block**

Run: `sed -n '10,/<\/style>/p' static/player.html` (or open `static/player.html` and locate the `<style>` on line 10 through its matching `</style>`).
Note the exact start/end lines for the next step.

- [ ] **Step 2: Append the extracted CSS to `style.css`**

Append to the end of `static/style.css`:

```css
/* ============================================================
   Player page (extracted verbatim from player.html inline <style>
   in Phase 0; re-skinned onto tokens in Phase 1). Player is pinned
   to the dark theme for now, so these dark values are correct.
   ============================================================ */
```

Then paste the entire contents **between** the `<style>` and `</style>` tags from `player.html` directly below that comment, unchanged (including the `body { display: block; padding: 0; }` rule on the first line of the block).

- [ ] **Step 3: Remove the inline block from `player.html`**

In `static/player.html`, delete the `<style>` opening tag (line 10), all rules through, and the closing `</style>` tag — leaving the `<head>` with just the meta/title/font/stylesheet links and the Phase-0 dark-pin `<script>` from Task 5.

- [ ] **Step 4: Verify the player is pixel-identical**

Run: `python app.py` then open http://localhost:5000/player (load a song / use the local-upload dev path if needed).
Expected: the player header, lyric stage, arcade HUD, prep overlay, count-in, debug HUD, and end-screen modal all look exactly as before. No unstyled flashes, no missing styles.

Confirm there is no leftover inline `<style>` in the player:

Run: `grep -c "<style" static/player.html`
Expected: `0`.

- [ ] **Step 5: Run the full test suite (guard against accidental breakage)**

Run the JS helper tests and Python tests:

```bash
node tests/test_theme_helpers.cjs
node tests/test_browser_support.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add static/player.html static/style.css
git commit -m "refactor(player): extract inline <style> into shared style.css (no visual change)"
```

---

## Task 8: Phase 0 integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run every JS `.cjs` test**

Run each test under `tests/*.cjs` (the full list is in CLAUDE.md "Run JS tests"), e.g.:

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … tests passed." line; no failures.

- [ ] **Step 2: Run the Python suite**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS.

- [ ] **Step 3: Manual theme matrix (preview)**

Run: `python app.py`. For each of `/` (landing) and `/static/terms.html` (legal):
- Fresh load defaults to **dark**, looking identical to pre-Phase-0.
- Toggle → **light**: functional, nothing invisible/broken.
- Reload → choice persists.
For `/player`: stays **dark**, visually identical, no toggle.

- [ ] **Step 4: Confirm the branch state**

```bash
git log --oneline feat/ux-geist-redesign -8
git status
```

Expected: 7 new Phase-0 commits on `feat/ux-geist-redesign`; clean working tree.

---

## Phase 0 done — what's next

Phase 0 delivers the dual-theme token + component foundation, a persistent toggle (landing + legal), the reduced-motion guard, and the player CSS relocated into the shared sheet — with dark mode unchanged. The visible Geist re-skin, the player's theme participation + its toggle, Inter/Lucide adoption, the scoring-feedback rebuild, on-fire, and word-fill all live in subsequent phase plans:

- **Phase 1** — re-skin all surfaces onto the tokens/components; apply `.btn`/`.panel`/etc.; Inter + Lucide; thumbnails; status-system fix; head hygiene; dead-UI cleanup; player joins the theme system + gets its toggle.
- **Phase 2** — unified score panel + reward feedback (+points popup, count-up, tier-up, streak milestones, PERFECT/NICE verdicts) + the C beat-synced on-fire + share-card rebuild + results staged entrance.
- **Phase 3** — progressive word-by-word fill (behind its helper + tests, verified against scoring honesty).

Each subsequent phase gets its own detailed plan once this one is executed and the token/component API is concrete.
