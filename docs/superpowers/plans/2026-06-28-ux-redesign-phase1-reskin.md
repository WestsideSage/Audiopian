# UX Redesign — Phase 1: Re-skin Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin every surface (landing, prep overlay, player shell, results, legal, shared footer) onto the Phase-0 token/component layer; make **light mode fully polished** while keeping dark visually intact; vendor a no-build **Lucide inline-SVG** icon set replacing every emoji/entity; load the **Inter** webfont; add **favicon + meta description + OG/Twitter cards**; add **thumbnails to both pickers**; **unify the `#status`/`#searchStatus` systems** and add the missing `.error`/`.success` styling; do the audit-verified **dead-UI cleanup**; and **make the player join the theme system** (replace its Phase-0 dark-pin script with the shared theme boot + add its own `#themeToggle`).

**Architecture:** Render-layer only. All scoring logic (`scoring-arcade.js` / `scoring-session.js` / `scoring.js` / `phrase-engine.js`) is **frozen** — untouched. Styling lives in `static/style.css` (the single source of truth seeded by Phase 0). Markup/icon/status/thumbnail/theme-boot edits land in `static/index.html`, `static/player.html`, `static/player.js`, `static/terms.html`, `static/privacy.html`, `static/dmca.html`. No new pure-logic helpers are introduced in this phase (the three scoring/on-fire/word-fill helpers belong to Phases 2–3); the only new JS file is a tiny optional icon-injection convenience — but icons are written as **literal inline SVG** in markup, so no runtime icon framework is added.

**Tech Stack:** Plain HTML/CSS/JS (no build step), Flask static serving (`python app.py` → http://localhost:5000), Node for JS `.cjs` tests, pytest for Python. Lucide icons are pasted as raw `<svg>` path data (no npm, no bundler). Inter + Space Grotesk via Google Fonts `<link>` (matching the existing Space Grotesk pattern).

**Depends on:** **Phase 0** (`docs/superpowers/plans/2026-06-28-ux-redesign-phase0-foundation.md`) — this plan consumes the tokens (`--bg --surface --surface-2 --surface-3 --line --line-strong --text --text-dim --text-faint --text-strong --bg-wash`, neutral ramp `--gray-50..--gray-900`, brand `--p --s --p-soft --p-line --grad-accent`, fire `--fire-a --fire-b --fire-c`, scoring `--key --matched --partial --missed`, type `--font-display --font-text --font-mono` + `--text-xs..--text-3xl`, spacing `--space-1..--space-8`, radius `--r-sm --r --r-lg --r-pill`, shadows `--shadow-card --shadow-modal --glow`, motion `--dur-fast --dur-base --dur-slow --ease-out --ease-spring`), the component classes (`.btn`/`.btn--primary`/`.btn--secondary`/`.btn--ghost`, `.panel`, `.pill`, `.chip`, universal `:focus-visible`), and the theme system (`static/theme-helpers.js` → `window.KaraokeeTheme`, `static/theme-toggle.js`, `#themeToggle`, `data-theme` on `<html>`). **Phase 0 must be merged first.**

**Spec:** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` — this implements **§3.3** (surfaces re-skin), **§3.5** (icons + head hygiene), **§3.6** (dead-UI cleanup), plus the thumbnail pickers, status-system unification, and the player joining the theme system. Branch: `feat/ux-geist-redesign`.

---

## Reading order & ground rules (read before starting)

- **Dark mode is the regression baseline.** After every task, dark mode must still look right (this is a re-skin onto tokens, not a redesign of the dark palette). The *new* deliverable here is that **light mode is now polished**, not merely unbroken.
- **`player.js` is the only DOM-bound file.** Do not add scoring branches to it; the only edits are icon-string swaps, the status helper unification (none in player.js — it has no `#status`), thumbnail rendering (none in player.js — pickers live in `index.html`), and the share-filename + share-card color fixes that §3.6/§3.7 mandate. (The full share-card *rebuild* is Phase 2; Phase 1 only does the two one-line cleanups the §3.6 list names: the `karaokee-score.png` → `audiopian-score.png` rename. The `#8b5cf6` color fix is left for the Phase-2 share-card rebuild to avoid touching the canvas twice — noted in Risks.)
- **Icons are literal inline `<svg>`.** Paste the exact Lucide path data given in each task. Do **not** add a CDN script or an icon font (no build step, no extra network dependency). Each `<svg>` carries `aria-hidden="true"` and the control keeps its accessible name via visible text or `aria-label`.
- **Anchors are stable strings/selectors**, not raw line numbers (Phase 0 already shifted `style.css` line numbers, and earlier Phase-1 tasks shift them further). Where a line number is given it is parenthetical (`currently ~L###`) only.
- **Windows + template literals:** none of the edits below introduce new backtick template literals into a `.js` file via the shell. All `.js` edits use the Edit tool directly. (`player.js` already uses some template literals; we only touch plain string literals there.)
- **Commit cadence:** one commit per task, conventional messages. **All tasks serialize on `static/style.css`** (every task appends to or edits it), so they cannot be parallelized across worktrees — run them in order. Independently *reviewable/committable* task-groups are called out: **Legal pages** (Tasks 12–13), **Landing** (Tasks 5–9), **Player shell** (Tasks 14–18). Within those groups the order given is the safe one.

### Lucide icon path-data reference (used verbatim across tasks)

Each icon below is the Lucide 24×24 stroke glyph. Reuse these exact strings. Standard wrapper attributes for a **stroke** icon:
`viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`

- **play** (`▶`): `<polygon points="6 3 20 12 6 21 6 3"/>`
- **pause** (`⏸`): `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`
- **skip-back** (`⏮`): `<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>`
- **skip-forward** (`⏭`): `<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>`
- **volume-2** (`🔊`): `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`
- **mic** (`🎤`): `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>`
- **gamepad-2** (`🎮`): `<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="2"/>`
- **flame** (`🔥`): `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`
- **arrow-left** (`←`): `<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`
- **check** (`✓`): `<polyline points="20 6 9 17 4 12"/>`
- **music** (`♪`, no-lyrics placeholder): `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`
- **sun** (theme): `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`
- **moon** (theme): `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`

---

## Task 1: Load the Inter webfont + an `.icon` helper class

**Files:**
- Modify: `static/index.html`, `static/player.html`, `static/terms.html`, `static/privacy.html`, `static/dmca.html` (the Google Fonts `<link>` in each `<head>`)
- Modify: `static/style.css` (append an `.icon` utility)

Every page already loads Space Grotesk via one Google Fonts `<link>`. We extend that same line to also request **Inter**, and add a small `.icon` class so inline SVGs share one sizing rule.

- [ ] **Step 1: Extend the font request on all five pages**

In each of `static/index.html`, `static/player.html`, `static/terms.html`, `static/privacy.html`, `static/dmca.html`, find this exact line in `<head>`:

```html
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Replace it with (adds the Inter families in one request):

```html
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Make body text use `--font-text` (Inter)**

In `static/style.css`, find the `body` rule (`font-family: var(--font);` — `--font` was the Phase-0/legacy Space Grotesk alias). Change that one declaration to:

```css
    font-family: var(--font-text);
```

(Display headings opt back into `--font-display` explicitly in later tasks; body/UI now reads as Inter.)

- [ ] **Step 3: Append the `.icon` utility to `style.css`**

Append to the end of `static/style.css`:

```css
/* ============================================================
   Inline SVG icon sizing (Lucide glyphs pasted as raw <svg>).
   currentColor inherits the button/text color; em sizing keeps
   icons aligned to adjacent text.
   ============================================================ */
.icon {
    width: 1.1em;
    height: 1.1em;
    display: inline-block;
    vertical-align: -0.15em;
    flex-shrink: 0;
    stroke: currentColor;
    fill: none;
}
```

- [ ] **Step 4: Verify**

Run: `python app.py` then open http://localhost:5000 and http://localhost:5000/static/terms.html.
Expected: pages still render; body text now uses Inter (subtle — a slightly more neutral sans than Space Grotesk). No layout breakage. In DevTools, confirm `document.fonts.check('1em Inter')` is `true` after fonts load.

- [ ] **Step 5: Run regression suites**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
node tests/test_browser_support.cjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/player.html static/terms.html static/privacy.html static/dmca.html static/style.css
git commit -m "feat(type): load Inter webfont + add .icon utility; body uses --font-text"
```

---

## Task 2: Head hygiene — favicon, meta description, OG/Twitter cards

**Files:**
- Create: `static/favicon.svg`
- Modify: `static/index.html`, `static/player.html`, `static/terms.html`, `static/privacy.html`, `static/dmca.html` (`<head>`)

Spec §3.5: favicon + meta description + OG/Twitter on all pages. Non-mobile head hygiene only (no viewport changes on the landing/player).

- [ ] **Step 1: Create an SVG favicon (the brand gradient dot)**

Create `static/favicon.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2dd4ee"/>
      <stop offset="1" stop-color="#f0468f"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="#0a0b14"/>
  <rect x="9" y="9" width="14" height="14" rx="4" fill="url(#g)"/>
</svg>
```

- [ ] **Step 2: Add favicon + meta to `index.html` `<head>`**

In `static/index.html`, immediately after the `<title>Audiopian</title>` line, insert:

```html
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <meta name="description" content="Audiopian — sing along to any song in your browser. Free, scored, real-time lyrics. No downloads.">
    <meta property="og:title" content="Audiopian — sing any song, scored, in your browser">
    <meta property="og:description" content="Search any song and sing along. Free, scored, real-time lyrics — no downloads.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://audiopian.com/">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Audiopian — sing any song, scored, in your browser">
    <meta name="twitter:description" content="Search any song and sing along. Free, scored, real-time lyrics — no downloads.">
```

- [ ] **Step 3: Add the same favicon + tailored meta to the other four pages**

For each page, insert the favicon link + meta block immediately after its existing `<title>…</title>` line, with the per-page title/description/url below. (`player.html`: `<title>Audiopian — Player</title>`; `terms.html`/`privacy.html`/`dmca.html` each have their own `<title>`.)

`static/player.html` — after `<title>Audiopian — Player</title>`:

```html
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <meta name="description" content="Audiopian player — sing along to your chosen song with live scoring.">
    <meta property="og:title" content="Audiopian — Player">
    <meta property="og:description" content="Sing along with live scoring in Audiopian.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://audiopian.com/player">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Audiopian — Player">
    <meta name="twitter:description" content="Sing along with live scoring in Audiopian.">
```

`static/terms.html` — after its `<title>`:

```html
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <meta name="description" content="Audiopian Terms of Service — plain-English terms for using the free browser singing game.">
    <meta property="og:title" content="Audiopian — Terms of Service">
    <meta property="og:description" content="Plain-English terms for using Audiopian.">
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://audiopian.com/terms">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Audiopian — Terms of Service">
    <meta name="twitter:description" content="Plain-English terms for using Audiopian.">
```

`static/privacy.html` — after its `<title>`:

```html
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <meta name="description" content="Audiopian Privacy Policy — what we collect, what we send to speech recognition, and what we don't store.">
    <meta property="og:title" content="Audiopian — Privacy Policy">
    <meta property="og:description" content="How Audiopian handles your microphone audio and data.">
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://audiopian.com/privacy">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Audiopian — Privacy Policy">
    <meta name="twitter:description" content="How Audiopian handles your microphone audio and data.">
```

`static/dmca.html` — after its `<title>`:

```html
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <meta name="description" content="Audiopian DMCA / copyright takedown — how to report alleged infringement.">
    <meta property="og:title" content="Audiopian — DMCA / Copyright Takedown">
    <meta property="og:description" content="How to report alleged copyright infringement to Audiopian.">
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://audiopian.com/dmca">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="Audiopian — DMCA / Copyright Takedown">
    <meta name="twitter:description" content="How to report alleged copyright infringement to Audiopian.">
```

- [ ] **Step 4: Verify**

Run: `python app.py` then open http://localhost:5000.
Expected: a gradient-dot favicon shows in the browser tab. In DevTools, `document.querySelector('meta[name=description]').content` is non-empty; `document.querySelector('meta[property="og:title"]')` exists. Repeat for `/player` and the three legal pages (each tab shows the favicon).

- [ ] **Step 5: Commit**

```bash
git add static/favicon.svg static/index.html static/player.html static/terms.html static/privacy.html static/dmca.html
git commit -m "feat(head): add favicon + meta description + OG/Twitter cards on all pages"
```

---

## Task 3: Unify the status systems + add `.error`/`.success` to `#searchStatus` (CSS)

**Files:**
- Modify: `static/style.css`

Spec §3.3: there is no `#searchStatus.error/.success` rule today, so primary-path errors ("No songs found") render colorless. The `#status` rule exists (`#status.error`/`#status.success`). Unify both into one shared `.status-msg` treatment that both `#status` and `#searchStatus` opt into, and give `#searchStatus` the missing color states. (Markup `role` attributes are added in Task 5.)

- [ ] **Step 1: Replace the standalone `#status` block with a shared status rule**

In `static/style.css`, find this block (currently in the landing section):

```css
#status {
    margin-top: 16px;
    text-align: center;
    font-size: .9rem;
    min-height: 1.2em;
    color: var(--text-dim);
}
#status.error { color: var(--missed); }
#status.success { color: var(--matched); }
```

Replace it with:

```css
/* ---- unified status messages (#status + #searchStatus share one treatment) ---- */
#status,
#searchStatus {
    margin-top: var(--space-4);
    text-align: center;
    font-size: var(--text-base);
    min-height: 1.2em;
    color: var(--text-dim);
    line-height: 1.5;
}
#searchStatus { margin-top: var(--space-3); }
#status.error,
#searchStatus.error   { color: var(--missed); }
#status.success,
#searchStatus.success { color: var(--matched); }
```

- [ ] **Step 2: Verify both error + success states are colored**

Run: `python app.py` then open http://localhost:5000.
In the search box type gibberish (e.g. `zzzzqxq`) and press Enter.
Expected: "No songs found for …" now renders in **red** (the `--missed` color), not grey. Then load a working flow (search a real song) and confirm the "Loading player…" path shows the green success color via `#status`.

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "fix(status): unify #status/#searchStatus styling + add missing error/success colors"
```

---

## Task 4: Dead-UI cleanup in `style.css` + `player.html` CSS (§3.6, verified)

**Files:**
- Modify: `static/style.css`
- Modify: `static/player.html` (the player CSS now lives in `style.css` after Phase 0 Task 7 — confirm where each rule physically sits before editing)

> **Locate first:** After Phase 0, the player's CSS was moved into `static/style.css` (Phase 0 Task 7). So `@keyframes confirmPulse`, `.word-span.asr-confirmed`, `.game-modal-title/-score/-stats` now live in `style.css`, not `player.html`. Search `style.css` for each selector below; if Phase 0 was executed, they are there. (If for any reason they remain inline, edit them in `player.html` instead — same removals.)

- [ ] **Step 1: Remove `confirmPulse` keyframes + `.asr-confirmed` rule**

In `static/style.css`, delete this entire block (the class is only ever *removed* in `player.js`, never added — see `_resetLineSpans`):

```css
        @keyframes confirmPulse {
            0%   { text-shadow: 0 0 0px #fff; }
            50%  { text-shadow: 0 0 8px #fff, 0 0 16px var(--matched); }
            100% { text-shadow: 0 0 0px #fff; }
        }

        .word-span.asr-confirmed {
            animation: confirmPulse 0.4s ease-out;
        }
```

(Leading indentation may differ if Phase 0 reindented during extraction; match whatever is present. Use `Grep` for `confirmPulse` to find the exact text.)

- [ ] **Step 2: Drop the dangling `'asr-confirmed'` from the classList.remove in `player.js`**

In `static/player.js`, find (in `_resetLineSpans`):

```js
                s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
```

Replace with:

```js
                s.classList.remove('matched', 'matched-partial', 'missed');
```

- [ ] **Step 3: Remove the superseded `.game-modal-title/-score/-stats` rules**

In `static/style.css`, delete these three rules (CSS-only, no HTML/JS reference — the end screen uses `.grade-*`):

```css
        .game-modal-title {
            font-size: 1.3rem;
            color: var(--text);
            font-weight: 700;
            margin-bottom: 16px;
        }

        .game-modal-score {
            font-size: 3rem;
            font-weight: 800;
            color: var(--matched);
            margin-bottom: 20px;
            font-variant-numeric: tabular-nums;
        }

        .game-modal-stats {
            color: var(--text-dim);
            font-size: 0.95rem;
            line-height: 2;
            margin-bottom: 28px;
        }
```

- [ ] **Step 4: Remove `.tagline a` / `.tagline a:hover` (tagline is plain text)**

In `static/style.css`, delete:

```css
.tagline a { color: var(--p); text-decoration: none; }
.tagline a:hover { text-decoration: underline; }
```

- [ ] **Step 5: Remove the bare-`h1` fallback rule**

In `static/style.css`, delete (all h1s are `.wordmark` / `h1.doc-title`):

```css
/* fallback for any bare h1 */
h1 { font-size: 1.85rem; text-align: center; color: var(--text-strong); }
```

(The color was `#f4f5fb` before Phase 0 remapped it to `var(--text-strong)` — match whatever is present.)

- [ ] **Step 6: Remove the orphaned `.hint-text` + `label .hint` rules**

The `.hint-text` paragraph and the `<span class="hint">` markup are removed in Task 6 (landing markup). Remove their CSS now. In `static/style.css`, delete:

```css
label .hint {
    color: var(--text-faint);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
}
```

and:

```css
/* ---- small helper text (consolidated from inline styles) ---- */
.hint-text {
    font-size: .78rem;
    color: var(--text-faint);
    margin: -8px 0 10px;
    line-height: 1.5;
}
```

- [ ] **Step 7: Wire `--key` (don't delete) — apply it to the key-word cue**

Spec §3.6 says this redesign **wires** `--key`. In `static/style.css`, find the active-line key-word cue (now in the player section after Phase 0):

```css
        .lyric-line.active .word-span.key-word:not(.matched):not(.matched-partial):not(.missed) {
            color: var(--p);
            text-shadow: 0 0 12px rgba(45,212,238,.45);
        }
```

Replace `color: var(--p);` with `color: var(--key);`:

```css
        .lyric-line.active .word-span.key-word:not(.matched):not(.matched-partial):not(.missed) {
            color: var(--key);
            text-shadow: 0 0 12px rgba(45,212,238,.45);
        }
```

Also update the difficulty-preview target cue to use `--key` (same intent). Find:

```css
        .dp-word.dp-target { color: #fff; font-weight: 700; text-shadow: 0 0 8px var(--p), 0 0 14px rgba(45,212,238,.5); }
```

Replace with:

```css
        .dp-word.dp-target { color: var(--text-strong); font-weight: 700; text-shadow: 0 0 8px var(--key), 0 0 14px rgba(45,212,238,.5); }
```

(`--key` resolves to `--p` per Phase 0, so this is visually identical in dark — but now `--key` is genuinely consumed, satisfying §3.6.)

- [ ] **Step 8: Remove the dead landing `--fire-a`/`--fire-b` note**

Phase 0 moved `--fire-a`/`--fire-b`/`--fire-c` into the shared `:root` token layer (they are now consumed by the player on-fire rules, which also live in `style.css`). No separate "landing sheet" copy remains. **No action needed** beyond confirming there is exactly one definition of each in `:root`:

Run: `grep -n -- "--fire-a\|--fire-b\|--fire-c" static/style.css`
Expected: each appears once as a definition in `:root` (plus their *uses* in `.ah-fire`, `.ah-streak`, `body.arcade-onfire`, `.nb-ribbon`). No duplicate definition blocks.

- [ ] **Step 9: Verify nothing visual regressed**

Run: `python app.py`.
- http://localhost:5000 — landing unchanged (tagline still plain text; hint paragraph gone after Task 6, but its CSS removal here is harmless now since the markup still references nothing).
- http://localhost:5000/player — load a song, enter Game Mode, confirm the active key-word still glows cyan (now via `--key`), the end screen still shows the grade hero, and no console errors.

Run: `grep -n "confirmPulse\|asr-confirmed\|game-modal-title\|game-modal-score\|game-modal-stats\|hint-text" static/style.css static/player.js`
Expected: no output (all removed).

- [ ] **Step 10: Commit**

```bash
git add static/style.css static/player.js
git commit -m "chore(dead-ui): remove confirmPulse/.asr-confirmed, .game-modal-* , .tagline a, bare h1, .hint; wire --key"
```

---

## Task 5: Landing — header (wordmark + theme toggle) + status roles + search button loading

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

> **Independently committable group: Landing (Tasks 5–9).**

- [ ] **Step 1: Give the landing card a header row with the theme toggle**

In `static/index.html`, the wordmark currently sits at the top of `.card`:

```html
    <div class="card">
        <h1 class="wordmark"><span class="logo-dot"></span>Audiopian</h1>
```

Replace those two lines with a header row that carries the wordmark + the shared `#themeToggle`:

```html
    <div class="card">
        <div class="card-head">
            <h1 class="wordmark"><span class="logo-dot"></span>Audiopian</h1>
            <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch theme" title="Switch theme">
              <svg class="ico-sun icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              <svg class="ico-moon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            </button>
        </div>
```

> **Note:** If Phase 0 Task 6 already added a **fixed** `#themeToggle` to `index.html` (it did — `position: fixed; top/right`), **remove that fixed button** now so there is exactly one `#themeToggle`. Search `index.html` for `id="themeToggle"`; keep only the in-header one added here. The shared `.theme-toggle` CSS from Phase 0 stays, but we override its positioning to sit in the header (Step 3).

- [ ] **Step 2: Make the wordmark a display-font heading and tighten the tagline**

In `static/style.css`, update `.wordmark` to use the display font token + scale token (replaces the hardcoded `1.85rem`):

Find:

```css
.wordmark {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 13px;
    font-size: 1.85rem;
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--text-strong);
    margin-bottom: 10px;
}
```

Replace with:

```css
.wordmark {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--text-strong);
    margin: 0;
}
```

(Removed the `justify-content: center` + bottom margin since the header row now lays it out.)

- [ ] **Step 3: Add `.card-head` + re-home `.theme-toggle` into the header**

Append to the end of `static/style.css`:

```css
/* ---- landing card header (wordmark + theme toggle on one row) ---- */
.card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
}
/* In-header toggle: override the Phase-0 fixed positioning for the landing card. */
.card-head .theme-toggle {
    position: static;
    top: auto;
    right: auto;
}
```

- [ ] **Step 4: Make the tagline use tokens + read the value-prop sub from the spec**

Spec §3.3: value prop "scored · free · any song · in your browser". Update the tagline markup. In `static/index.html`, find:

```html
        <p class="tagline">
            Search for any song and sing along.
        </p>
```

Replace with:

```html
        <p class="tagline">
            Search any song and sing along.
            <span class="tagline-sub">Scored · free · any song · in your browser</span>
        </p>
```

Then in `static/style.css`, update the `.tagline` rule to use tokens and add `.tagline-sub`:

Find:

```css
.tagline {
    text-align: center;
    font-size: .85rem;
    color: var(--text-dim);
    margin: 0 0 22px;
    line-height: 1.55;
}
```

Replace with:

```css
.tagline {
    text-align: center;
    font-size: var(--text-base);
    color: var(--text-dim);
    margin: 0 0 var(--space-5);
    line-height: 1.55;
}
.tagline-sub {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: .04em;
    text-transform: uppercase;
}
```

- [ ] **Step 5: Add `role` attributes to both status divs**

In `static/index.html`, find:

```html
        <div id="searchStatus"></div>
```

Replace with:

```html
        <div id="searchStatus" role="status" aria-live="polite"></div>
```

And find:

```html
        <div id="status"></div>
```

Replace with:

```html
        <div id="status" role="status" aria-live="polite"></div>
```

- [ ] **Step 6: Search-button loading state (disable + spinner while searching)**

In `static/index.html`, the `runSearch()` function never disables the button. Update it. Find the `async function runSearch()` body's opening:

```js
        async function runSearch() {
            var q = document.getElementById('songSearch').value.trim();
            var box = document.getElementById('songResults');
            if (!q) { setSearchStatus('Type a song to search.', 'error'); return; }
            setSearchStatus('Searching…', '');
            box.style.display = 'none'; box.innerHTML = '';

            var songs = [];
            try { songs = await KaraokeeLyricsClient.searchSongs(q); }
            catch (e) { songs = []; }

            if (!songs.length) {
                setSearchStatus('No songs found for "' + q + '".', 'error');
                revealPasteFallback();
                return;
            }
            setSearchStatus('', '');
            window._lastSongResults = songs;
            renderSongResults(songs);
        }
```

Replace the whole function with (adds disable + `is-loading` class + a `finally` re-enable):

```js
        async function runSearch() {
            var q = document.getElementById('songSearch').value.trim();
            var box = document.getElementById('songResults');
            var btn = document.getElementById('searchBtn');
            if (!q) { setSearchStatus('Type a song to search.', 'error'); return; }
            setSearchStatus('Searching…', '');
            box.style.display = 'none'; box.innerHTML = '';
            if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }

            var songs = [];
            try { songs = await KaraokeeLyricsClient.searchSongs(q); }
            catch (e) { songs = []; }
            finally { if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); } }

            if (!songs.length) {
                setSearchStatus('No songs found for "' + q + '".', 'error');
                revealPasteFallback();
                return;
            }
            setSearchStatus('', '');
            window._lastSongResults = songs;
            renderSongResults(songs);
        }
```

- [ ] **Step 7: Add a spinner style for the loading button**

Append to the end of `static/style.css`:

```css
/* ---- search button loading spinner ---- */
button.is-loading {
    position: relative;
    color: transparent !important;
}
button.is-loading::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
    border: 2px solid rgba(4,18,26,.35);
    border-top-color: #04121a;
    border-radius: 50%;
    animation: spin .7s linear infinite;
}
/* @keyframes spin already exists in the player section (extracted in Phase 0). */
```

> **Verify `@keyframes spin` exists:** Run `grep -c "@keyframes spin" static/style.css` — expect `1`. If it is `0` (Phase 0 didn't extract it for some reason), add `@keyframes spin { to { transform: rotate(360deg); } }` to the end of `style.css`.

- [ ] **Step 8: Verify**

Run: `python app.py` then open http://localhost:5000.
- The wordmark sits left, the sun/moon theme toggle sits right on the same header row; clicking it flips theme and persists (Phase 0 wiring still active).
- Searching shows the button go into a spinner state, then re-enable.
- Gibberish search shows a red "No songs found".
- The new tagline sub-line "Scored · free · any song · in your browser" shows under the tagline.
- Toggle to **light** and confirm the header, tagline, and status all read cleanly (polished light is the deliverable — adjust any token only if something is unreadable; report, don't hack inline).

- [ ] **Step 9: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat(landing): header toggle + value-prop sub + status roles + search loading state"
```

---

## Task 6: Landing — apply `.btn`/`.panel`/`.chip` components + remove `#searchBtn` id + drop `.hint` spans

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

Spec §3.6: `#searchBtn` id is never queried — **but Task 5 just used `getElementById('searchBtn')`** for the loading state. So we must **keep** the id (the audit predated the loading-state wiring). Resolve the conflict by keeping the id and removing the §3.6 line as satisfied differently. (Recorded in this plan's assumptions.) The other §3.6 landing items — `.hint` spans + `.hint-text` paragraph — are removed here.

- [ ] **Step 1: Remove the `(auto-filled)` `.hint` spans + the `.hint-text` paragraph**

In `static/index.html`, find:

```html
            <label for="artist">Artist <span class="hint">(auto-filled)</span></label>
            <input type="text" id="artist" placeholder="Artist name" />

            <label for="title">Title <span class="hint">(auto-filled)</span></label>
            <input type="text" id="title" placeholder="Song title" />
```

Replace with (the placeholders already say "Artist name"/"Song title"; "auto-filled" is conveyed by the paste-fallback hint line):

```html
            <label for="artist">Artist</label>
            <input type="text" id="artist" placeholder="Artist name (auto-filled)" />

            <label for="title">Title</label>
            <input type="text" id="title" placeholder="Song title (auto-filled)" />
```

And find the local-upload hint paragraph:

```html
            <p class="hint-text">Fill in Artist + Title above for synced lyrics, then choose a file you already own.</p>
```

Replace with (re-home onto a token-driven class; `.hint-text` CSS was removed in Task 4):

```html
            <p class="form-hint">Fill in Artist + Title above for synced lyrics, then choose a file you already own.</p>
```

- [ ] **Step 2: Add the `.form-hint` token rule**

Append to the end of `static/style.css`:

```css
/* ---- small inline form hint (token-driven; replaces removed .hint-text) ---- */
.form-hint {
    font-size: var(--text-sm);
    color: var(--text-faint);
    margin: calc(var(--space-2) * -1) 0 var(--space-3);
    line-height: 1.5;
}
```

- [ ] **Step 3: Promote the secondary buttons to `.btn--secondary`**

The landing has a global `button {}` rule (primary cyan) plus a legacy `.btn-secondary` class. Migrate the two secondary buttons to the Phase-0 `.btn--secondary` variant. In `static/index.html`, find:

```html
            <button id="retryBtn" class="btn-secondary" onclick="retryLyrics()" style="display:none;margin-top:10px">
                Retry with edited title/artist
            </button>
```

Replace with:

```html
            <button id="retryBtn" class="btn btn--secondary" onclick="retryLyrics()" style="display:none;margin-top:10px">
                Retry with edited title/artist
            </button>
```

And in the BYO-key actions, find:

```html
            <button id="clearKeyBtn" class="btn-secondary" type="button">Clear</button>
```

Replace with:

```html
            <button id="clearKeyBtn" class="btn btn--secondary" type="button">Clear</button>
```

> **Leave the primary buttons** (`#searchBtn`, `#loadBtn`, `#loadLocalBtn`, `#saveKeyBtn`) on the global `button {}` rule for now — they are full-width primaries and the global rule already styles them correctly with tokens. (A later pass could migrate them to `.btn btn--primary`, but that would change their `width:100%` block behavior; out of scope here to avoid layout churn.)

- [ ] **Step 4: Verify**

Run: `python app.py` then open http://localhost:5000.
- Reveal the paste fallback (search gibberish) → the "Retry" button shows as a secondary (surface bg, 1px border).
- Open the BYO-key disclosure → "Clear" is a secondary.
- Labels no longer show the dim "(auto-filled)" span; the placeholders carry it instead.
- Light mode: secondaries read correctly (border + surface visible on white).

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/style.css
git commit -m "refactor(landing): drop .hint spans, tokenize form hint, apply .btn--secondary"
```

---

## Task 7: Landing — thumbnail rendering for the resolve video picker

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

Spec §3.3 + §3.8: real thumbnails in the pickers. The resolve candidate object carries `thumbnail` (and `videoId`) — confirmed in `workers/resolve/core.cjs` (`{ videoId, title, channelTitle, durationSec, thumbnail }`). Render that thumb; fall back to the YouTube thumbnail URL `https://i.ytimg.com/vi/<videoId>/mqdefault.jpg` when `thumbnail` is empty.

- [ ] **Step 1: Add thumbnail markup to `renderVideoPicker`**

In `static/index.html`, find the `renderVideoPicker` candidate loop:

```js
            candidates.forEach(function (c, idx) {
                var div = document.createElement('div');
                div.className = 'search-result-item' + (idx === 0 ? ' is-best' : '');
                div.onclick = function () { pickVideo(c.videoId, song); };
                var dur = c.durationSec || 0;
                var mins = Math.floor(dur / 60), secs = ('0' + (dur % 60)).slice(-2);
                var t = document.createElement('div'); t.className = 'search-result-title';
                t.textContent = c.title + (idx === 0 ? '  ✓' : '');
                var m = document.createElement('div'); m.className = 'search-result-meta';
                m.textContent = (c.channelTitle || '') + ' · ' + mins + ':' + secs;
                div.appendChild(t); div.appendChild(m);
                box.appendChild(div);
            });
```

Replace with (adds a thumb tile, a text column, and a real "best match" pill instead of the `'  ✓'` string concat):

```js
            candidates.forEach(function (c, idx) {
                var div = document.createElement('div');
                div.className = 'search-result-item has-thumb' + (idx === 0 ? ' is-best' : '');
                div.onclick = function () { pickVideo(c.videoId, song); };
                var dur = c.durationSec || 0;
                var mins = Math.floor(dur / 60), secs = ('0' + (dur % 60)).slice(-2);

                var thumb = document.createElement('img');
                thumb.className = 'sr-thumb';
                thumb.loading = 'lazy';
                thumb.alt = '';
                thumb.src = c.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(c.videoId) + '/mqdefault.jpg');
                thumb.onerror = function () { this.style.visibility = 'hidden'; };

                var text = document.createElement('div'); text.className = 'sr-text';
                var t = document.createElement('div'); t.className = 'search-result-title';
                t.textContent = c.title;
                if (idx === 0) {
                    var best = document.createElement('span');
                    best.className = 'pill sr-best-pill';
                    best.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Best match';
                    t.appendChild(document.createTextNode(' '));
                    t.appendChild(best);
                }
                var m = document.createElement('div'); m.className = 'search-result-meta';
                m.textContent = (c.channelTitle || '') + ' · ' + mins + ':' + secs;
                text.appendChild(t); text.appendChild(m);

                div.appendChild(thumb); div.appendChild(text);
                box.appendChild(div);
            });
```

- [ ] **Step 2: Add the thumbnail layout + best-pill styles**

Append to the end of `static/style.css`:

```css
/* ---- picker rows with thumbnails ---- */
.search-result-item.has-thumb {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}
.sr-thumb {
    width: 64px;
    height: 36px;
    border-radius: var(--r-sm);
    object-fit: cover;
    background: var(--surface-3);
    flex-shrink: 0;
}
.sr-text { min-width: 0; flex: 1; }
.search-result-item.has-thumb .search-result-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sr-best-pill {
    background: var(--p-soft);
    color: var(--p);
    border: 1px solid var(--p-line);
    vertical-align: middle;
}
.sr-best-pill .icon { width: .85em; height: .85em; }
/* The whole-row is-best tint is enough; drop the old left-border bar treatment. */
.search-result-item.is-best.has-thumb { background: var(--surface-3); box-shadow: none; }
```

- [ ] **Step 3: Verify**

Run: `python app.py` then open http://localhost:5000.
- Search a real song (e.g. "Never Gonna Give You Up"), pick it → the video picker now shows **real thumbnails** on the left of each row, the title truncates cleanly, and row 1 carries a "✓ Best match" pill (replacing the old `'  ✓'` string).
- A broken thumbnail URL hides the image without breaking the row layout.
- Light + dark both read correctly.

- [ ] **Step 4: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat(picker): real thumbnails + a proper best-match pill in the resolve video picker"
```

---

## Task 8: Landing — thumbnail tiles for the lyrics-search + starter pickers

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

The lrclib search results (`s.trackName`/`s.artistName`/`s.duration`) and starter songs have **no thumbnail/videoId** (resolve happens on pick). Spec §3.3 says "YouTube thumb + album art where available" — for these rows we render a consistent **music-note placeholder tile** so both pickers are visually thumbnail-based and aligned. Starter songs *do* have a `videoId`, so they can use the real YouTube thumb.

- [ ] **Step 1: Add a placeholder thumb to `renderSongResults`**

In `static/index.html`, find the `renderSongResults` row loop:

```js
            songs.slice(0, 6).forEach(function (s, i) {
                var div = document.createElement('div');
                div.className = 'search-result-item';
                div.onclick = function () { pickSong(i); };
                var dur = s.duration || 0;
                var mins = Math.floor(dur / 60), secs = ('0' + (dur % 60)).slice(-2);
                var t = document.createElement('div'); t.className = 'search-result-title'; t.textContent = s.trackName;
                // Lead with the artist — it's the real differentiator between same-titled results.
                var m = document.createElement('div'); m.className = 'search-result-meta';
                m.innerHTML = '<strong>' + _esc(s.artistName) + '</strong>' + (dur ? ' · ' + mins + ':' + secs : '');
                div.appendChild(t); div.appendChild(m);
                box.appendChild(div);
            });
```

Replace with:

```js
            songs.slice(0, 6).forEach(function (s, i) {
                var div = document.createElement('div');
                div.className = 'search-result-item has-thumb';
                div.onclick = function () { pickSong(i); };
                var dur = s.duration || 0;
                var mins = Math.floor(dur / 60), secs = ('0' + (dur % 60)).slice(-2);
                div.appendChild(_thumbPlaceholder());
                var text = document.createElement('div'); text.className = 'sr-text';
                var t = document.createElement('div'); t.className = 'search-result-title'; t.textContent = s.trackName;
                // Lead with the artist — it's the real differentiator between same-titled results.
                var m = document.createElement('div'); m.className = 'search-result-meta';
                m.innerHTML = '<strong>' + _esc(s.artistName) + '</strong>' + (dur ? ' · ' + mins + ':' + secs : '');
                text.appendChild(t); text.appendChild(m);
                div.appendChild(text);
                box.appendChild(div);
            });
```

- [ ] **Step 2: Add the `_thumbPlaceholder()` helper near `_esc`**

In `static/index.html`, find:

```js
        function _esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
```

Insert immediately after it:

```js
        // A music-note tile for rows that don't yet have a real video thumbnail
        // (lrclib search results resolve their video only on pick).
        function _thumbPlaceholder() {
            var ph = document.createElement('div');
            ph.className = 'sr-thumb sr-thumb-ph';
            ph.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
            return ph;
        }
```

- [ ] **Step 3: Give starter rows the real YouTube thumbnail**

In `static/index.html`, find the `renderStarterRow` loop:

```js
            STARTER_SONGS.forEach(function (s, i) {
                var div = document.createElement('div');
                div.className = 'search-result-item';
                div.onclick = function () { playStarter(i); };
                var t = document.createElement('div'); t.className = 'search-result-title'; t.textContent = s.title;
                var m = document.createElement('div'); m.className = 'search-result-meta'; m.textContent = s.artist;
                div.appendChild(t); div.appendChild(m);
                list.appendChild(div);
            });
```

Replace with:

```js
            STARTER_SONGS.forEach(function (s, i) {
                var div = document.createElement('div');
                div.className = 'search-result-item has-thumb';
                div.onclick = function () { playStarter(i); };
                var thumb = document.createElement('img');
                thumb.className = 'sr-thumb';
                thumb.loading = 'lazy';
                thumb.alt = '';
                thumb.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(s.videoId) + '/mqdefault.jpg';
                thumb.onerror = function () { this.style.visibility = 'hidden'; };
                var text = document.createElement('div'); text.className = 'sr-text';
                var t = document.createElement('div'); t.className = 'search-result-title'; t.textContent = s.title;
                var m = document.createElement('div'); m.className = 'search-result-meta'; m.textContent = s.artist;
                text.appendChild(t); text.appendChild(m);
                div.appendChild(thumb); div.appendChild(text);
                list.appendChild(div);
            });
```

- [ ] **Step 4: Style the placeholder tile**

Append to the end of `static/style.css`:

```css
/* ---- placeholder music-note thumbnail (lrclib search rows) ---- */
.sr-thumb-ph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
}
.sr-thumb-ph .icon { width: 18px; height: 18px; }
```

- [ ] **Step 5: Verify**

Run: `python app.py` then open http://localhost:5000.
- The "Popular picks" starter row now shows real YouTube thumbnails.
- A lyrics search shows rows with the music-note placeholder tile, vertically aligned with the resolve picker's real thumbs.
- Light + dark both read.

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat(picker): thumbnail tiles for lyrics-search rows + real thumbs on starter picks"
```

---

## Task 9: Landing — improve the desktop-only interstitial (dialog + copy-link)

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

Spec §3.3: improve the desktop-only interstitial into a helpful screen (`role=dialog`, one-line "why", copy-link).

- [ ] **Step 1: Upgrade the interstitial markup**

In `static/index.html`, find:

```html
    <div id="unsupported" class="unsupported-overlay" style="display:none">
      <div>
        <h2>Audiopian needs desktop Chrome or Edge</h2>
        <p>
          The free voice recognition runs only in <strong>desktop Chrome or Edge</strong> with a
          microphone. Open this link in desktop Chrome or Edge to play.
        </p>
      </div>
    </div>
```

Replace with:

```html
    <div id="unsupported" class="unsupported-overlay" style="display:none" role="dialog" aria-modal="true" aria-labelledby="unsupportedTitle">
      <div class="unsupported-box panel">
        <div class="logo-dot" aria-hidden="true"></div>
        <h2 id="unsupportedTitle">Open in desktop Chrome or Edge</h2>
        <p>
          Audiopian's free voice recognition runs only in <strong>desktop Chrome or Edge</strong>
          with a microphone. Copy this link and open it there to play.
        </p>
        <button id="copyLinkBtn" class="btn btn--primary" type="button">Copy link</button>
      </div>
    </div>
```

- [ ] **Step 2: Wire the copy-link button**

In `static/index.html`, inside the existing desktop-gate IIFE, find:

```js
            if (!supported) {
                var el = document.getElementById('unsupported');
                if (el) el.style.display = 'flex';
            }
        })();
```

Replace with:

```js
            if (!supported) {
                var el = document.getElementById('unsupported');
                if (el) el.style.display = 'flex';
                var copyBtn = document.getElementById('copyLinkBtn');
                if (copyBtn) {
                    copyBtn.addEventListener('click', function () {
                        var url = window.location.href;
                        var done = function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1600); };
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(url).then(done, function () { copyBtn.textContent = url; });
                        } else {
                            copyBtn.textContent = url;
                        }
                    });
                }
            }
        })();
```

- [ ] **Step 3: Style the interstitial box**

In `static/style.css`, find the `.unsupported-overlay` rules and add a `.unsupported-box` style. Append to the end of `static/style.css`:

```css
/* ---- desktop-only interstitial card ---- */
.unsupported-box {
    max-width: 30rem;
    padding: var(--space-7) var(--space-6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
}
.unsupported-box .logo-dot {
    width: 18px; height: 18px; border-radius: var(--r-sm);
    background: var(--grad-accent); box-shadow: 0 0 16px var(--p);
}
.unsupported-box h2 { font-family: var(--font-display); }
.unsupported-box .btn { width: auto; }
```

- [ ] **Step 4: Verify**

Run: `python app.py`. Simulate an unsupported browser by toggling the overlay in DevTools console:

```js
document.getElementById('unsupported').style.display = 'flex'
```

Expected: a centered card with the brand dot, a one-line "why", and a "Copy link" button. Clicking it copies the URL and flashes "Copied!". Light + dark both read.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat(landing): role=dialog interstitial with copy-link"
```

---

## Task 10: Shared footer — unify across landing + legal + player

**Files:**
- Modify: `static/style.css`
- Modify: `static/player.html`, `static/terms.html`, `static/privacy.html`, `static/dmca.html`

Spec §3.3 "Global": one shared footer; dynamic © year. The landing already has `.site-footer`. Add the same footer to the legal pages and the player, and compute the year.

- [ ] **Step 1: Make the © year dynamic on the landing footer**

In `static/index.html`, find:

```html
    <footer class="site-footer">
        &copy; 2026 Audiopian
        <span class="sep">&middot;</span><a href="https://github.com/WestsideSage" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="sep">&middot;</span><a href="/terms">Terms</a>
        <span class="sep">&middot;</span><a href="/privacy">Privacy</a>
        <span class="sep">&middot;</span><a href="/dmca">DMCA</a>
    </footer>
```

Replace the `&copy; 2026 Audiopian` text with a span the script fills:

```html
    <footer class="site-footer">
        &copy; <span class="footer-year">2026</span> Audiopian
        <span class="sep">&middot;</span><a href="https://github.com/WestsideSage" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="sep">&middot;</span><a href="/terms">Terms</a>
        <span class="sep">&middot;</span><a href="/privacy">Privacy</a>
        <span class="sep">&middot;</span><a href="/dmca">DMCA</a>
    </footer>
```

Then immediately before the closing `</body>` in `static/index.html`, add:

```html
    <script>
      (function () {
        var els = document.querySelectorAll('.footer-year');
        for (var i = 0; i < els.length; i++) els[i].textContent = String(new Date().getFullYear());
      })();
    </script>
```

- [ ] **Step 2: Add the shared footer to the three legal pages**

In each of `static/terms.html`, `static/privacy.html`, `static/dmca.html`, find the closing `</main>` and insert **after** it (before `</body>`):

```html
    <footer class="site-footer">
        &copy; <span class="footer-year">2026</span> Audiopian
        <span class="sep">&middot;</span><a href="https://github.com/WestsideSage" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="sep">&middot;</span><a href="/terms">Terms</a>
        <span class="sep">&middot;</span><a href="/privacy">Privacy</a>
        <span class="sep">&middot;</span><a href="/dmca">DMCA</a>
    </footer>
    <script>
      (function () {
        var els = document.querySelectorAll('.footer-year');
        for (var i = 0; i < els.length; i++) els[i].textContent = String(new Date().getFullYear());
      })();
    </script>
```

- [ ] **Step 3: Constrain the legal footer width + spacing**

The legal pages use `body.legal-page { display: block; }`, so the full-width footer needs centering. Append to the end of `static/style.css`:

```css
/* ---- shared footer on the legal documents (block layout, so center it) ---- */
body.legal-page .site-footer {
    max-width: 760px;
    margin: var(--space-7) auto 0;
}
```

- [ ] **Step 4: Add a quiet footer to the player (after the controls)**

The player is a fixed full-viewport app; a persistent footer would collide with the fixed `.controls`. Instead, add a **single quiet legal line into the player header** is already present in the prep overlay (`.prep-legal`). For the in-game shell, the spec's "shared footer across landing + player + legal" is satisfied by the prep-overlay legal line + the wordmark (added in Task 14). **No player footer bar** is added (it would overlap the fixed controls). Record this as an intentional deviation: the player's "footer treatment" is the prep-overlay legal line, kept. **No file change in this step** — just confirm `.prep-legal` is present in `player.html`.

Run: `grep -c "prep-legal" static/player.html`
Expected: `>= 1`.

- [ ] **Step 5: Verify**

Run: `python app.py`.
- http://localhost:5000 — footer © year shows the current year.
- http://localhost:5000/static/terms.html (and privacy/dmca) — the same footer now appears at the bottom, centered to the doc width, with the live year.
- Light + dark both read.

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/terms.html static/privacy.html static/dmca.html static/style.css
git commit -m "feat(footer): shared footer on landing+legal with dynamic © year"
```

---

## Task 11: Legal pages — Inter body + polished light "doc" surface

**Files:**
- Modify: `static/style.css`

> **Independently committable group: Legal pages (Tasks 11–13).**

Spec §3.3 Legal: reskin onto the flat light "doc" surface; Inter body ~16px/1.7. The legal rules already use tokens for most colors (post-Phase-0). Bump body type to Inter at the spec's size/leading and ensure the doc surface reads as a clean card in **both** themes.

- [ ] **Step 1: Set the legal body type + leading to the spec target**

In `static/style.css`, find the legal paragraph/list rules:

```css
.legal p { color: var(--text-dim); font-size: .9rem; line-height: 1.65; margin-bottom: 12px; }
.legal ul, .legal ol { margin: 0 0 12px 22px; }
.legal li { color: var(--text-dim); font-size: .9rem; line-height: 1.6; margin-bottom: 6px; }
```

Replace with (Inter body, ~16px / 1.7 per spec; `--font-text` is already the body default, but pin the size/leading explicitly):

```css
.legal { font-family: var(--font-text); }
.legal p { color: var(--text); font-size: 1rem; line-height: 1.7; margin-bottom: var(--space-3); }
.legal ul, .legal ol { margin: 0 0 var(--space-3) var(--space-5); }
.legal li { color: var(--text); font-size: 1rem; line-height: 1.7; margin-bottom: var(--space-2); }
```

(Bumped `--text-dim` → `--text` for primary readability on the doc surface; the de-emphasized lede/updated/disclaimer keep their dim tones.)

- [ ] **Step 2: Make legal headings use the display font**

In `static/style.css`, find:

```css
.legal h1.doc-title {
    text-align: left;
    font-size: 1.7rem;
    margin: 20px 0 4px;
    color: var(--text-strong);
}
```

Replace with:

```css
.legal h1.doc-title {
    font-family: var(--font-display);
    text-align: left;
    font-size: var(--text-xl);
    margin: var(--space-5) 0 var(--space-1);
    color: var(--text-strong);
}
```

And find:

```css
.legal h2 { font-size: 1.05rem; color: var(--text-strong); margin: 26px 0 9px; letter-spacing: .01em; }
```

Replace with:

```css
.legal h2 { font-family: var(--font-display); font-size: var(--text-md); color: var(--text-strong); margin: var(--space-6) 0 var(--space-2); letter-spacing: .01em; }
```

- [ ] **Step 3: Verify the doc surface in light + dark**

Run: `python app.py` then open http://localhost:5000/static/terms.html.
- Dark: the doc card reads as before but body text is now Inter at a comfortable 16px/1.7.
- Toggle **light**: white doc card on the light wash, dark readable body text, headings in Space Grotesk, callout/disclaimer legible. Nothing invisible.
- Repeat for privacy + dmca.

- [ ] **Step 4: Commit**

```bash
git add static/style.css
git commit -m "feat(legal): Inter 16/1.7 body + display-font headings; polished light doc surface"
```

---

## Task 12: Legal pages — add the theme toggle + home-dot uses display font

**Files:**
- Modify: `static/terms.html`, `static/privacy.html`, `static/dmca.html`
- Modify: `static/style.css`

> **Note:** Phase 0 Task 6 already added a fixed `#themeToggle` to the legal pages. Confirm it's there; if it is, this task only adds the Lucide sun/moon SVGs into it (Phase 0 may have used a simpler glyph) and tokenizes the home link. If Phase 0's button already has the sun/moon SVGs, skip Step 1.

- [ ] **Step 1: Ensure each legal page's `#themeToggle` carries the Lucide sun/moon**

In each of `static/terms.html`, `static/privacy.html`, `static/dmca.html`, find the `#themeToggle` button added in Phase 0. Ensure it reads exactly:

```html
    <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch theme" title="Switch theme">
      <svg class="ico-sun icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      <svg class="ico-moon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
```

(It stays the Phase-0 **fixed** top-right toggle on the legal pages — those pages have no card header to host it.)

- [ ] **Step 2: Make the legal home-dot link use the display font**

In `static/style.css`, find:

```css
.legal .doc-home {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--text-strong);
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
    font-size: 1rem;
    text-decoration: none;
}
```

Replace with:

```css
.legal .doc-home {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-display);
    color: var(--text-strong);
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
    font-size: var(--text-base);
    text-decoration: none;
}
```

- [ ] **Step 3: Verify**

Run: `python app.py` then open http://localhost:5000/static/terms.html.
- Top-right sun/moon toggle flips theme + persists across the legal pages.
- The "Audiopian" home link is in the display font.
- Repeat on privacy + dmca.

- [ ] **Step 4: Commit**

```bash
git add static/terms.html static/privacy.html static/dmca.html static/style.css
git commit -m "feat(legal): Lucide theme toggle + display-font home link"
```

---

## Task 13: Legal pages — remove shipped operator TODO comments (§3.6)

**Files:**
- Modify: `static/terms.html`, `static/dmca.html`

Spec §3.6: remove shipped operator TODO comments (`terms.html` governing-law TODO, `dmca.html` agent-registration TODO). The values they referenced are already set (Washington; the contact email is live), so the comments are stale operator notes.

- [ ] **Step 1: Remove the terms governing-law TODO**

In `static/terms.html`, find:

```html
        <h2>13. Governing law</h2>
        <!-- TODO(operator): set your U.S. state below before publishing. -->
        <p>These Terms are governed by the laws of the State of <strong>Washington</strong>, United States, without regard to its conflict-of-laws rules.</p>
```

Replace with:

```html
        <h2>13. Governing law</h2>
        <p>These Terms are governed by the laws of the State of <strong>Washington</strong>, United States, without regard to its conflict-of-laws rules.</p>
```

- [ ] **Step 2: Remove the dmca agent-registration TODO**

In `static/dmca.html`, find:

```html
        <p>Audiopian &mdash; <a href="mailto:dmca@audiopian.com">dmca@audiopian.com</a></p>
        <!-- TODO(operator): for full DMCA "safe harbor" protection, register a designated agent with
             the U.S. Copyright Office (~$6) at https://dmca.copyright.gov/osp/ . The email above is the
             public contact; agent registration is the formal step that completes the safe-harbor shield. -->
```

Replace with:

```html
        <p>Audiopian &mdash; <a href="mailto:dmca@audiopian.com">dmca@audiopian.com</a></p>
```

- [ ] **Step 3: Verify**

Run: `grep -rn "TODO(operator)" static/`
Expected: no output.

Run: `python app.py` then open http://localhost:5000/terms and http://localhost:5000/dmca — both render unchanged (only comments removed).

- [ ] **Step 4: Commit**

```bash
git add static/terms.html static/dmca.html
git commit -m "chore(legal): remove shipped operator TODO comments"
```

---

## Task 14: Player — join the theme system (replace dark-pin boot + add header toggle)

**Files:**
- Modify: `static/player.html`
- Modify: `static/style.css`

> **Independently committable group: Player shell (Tasks 14–18).**

Spec §3.3 + the task brief: replace the Phase-0 dark-pin `<script>` with the shared theme boot, and add the player's own `#themeToggle` in the header + a quiet wordmark.

- [ ] **Step 1: Replace the dark-pin boot with the shared theme boot**

In `static/player.html` `<head>`, find the Phase-0 dark-pin script (added in Phase 0 Task 5):

```html
    <!-- Phase 0: the player stage is not themed yet, so pin dark to keep it
         visually unchanged. Phase 1 replaces this with the shared theme boot
         (script src theme-helpers.js + resolveInitialTheme) once the stage is
         token-driven. -->
    <script>
      document.documentElement.setAttribute('data-theme', 'dark');
    </script>
```

Replace it with the same no-FOUC boot the landing/legal pages use:

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

- [ ] **Step 2: Add a quiet wordmark + theme toggle to the player header**

In `static/player.html`, find the player header:

```html
    <div class="player-header">
        <button class="back-btn ctrl-btn" onclick="window.location.href='/'">&#8592; Back</button>
        <div class="song-title" id="song-title">Loading...</div>
        <div class="score-display" id="score-display" style="display:none"><span class="sd-label">Accuracy</span><span id="score-pct">0%</span></div>
        <div class="diff-pill" id="diff-pill" style="display:none">MEDIUM</div>
    </div>
```

Replace with (back button gets the arrow-left icon; add a quiet wordmark + the theme toggle on the right):

```html
    <div class="player-header">
        <button class="back-btn ctrl-btn" onclick="window.location.href='/'" aria-label="Back to home">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Back
        </button>
        <span class="player-wordmark"><span class="logo-dot"></span>Audiopian</span>
        <div class="song-title" id="song-title">Loading...</div>
        <div class="score-display" id="score-display" style="display:none"><span class="sd-label">Accuracy</span><span id="score-pct">0%</span></div>
        <div class="diff-pill" id="diff-pill" style="display:none">MEDIUM</div>
        <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch theme" title="Switch theme">
          <svg class="ico-sun icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          <svg class="ico-moon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
    </div>
```

- [ ] **Step 3: Include `theme-toggle.js` on the player**

In `static/player.html`, find the script include for `player.js`:

```html
    <script src="/static/player.js"></script>
```

Insert immediately **before** it:

```html
    <script src="/static/theme-toggle.js" defer></script>
```

- [ ] **Step 4: Style the player wordmark + re-home the toggle into the header**

The player CSS now lives in `style.css` (post-Phase-0). Append to the end of `static/style.css`:

```css
/* ---- player header wordmark (quiet branding in-game) ---- */
.player-wordmark {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--text-dim);
    flex-shrink: 0;
}
.player-wordmark .logo-dot {
    width: 11px; height: 11px; border-radius: var(--r-sm);
    background: var(--grad-accent); box-shadow: 0 0 10px var(--p);
}
/* The score-display pushes everything after it to the right (margin-left:auto in the
   player rules); keep the theme toggle inline in the header (not fixed). */
.player-header .theme-toggle {
    position: static;
    top: auto;
    right: auto;
    margin-left: var(--space-3);
}
```

- [ ] **Step 5: Verify the player now follows the theme**

Run: `python app.py` then open http://localhost:5000/player (load a song; use the local-upload dev path if needed).
- The header shows: ← Back (with arrow icon), the quiet Audiopian wordmark, the song title, the accuracy readout, and a sun/moon toggle on the right.
- Toggling flips the **whole player stage** light↔dark (the stage follows the theme per the locked decision). It persists across reloads and is shared with the landing page (same `audiopian-theme` key).
- **Light-mode player audit:** the lyric reader, controls bar, arcade HUD, prep overlay, count-in, and end screen must all read on white. Note any hardcoded dark-only color (`#4b4e60`, `#6c6f82`, `#fff`, `#aaa`, `#ccc`, `#666`, `#555`) that looks wrong in light — these are remapped in Tasks 15–17.

- [ ] **Step 6: Commit**

```bash
git add static/player.html static/style.css
git commit -m "feat(player): join the theme system (shared boot + header toggle + quiet wordmark)"
```

---

## Task 15: Player — remap hardcoded grays/whites onto tokens (light-safe)

**Files:**
- Modify: `static/style.css` (the player section)

The extracted player CSS still has hardcoded `#4b4e60`, `#6c6f82`, `#fff`, and the controls-bar inline `#aaa`/`#ccc`/`#666`/`#555` (those last are in `player.html` inline `style=` attrs — handled in Task 16). Here we remap the **CSS** literals so the player reads correctly in light mode.

- [ ] **Step 1: Remap the lyric-line colors**

In `static/style.css` (player section), find:

```css
        .lyric-line {
            font-size: 1.6rem;
            color: #4b4e60;
            text-align: center;
            transition: color 0.2s, font-size 0.2s;
            padding: 4px 0;
            font-weight: 500;
        }

        .lyric-line.active {
            color: #fff;
            font-size: 1.95rem;
            font-weight: 700;
            letter-spacing: -.01em;
        }

        .lyric-line.upcoming {
            color: #6c6f82;
        }
```

Replace with:

```css
        .lyric-line {
            font-size: 1.6rem;
            color: var(--text-faint);
            text-align: center;
            transition: color 0.2s, font-size 0.2s;
            padding: 4px 0;
            font-weight: 500;
        }

        .lyric-line.active {
            color: var(--text-strong);
            font-size: 1.95rem;
            font-weight: 700;
            letter-spacing: -.01em;
        }

        .lyric-line.upcoming {
            color: var(--text-dim);
        }
```

- [ ] **Step 2: Remap the word-span idle color**

In `static/style.css`, find:

```css
        .word-span {
            display: inline-block;
            color: #4b4e60;
            transition: color 0.15s, text-shadow 0.15s;
            cursor: default;
        }
```

Replace `#4b4e60` with `var(--text-faint)`:

```css
        .word-span {
            display: inline-block;
            color: var(--text-faint);
            transition: color 0.15s, text-shadow 0.15s;
            cursor: default;
        }
```

- [ ] **Step 3: Remap remaining `#fff`/`#4b4e60` in player rules**

In `static/style.css`, remap these player-section literals to tokens:

- `.diff-card .dc-name { ... color: #fff; }` → `color: var(--text-strong);`
- `.mc-phrase { ... color: #fff; ... }` → `color: var(--text-strong);`
- `.dp-word { color: #4b4e60; ... }` → `color: var(--text-faint);`

(`.dp-word.dp-target` was already retokenized in Task 4 Step 7. The on-fire `#fff` text-fill in `.ah-fire` is intentional — fire lockup stays white on its warm gradient; leave it.)

Run after the edits: `grep -n "#4b4e60\|#6c6f82" static/style.css`
Expected: no output (all remapped). `#fff` may remain only in the `.ah-fire` fire-lockup rule and the `@keyframes confirmPulse` is already gone.

- [ ] **Step 4: Verify in both themes**

Run: `python app.py` then open http://localhost:5000/player, load a song, enter Game Mode.
- Dark: lyric reader, active line, word spans look as before.
- Light: idle lyrics are a readable faint gray (not near-black-on-white or invisible); the active line is strong/dark; key-word cyan cue still pops; matched/partial/missed colors still read.

- [ ] **Step 5: Commit**

```bash
git add static/style.css
git commit -m "refactor(player): remap hardcoded grays/whites onto theme tokens (light-safe)"
```

---

## Task 16: Player — Lucide transport/volume + remap inline control colors

**Files:**
- Modify: `static/player.html`
- Modify: `static/player.js`
- Modify: `static/style.css`

Spec §3.5: replace emoji transport/volume/mic/game icons with Lucide. The control buttons' glyphs live in `player.html` markup; the play/pause toggle text is set in `player.js`.

- [ ] **Step 1: Swap the controls-bar emoji for Lucide SVGs**

In `static/player.html`, find the controls bar:

```html
    <div class="controls">
        <button class="ctrl-btn game-btn" id="gameBtn" onclick="toggleGameMode()">🎮 Game</button>
        <button class="ctrl-btn" onclick="skipBack()">⏮</button>
        <button class="ctrl-btn" id="playBtn" onclick="togglePlay()">▶</button>
        <button class="ctrl-btn" onclick="skipFwd()">⏭</button>
        <input type="range" id="seek" min="0" max="100" value="0" step="0.1">
        <div id="time-display">0:00 / 0:00</div>
        <span style="font-size:0.8rem;color:#aaa">🔊</span>
        <input type="range" id="volume" min="0" max="1" step="0.05" value="1">
        <div id="asr-provider-display" style="font-size:0.78rem;color:#aaa;min-width:190px;text-align:left;">ASR: checking...</div>
        <div id="lrc-offset-control" style="display:none; align-items:center; gap:6px; font-size:13px; color:#aaa;">
          <span>Lyrics offset</span>
          <button id="offsetMinus" class="offset-btn" title="Shift lyrics earlier">−0.5s</button>
          <span id="offsetDisplay">0.0s</span>
          <button id="offsetPlus"  class="offset-btn" title="Shift lyrics later">+0.5s</button>
        </div>
    </div>
```

Replace with (Lucide gamepad/skip/play/volume; inline color literals → token; `#playBtn` keeps a stable inner so the JS can swap the icon):

```html
    <div class="controls">
        <button class="ctrl-btn game-btn" id="gameBtn" onclick="toggleGameMode()">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>
          Game
        </button>
        <button class="ctrl-btn" onclick="skipBack()" aria-label="Skip back 10 seconds">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
        </button>
        <button class="ctrl-btn" id="playBtn" onclick="togglePlay()" aria-label="Play">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </button>
        <button class="ctrl-btn" onclick="skipFwd()" aria-label="Skip forward 10 seconds">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
        </button>
        <input type="range" id="seek" min="0" max="100" value="0" step="0.1">
        <div id="time-display">0:00 / 0:00</div>
        <span class="vol-icon" aria-hidden="true">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
        </span>
        <input type="range" id="volume" min="0" max="1" step="0.05" value="1">
        <div id="asr-provider-display" class="asr-display">ASR: checking...</div>
        <div id="lrc-offset-control" class="offset-control" style="display:none">
          <span>Lyrics offset</span>
          <button id="offsetMinus" class="offset-btn" title="Shift lyrics earlier">−0.5s</button>
          <span id="offsetDisplay">0.0s</span>
          <button id="offsetPlus"  class="offset-btn" title="Shift lyrics later">+0.5s</button>
        </div>
    </div>
```

- [ ] **Step 2: Add the control-meta styles (replaces the inline `#aaa`/`13px` literals)**

Append to the end of `static/style.css`:

```css
/* ---- controls-bar meta (icons + ASR display + offset control) ---- */
.vol-icon { display: inline-flex; align-items: center; color: var(--text-dim); }
.asr-display {
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 190px;
    text-align: left;
}
.offset-control {
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-dim);
}
/* the offset-control is display:none until a scored game starts; keep the toggle via JS */
.offset-control[style*="display:none"] { display: none !important; }
```

> **Note on the inline `display` toggle:** `player.js` flips `lrc-offset-control` between `none` and a flex display via `.style.display`. Since the markup above keeps `style="display:none"` and the JS sets `.style.display = 'flex'` (or similar) at runtime, the `.offset-control` rule must not hardcode `display`. **Verify** how `player.js` shows it.

Run: `grep -n "lrc-offset-control" static/player.js`
If `player.js` sets `.style.display = 'flex'`, the inline-style approach works as-is. If it toggles a class, adjust accordingly. (As of this writing it sets `.style.display`; confirm and keep the inline default.)

- [ ] **Step 3: Swap the play/pause icon in `player.js` (togglePlay + the play-state setters)**

`player.js` currently sets `playBtn.textContent = '⏸'` / `'▶'` (and the unicode escapes `'⏸'`/`'▶'`). Replace those with `innerHTML` of the Lucide play/pause SVG via a small helper. In `static/player.js`, find the `togglePlay()` function:

```js
function togglePlay() {
    if (!playback) return;
    if (playback.isPaused()) {
        playback.play();
        playBtn.textContent = '⏸';
        if (gameMode.active) gameMode.resume();
    } else {
        playback.pause();
        playBtn.textContent = '▶';
        if (gameMode.active) gameMode.suspend();
    }
}
```

Replace with:

```js
// Lucide play/pause glyphs for the transport button (no icon framework — raw SVG).
var _ICON_PLAY = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
var _ICON_PAUSE = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
function _setPlayIcon(isPlaying) {
    if (!playBtn) return;
    playBtn.innerHTML = isPlaying ? _ICON_PAUSE : _ICON_PLAY;
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}
function togglePlay() {
    if (!playback) return;
    if (playback.isPaused()) {
        playback.play();
        _setPlayIcon(true);
        if (gameMode.active) gameMode.resume();
    } else {
        playback.pause();
        _setPlayIcon(false);
        if (gameMode.active) gameMode.suspend();
    }
}
```

- [ ] **Step 4: Replace every other `playBtn.textContent` play/pause set with `_setPlayIcon`**

`player.js` sets the play button glyph in several places (the seek/play helpers, count-in, prep). Replace each:

- `playBtn.textContent = '⏸';` → `_setPlayIcon(true);`
- `playBtn.textContent = '▶';` → `_setPlayIcon(false);`
- `playBtn.textContent = '⏸';` → `_setPlayIcon(true);`
- `playBtn.textContent = '▶';` → `_setPlayIcon(false);`

Find each occurrence with:

Run: `grep -n "playBtn.textContent" static/player.js`

Expected occurrences (verify against the file; line numbers approximate): the `then(...)` callbacks around the IFrame play path (`~L2060`, `~L2218`, `~L2250`), the pause-on-prep (`~L2168`). Replace each per the mapping above. After editing:

Run: `grep -n "playBtn.textContent" static/player.js`
Expected: no output (all migrated to `_setPlayIcon`).

> **Windows caution:** these are plain-string edits (no backtick template literals), so the Edit tool is fine. Do not route through Bash.

- [ ] **Step 5: Swap the no-lyrics `♪` markup for the music Lucide**

In `static/player.html`, find:

```html
        <div id="no-lyrics">♪ No synced lyrics available ♪</div>
```

Replace with:

```html
        <div id="no-lyrics"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> No synced lyrics available</div>
```

- [ ] **Step 6: Swap the debug-HUD `🎮` header glyph (kept, just de-emoji)**

In `static/player.js`, find:

```js
        let html = '<div class="dbg-header">🎮 GAME DEBUG &mdash; press D to hide</div>';
```

Replace with (drop the emoji; the debug HUD is dev-only and stays plain):

```js
        let html = '<div class="dbg-header">GAME DEBUG &mdash; press D to hide</div>';
```

- [ ] **Step 7: Verify**

Run: `python app.py` then open http://localhost:5000/player, load a song.
- Transport buttons show Lucide play/skip/gamepad/volume glyphs; pressing play swaps to the pause glyph and back.
- The no-lyrics state (load a song with no lyrics, or temporarily clear `lyrics`) shows the music note icon.
- Icons inherit the button text color in both themes (light + dark).
- Game Mode + debug HUD (press D) still work; HUD header reads "GAME DEBUG".

Run JS + Python regressions:

```bash
node tests/test_scoring_session.cjs
python -m pytest tests/test_app.py -q
```

Expected: PASS (no scoring logic touched).

- [ ] **Step 8: Commit**

```bash
git add static/player.html static/player.js static/style.css
git commit -m "feat(player): Lucide transport/volume/no-lyrics icons + token control meta"
```

---

## Task 17: Player — mic-check + prep-overlay icons + difficulty grid + Clean switch + `.panel`

**Files:**
- Modify: `static/player.html`
- Modify: `static/style.css`

Spec §3.3 prep overlay: responsive difficulty grid (fix brittle fixed-150px wrap), demote Just-listen/Clean/Mic-check into a secondary toolbar, Clean as a real switch, and Lucide mic icon.

- [ ] **Step 1: Swap the mic-check button emoji for the Lucide mic**

In `static/player.html`, find:

```html
                <button class="diff-gate-listen ctrl-btn" id="micCheckBtn" type="button" style="margin-top:6px;">🎤 Check your mic</button>
```

Replace with:

```html
                <button class="diff-gate-listen ctrl-btn" id="micCheckBtn" type="button" style="margin-top:6px;">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                  Check your mic
                </button>
```

- [ ] **Step 2: Make the difficulty grid responsive (replace fixed 150px wrap)**

In `static/style.css` (player section), find:

```css
        .diff-gate-cards { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
        .diff-card {
            width: 150px; padding: 18px 14px; background: var(--surface); color: var(--text);
            border: 1px solid var(--line); border-radius: var(--r); cursor: pointer;
            display: flex; flex-direction: column; gap: 6px; align-items: center;
            transition: transform .12s, border-color .12s, box-shadow .12s;
        }
```

Replace with (CSS grid, min-width track that wraps gracefully):

```css
        .diff-gate-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: var(--space-3);
            justify-content: center;
            width: min(620px, 90vw);
        }
        .diff-card {
            padding: var(--space-4) var(--space-3); background: var(--surface); color: var(--text);
            border: 1px solid var(--line); border-radius: var(--r); cursor: pointer;
            display: flex; flex-direction: column; gap: var(--space-1); align-items: center;
            transition: transform var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
        }
```

- [ ] **Step 3: Make the secondary actions a real toolbar**

In `static/player.html`, find the three secondary buttons + mic panel block:

```html
                <button class="diff-gate-listen ctrl-btn" onclick="justListen()">Just listen — no scoring</button>
                <button class="diff-gate-listen ctrl-btn" id="cleanModeToggle" type="button" aria-pressed="false" style="margin-top:6px;">Clean mode: Off</button>
                <button class="diff-gate-listen ctrl-btn" id="micCheckBtn" type="button" style="margin-top:6px;">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                  Check your mic
                </button>
```

Replace with (group them into a `.prep-toolbar`; drop the stacked `margin-top` inline styles):

```html
                <div class="prep-toolbar">
                    <button class="diff-gate-listen ctrl-btn" onclick="justListen()">Just listen — no scoring</button>
                    <button class="diff-gate-listen ctrl-btn" id="cleanModeToggle" type="button" aria-pressed="false">
                      <span class="switch-dot" aria-hidden="true"></span> Clean mode: <span id="cleanModeState">Off</span>
                    </button>
                    <button class="diff-gate-listen ctrl-btn" id="micCheckBtn" type="button">
                      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                      Check your mic
                    </button>
                </div>
```

> **Clean-mode label:** `player.js` currently does `cleanBtn.textContent = 'Clean mode: ' + (on ? 'On' : 'Off')`. That `.textContent` set would wipe the new `.switch-dot` + structure. Update the JS in Step 5 to set only the `#cleanModeState` span.

- [ ] **Step 4: Style the prep toolbar + the clean switch**

Append to the end of `static/style.css`:

```css
/* ---- prep secondary actions toolbar ---- */
.prep-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    align-items: center;
}
.prep-toolbar .diff-gate-listen { margin: 0; }
/* clean-mode switch dot (pressed = on) */
#cleanModeToggle .switch-dot {
    display: inline-block;
    width: 9px; height: 9px; border-radius: var(--r-pill);
    background: var(--text-faint);
    vertical-align: middle;
    margin-right: 2px;
    transition: background var(--dur-fast);
}
#cleanModeToggle[aria-pressed="true"] .switch-dot { background: var(--matched); }
#cleanModeToggle[aria-pressed="true"] { border-color: var(--matched); color: var(--text); }
```

- [ ] **Step 5: Update the clean-mode toggle JS to set only the state span**

In `static/player.js`, find:

```js
            cleanBtn.textContent = 'Clean mode: ' + (on ? 'On' : 'Off');
```

Replace with:

```js
            var cleanState = document.getElementById('cleanModeState');
            if (cleanState) cleanState.textContent = on ? 'On' : 'Off';
```

> **Verify the surrounding code** sets `cleanBtn.setAttribute('aria-pressed', ...)` already (the switch-dot CSS keys off `aria-pressed`). Run `grep -n "cleanModeToggle\|aria-pressed\|cleanBtn" static/player.js` and confirm the aria-pressed sync is present; if the function only set `.textContent`, add `cleanBtn.setAttribute('aria-pressed', on ? 'true' : 'false');` next to the new state-span set.

- [ ] **Step 6: Make the prep song title + mic panel use `.panel` (optional surface polish)**

In `static/player.html`, the `#micCheckPanel` is a bare div. Give it a panel surface. Find:

```html
                <div id="micCheckPanel" style="display:none">
```

Replace with:

```html
                <div id="micCheckPanel" class="panel" style="display:none;padding:14px 16px">
```

- [ ] **Step 7: Verify**

Run: `python app.py` then open http://localhost:5000/player, load a song (prep overlay shows).
- Difficulty cards now sit in a responsive grid (resize the window — they reflow without the brittle 150px jump).
- The three secondary actions sit on one toolbar row; the mic-check button shows the Lucide mic.
- Clicking "Clean mode" flips the dot green + label to "On" (and the scoring still respects clean mode — verify a profane song masks).
- Mic-check panel reads as a bordered panel.
- Light + dark both read.

Run: `node tests/test_mic_check_helpers.cjs` — Expected PASS (no helper logic changed).

- [ ] **Step 8: Commit**

```bash
git add static/player.html static/player.js static/style.css
git commit -m "feat(prep): responsive difficulty grid + secondary toolbar + real Clean switch + mic icon"
```

---

## Task 18: Player — unified score panel + debug-HUD `--font-mono` + on-fire flame icon

**Files:**
- Modify: `static/player.html`
- Modify: `static/style.css`

Spec §3.3 player stage: "One unified score panel (real container: 1px border, faint backdrop)" — Phase 1 wraps the existing accuracy readout + arcade HUD presentation onto a `.panel`-style container (the *points-hero rebuild* and reward feedback are Phase 2; Phase 1 just gives the existing HUD a real container and tokenizes it). Also: tokenize the debug HUD's hardcoded Courier New + grays, and swap the `🔥`/`ON FIRE` emoji.

- [ ] **Step 1: Give the arcade HUD a real container surface**

In `static/style.css` (player section), find:

```css
        .arcade-hud {
            position: fixed; top: 70px; right: 18px; z-index: 90;
            display: flex; flex-direction: column; align-items: flex-end; gap: 7px;
            pointer-events: none; font-variant-numeric: tabular-nums;
        }
```

Replace with (adds the 1px border + faint backdrop the spec asks for):

```css
        .arcade-hud {
            position: fixed; top: 70px; right: 18px; z-index: 90;
            display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2);
            pointer-events: none; font-variant-numeric: tabular-nums;
            padding: var(--space-3) var(--space-4);
            background: color-mix(in srgb, var(--surface) 82%, transparent);
            border: 1px solid var(--line);
            border-radius: var(--r);
            box-shadow: var(--shadow-card);
        }
```

> **`color-mix` note:** supported in current desktop Chrome/Edge (the only supported browsers per the desktop gate). If a non-supporting engine is ever a concern, the fallback is `background: var(--surface)`; not needed here given the gate.

- [ ] **Step 2: Swap the `ON FIRE` lockup to carry the flame icon**

In `static/player.html`, find:

```html
        <div class="ah-fire" id="ahFire" style="display:none">ON FIRE</div>
```

Replace with:

```html
        <div class="ah-fire" id="ahFire" style="display:none"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg> ON FIRE</div>
```

- [ ] **Step 3: Swap the streak `🔥` glyph in the HUD markup**

In `static/player.html`, find:

```html
        <div class="ah-streak" id="ahStreak" style="visibility:hidden">&#128293; <span id="ahStreakVal">0</span></div>
```

Replace with (Lucide flame in place of the fire emoji entity):

```html
        <div class="ah-streak" id="ahStreak" style="visibility:hidden"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg> <span id="ahStreakVal">0</span></div>
```

- [ ] **Step 4: Tokenize the debug HUD font + grays**

In `static/style.css` (player section), find:

```css
        #debug-hud {
            position: fixed;
            top: 60px;
            right: 0;
            width: 400px;
            max-height: calc(100vh - 80px);
            overflow-y: auto;
            background: rgba(7, 7, 16, 0.94);
            border-left: 2px solid var(--p);
            font-family: 'Courier New', monospace;
            font-size: 0.7rem;
            color: #ccc;
            padding: 8px 10px;
            z-index: 150;
            line-height: 1.55;
        }
```

Replace `font-family` + `color` with tokens:

```css
        #debug-hud {
            position: fixed;
            top: 60px;
            right: 0;
            width: 400px;
            max-height: calc(100vh - 80px);
            overflow-y: auto;
            background: rgba(7, 7, 16, 0.94);
            border-left: 2px solid var(--p);
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--gray-800);
            padding: var(--space-2) var(--space-3);
            z-index: 150;
            line-height: 1.55;
        }
```

And remap the debug row label grays. Find:

```css
        .dbg-label   { color: #666; }
```

Replace with:

```css
        .dbg-label   { color: var(--gray-600); }
```

Find:

```css
        .dbg-pending { color: #555; }
```

Replace with:

```css
        .dbg-pending { color: var(--gray-500); }
```

(The debug HUD keeps its dark `rgba(7,7,16,.94)` backdrop intentionally — it is a dev overlay and stays high-contrast-dark in both themes. Leave the `#88aaff`/`#5af`/`#999` accent rows as-is; they are dev-only debug accents.)

- [ ] **Step 5: Verify**

Run: `python app.py` then open http://localhost:5000/player, load a song, enter Game Mode.
- The arcade HUD now sits in a bordered, faint-backdrop container (top-right).
- Trigger a streak/on-fire (sing along) — the "ON FIRE" lockup shows the flame icon; the streak row shows the Lucide flame.
- Press D — the debug HUD renders in the mono token font with tokenized grays.
- Light + dark: the HUD container reads on white; the debug HUD stays its dark dev overlay (acceptable).

Run: `node tests/test_scoring_arcade.cjs` — Expected PASS (no arcade logic touched).

- [ ] **Step 6: Commit**

```bash
git add static/player.html static/style.css
git commit -m "feat(player): score-panel container + flame icons + tokenized debug HUD"
```

---

## Task 19: Player — results modal hierarchy + back link + `karaokee-score.png` rename

**Files:**
- Modify: `static/player.html`
- Modify: `static/player.js`
- Modify: `static/style.css`

Spec §3.3 Results: button hierarchy (primary Play Again, secondary Share/Back), `Back` → a real `<a href="/">`, Esc-to-close + `role=dialog`/`aria-modal`. Spec §3.6: rename the stale share filename `karaokee-score.png` → `audiopian-score.png`. (The staged-entrance animation + the scorecard tabular rebuild are Phase 2; Phase 1 does the structural/a11y + filename items.)

- [ ] **Step 1: Add dialog semantics + the action hierarchy**

In `static/player.html`, find the end-of-song modal:

```html
    <div class="game-modal" id="gameModal" style="display:none">
        <div class="game-modal-box">
```

Replace with (dialog role + aria-modal + labelled by the grade):

```html
    <div class="game-modal" id="gameModal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="gradeLetter">
        <div class="game-modal-box panel">
```

And find the actions row:

```html
            <div class="game-modal-actions">
                <button class="ctrl-btn" onclick="replayGame()">Play Again</button>
                <button class="ctrl-btn" id="shareImgBtn" style="display:none">Share image</button>
                <button class="ctrl-btn" onclick="window.location.href='/'">Back</button>
            </div>
```

Replace with (primary Play Again, secondary Share, real `<a>` Back):

```html
            <div class="game-modal-actions">
                <button class="btn btn--primary" onclick="replayGame()">Play Again</button>
                <button class="btn btn--secondary" id="shareImgBtn" style="display:none">Share image</button>
                <a class="btn btn--ghost" href="/">Back</a>
            </div>
```

- [ ] **Step 2: Add Esc-to-close wiring**

In `static/player.js`, find the `replayGame` function (it hides the modal). Immediately after the `replayGame` function definition, add a keydown listener:

```js
// Esc closes the end-of-song modal (goes back home — same as the Back action).
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var modal = document.getElementById('gameModal');
    if (modal && modal.style.display !== 'none') {
        window.location.href = '/';
    }
});
```

> **Stable anchor:** insert after the closing `}` of `function replayGame() { ... }` (search `function replayGame`). Do not place it inside `replayGame`.

- [ ] **Step 3: Rename the share filename**

In `static/player.js`, find (in `_downloadShareImage`):

```js
        a.download = 'karaokee-score.png';
```

Replace with:

```js
        a.download = 'audiopian-score.png';
```

- [ ] **Step 4: Make the grade hero use display fonts + tokens (light-safe)**

In `static/style.css` (player section), find:

```css
        .grade-letter {
            font-size: 5rem; font-weight: 700; line-height: 1; letter-spacing: -.02em;
            background: linear-gradient(135deg,var(--p),var(--s) 60%,var(--matched));
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
        }
```

Replace with (display font; gradient stays — reads on both themes):

```css
        .grade-letter {
            font-family: var(--font-display);
            font-size: 5rem; font-weight: 700; line-height: 1; letter-spacing: -.02em;
            background: linear-gradient(135deg,var(--p),var(--s) 60%,var(--matched));
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
        }
```

Also give the modal box a token shadow. Find:

```css
        .game-modal-box {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--r-lg);
            padding: 40px;
            text-align: center;
            min-width: 300px;
            box-shadow: 0 24px 70px rgba(0,0,0,.6);
        }
```

Replace `box-shadow` with the token (and let `.panel` from the markup supply border/bg — keep the explicit ones for specificity):

```css
        .game-modal-box {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--r-lg);
            padding: var(--space-7);
            text-align: center;
            min-width: 300px;
            box-shadow: var(--shadow-modal);
        }
```

- [ ] **Step 5: Verify**

Run: `python app.py` then open http://localhost:5000/player, play a short song to the end (or seek near the end) so the modal shows.
- Play Again is the primary (cyan) button; Share is secondary; Back is a ghost `<a href="/">` that actually navigates home.
- Press Esc — the modal closes (navigates home).
- The Share image downloads as `audiopian-score.png` (check the download filename).
- The grade letter is in the display font; modal reads in light + dark.

Run regressions:

```bash
node tests/test_share_card.cjs
python -m pytest tests/test_app.py -q
```

Expected: PASS (share-card pure logic + filename change don't affect tests; the rename is a string in `player.js` only).

- [ ] **Step 6: Commit**

```bash
git add static/player.html static/player.js static/style.css
git commit -m "feat(results): dialog a11y + action hierarchy + real Back link + audiopian-score.png"
```

---

## Task 20: Player — count-in polish + prep-card `.panel` + count-in label tokens

**Files:**
- Modify: `static/style.css`

Spec §3.3 prep: "Polished 3·2·1 count-in (per-tick label, "Go!" frame, clean numerals)." The per-tick label + "Go!"/"Get ready" frames are already driven by `player.js` (`countInLabel`/`countInNum`). Phase 1 polishes the **visual** treatment onto tokens (numerals already use a gradient + `countPop`). Keep the existing JS behavior; tokenize the styling.

- [ ] **Step 1: Tokenize the count-in numerals + label**

In `static/style.css` (player section), find:

```css
        .countin-num {
            font-size: 7rem; font-weight: 800; line-height: 1; letter-spacing: -.02em; color: transparent;
            background: linear-gradient(135deg, var(--p), var(--s)); -webkit-background-clip: text; background-clip: text;
            filter: drop-shadow(0 0 26px rgba(45,212,238,.45)); animation: countPop .4s ease-out;
        }
```

Replace with (display font; keep the gradient + pop):

```css
        .countin-num {
            font-family: var(--font-display);
            font-size: 7rem; font-weight: 800; line-height: 1; letter-spacing: -.02em; color: transparent;
            background: linear-gradient(135deg, var(--p), var(--s)); -webkit-background-clip: text; background-clip: text;
            filter: drop-shadow(0 0 26px rgba(45,212,238,.45)); animation: countPop .4s var(--ease-out);
        }
```

And find:

```css
        .countin-label { font-size: 1.45rem; font-weight: 700; color: var(--text); }
```

Replace with:

```css
        .countin-label { font-family: var(--font-display); font-size: var(--text-lg); font-weight: 700; color: var(--text); }
```

- [ ] **Step 2: Tokenize the prep song title + give the diff-gate a panel feel**

In `static/style.css` (player section), find:

```css
        .prep-song {
            font-size: 1.3rem;
            color: var(--text);
            font-weight: 700;
            max-width: 400px;
        }
```

Replace with:

```css
        .prep-song {
            font-family: var(--font-display);
            font-size: var(--text-lg);
            color: var(--text-strong);
            font-weight: 700;
            max-width: 400px;
        }
```

- [ ] **Step 3: Verify the count-in + prep in both themes**

Run: `python app.py` then open http://localhost:5000/player, load a song, pick a difficulty → the count-in overlay runs.
- 3 · 2 · 1 numerals are clean, gradient, pop on each tick; the label reads "Get ready to sing!" then the numerals; the song starts.
- The prep song title is in the display font.
- Light + dark both read.

- [ ] **Step 4: Commit**

```bash
git add static/style.css
git commit -m "feat(prep): tokenize count-in numerals/label + prep song title (display font)"
```

---

## Task 21: Phase 1 integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run every JS `.cjs` test**

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … tests passed." line; no failures. (No scoring logic was touched, so all stay green.)

- [ ] **Step 2: Run the Python suite**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS.

- [ ] **Step 3: Grep for residual emoji/entity icons + stale strings**

```bash
grep -rn "🎮\|▶\|⏮\|⏭\|🔊\|🎤\|🔥\|♪\|&#128293;\|karaokee-score\|TODO(operator)\|confirmPulse\|asr-confirmed" static/
```

Expected: no output (every emoji/entity icon swapped to Lucide; share filename renamed; operator TODOs gone; dead CSS removed). The `🎮` in `dbg-header` is gone; `♪` in no-lyrics is gone.

- [ ] **Step 4: Manual theme + surface matrix (preview)**

Run: `python app.py`. For each surface, toggle dark↔light and confirm **polished** (not just unbroken) light + intact dark:
- **Landing** (`/`): header toggle, value-prop sub, thumbnail pickers (starter + search + resolve), search loading spinner, red "No songs found", interstitial dialog (toggle it on in console).
- **Legal** (`/terms`, `/privacy`, `/dmca`): Inter 16/1.7 body, display headings, fixed toggle, shared footer with live year.
- **Player** (`/player`): theme follows toggle across the whole stage; Lucide transport/volume/mic/gamepad/flame icons; arcade HUD container; difficulty grid reflow; Clean switch; count-in; results modal (Play Again primary / ghost Back `<a>` / Esc-closes / `audiopian-score.png`).

- [ ] **Step 5: Confirm branch state**

```bash
git log --oneline feat/ux-geist-redesign -25
git status
```

Expected: the Phase-1 commits on `feat/ux-geist-redesign` (one per task above) on top of the Phase-0 commits; clean working tree.

---

## Phase 1 done — what's next

Phase 1 re-skins every surface onto the Phase-0 tokens/components, makes light mode polished while keeping dark intact, vendors Lucide inline-SVG icons (no build step), loads Inter, adds head hygiene, thumbnails in both pickers, the unified+colored status system, the audit-verified dead-UI cleanup, and brings the player into the theme system with its own toggle. **Scoring logic stayed frozen.** Still ahead:

- **Phase 2** — the unified **points-hero** score panel + reward feedback (the `+points` popup, score count-up, tier-up beat, streak milestones, PERFECT/NICE/partial verdicts) consuming `score-feedback-helpers.js`; the **C beat-synced on-fire** consuming `beat-pulse-helpers.js`; the **share-card rebuild** (on-brand backdrop, real cyan→magenta accent replacing `#8b5cf6`, Space Grotesk on canvas); and the **results staged entrance**.
- **Phase 3** — progressive **word-by-word fill** consuming `word-fill-helpers.js` (mapping `interpolateWordTimings` word objects — `{windowStart, windowEnd}` in seconds — onto the helper's `{start, end}`), behind its helper + `.cjs` tests, verified not to disturb scoring honesty.
