# UX Refresh — "Neon Arcade, Grown Up" — Design Spec

**Date:** 2026-06-08
**Author:** Westside Sage (+ Claude)
**Builds on:** the existing two-page frontend (`static/index.html`, `static/player.html`, `static/style.css`). No JS or scoring changes.
**Status:** Approved (design).
**Validated mockups:** `.superpowers/brainstorm/2039-1780940365/content/` (`directions.html` → direction pick; `directions-v2.html` → accent pick). Locked: **Direction A, Cyan × Magenta**.

---

## 1. Context & Goal

The UI has been visually unchanged since the app was first built: near-black `#0d0d0d` background, navy `#1a1a2e` cards, a single hot-magenta `#e040fb` accent, and a scattered set of green/amber/orange/red accents with **no shared token system**. Colors are hardcoded across `style.css`, a large inline `<style>` block in `player.html`, and heavy inline `style="…"` attributes in `index.html`. It reads as "early-prototype dark mode."

We're about to record demos, so the look needs to feel **intentional and polished** without a rebuild.

**Goal:** a CSS-led refresh to a coherent, **adult-but-fun "Neon Arcade"** aesthetic — refined cyan × magenta neon on deep ink, controlled glow, Space Grotesk type, a designed wordmark, and score displays that feel like an arcade game. **Purely visual.** No changes to `player.js`, the scoring/phrase engines, the playback adapters, or any behavior. The DOM/selector contract that the scoring engine drives is preserved exactly.

---

## 2. Visual direction & tokens

Refined take on the original "Neon Arcade" direction, executed with restraint (borrowing the "Midnight Studio" discipline): glow used only on hero score numbers, hairline panel borders, tracked-caps micro-labels, modern geometric type. The single structural win is a **`:root` custom-property palette** that every rule routes through.

```css
:root {
  /* surfaces */
  --bg:#0a0b14;            /* app base (with two soft corner glows) */
  --bg-deep:#070710;       /* overlays / prep screen */
  --surface:#10121c;       /* header, controls, cards, modal */
  --surface-2:#161a28;     /* inputs, raised chips */
  --line:rgba(255,255,255,.07);   /* hairline borders */
  /* text */
  --text:#e7e9f2; --text-dim:#8a8c9e; --text-faint:#5c5f73;
  /* accents */
  --p:#2dd4ee;             /* primary — cyan */
  --s:#f0468f;             /* secondary — magenta */
  /* status (semantic, constant across the app) */
  --matched:#34e89e; --partial:#ffcf5c; --missed:#ff5d73;
  --key:var(--p);          /* key-word cue */
  /* fire (warm, fixed — reads as "hot") */
  --fire-a:#ff5470; --fire-b:#ff9f45;
  /* shape & type */
  --r:10px; --r-lg:18px;
  --font:'Space Grotesk','Segoe UI',system-ui,sans-serif;
}
```

- **Hero numbers** (`#ahPoints`, `.grade-letter`, `.grade-points`) use a `--p → --s` gradient text fill with a small, low-alpha `drop-shadow` glow — the *only* place glow appears.
- **Typography:** Space Grotesk via a Google Fonts `<link>` + `preconnect` in both HTML heads (system fallback in the token). Tabular numerals (`font-variant-numeric:tabular-nums`) on scores, multiplier, and the time display.
- **Wordmark:** a small gradient "dot" mark + "KARAOKEE" in tracked caps. The literal 🎤 emoji is dropped (approved).

---

## 3. Files (scope)

- **`static/style.css`** — add the `:root` token block; restyle the landing page (card, inputs, buttons, status, search rows/dividers, BYO-key disclosure, the `#unsupported` overlay) through tokens.
- **`static/index.html`** — consolidate the page's inline `style="…"` attributes into classes in `style.css`; apply the wordmark. **Preserve** any functional inline state.
- **`static/player.html`** — restyle the inline `<style>` block through tokens: header, lyrics + word-scoring, arcade HUD + `arcade-onfire`, difficulty gate / prep overlay, controls bar, end-screen modal / grade hero, debug HUD (light touch). Add the font `<link>`. Restyle the `#ytplayer-wrap` chrome **without** touching the `#ytplayer-wrap iframe` fill rule.

No new JS files. No changes to `player.js` or any helper/scoring module.

---

## 4. Hard constraints — the DOM/selector contract (must not break)

The scoring engine drives the DOM by specific IDs and toggled classes ([player.js](../../static/player.js)). The refresh **restyles these selectors in place** — never renames, removes, or restructures them.

**Classes toggled by JS (keep names + keep them meaningful in both states):**
`active`, `upcoming` (lyric lines); `matched`, `matched-partial`, `missed`, `key-word`, `asr-confirmed` (word spans); `arcade-onfire` (on `body`); `bump` (`#ahPoints`); `selected` (`.diff-card`); `active` (`.game-btn`); `locked` (`.diff-select`).

**Elements whose `display`/`visibility` JS flips at runtime — keep their initial inline `display:none` in the HTML and DO NOT set `display` on them in CSS:**
- *Player:* `#score-display`, `#diff-pill`, `#arcadeHud`, `#ahFire`, `#ahStreak` (visibility), `#gameModal`, `#gradeHero`, `#nbRibbon`, `#shareImgBtn`, `#lrc-offset-control`, `#debug-hud`, `#no-lyrics`, `#benchmarkFeedback`, `#prepOverlay`, `#diffPreview`.
- *Landing:* `#retryBtn` (starts `display:none`, JS → `block` after a lyrics miss) and `#localUploadSection` (JS → `none` on non-dev hosts). When consolidating `index.html`'s inline styles into classes, move only the **cosmetic** bits (color/background/spacing) into a class; **leave the functional `display:none` inline** on `#retryBtn`.

(Style their colors/typography/layout-internals freely; just don't own their show/hide.)

**Animations to preserve (rename-free):** `confirmPulse`, `firePulse`, `spin`, `fadeOut`, plus the `.bump` transform.

**No build step / no framework** — vanilla CSS + HTML only.

---

## 5. Implementation order (right-sized plan)

A CSS refresh, so the spec doubles as the plan — small, sequential, verify-at-the-end:

1. **Tokens first.** Add the `:root` block to `style.css` and the font `<link>`/`preconnect` to both HTML heads.
2. **Landing** (`style.css` + `index.html`): route existing rules through tokens, consolidate inline styles into classes, apply the wordmark + glow background. Verify the page in a browser.
3. **Player chrome** (`player.html` `<style>`): header, controls bar, lyrics container/lines, word-scoring colors.
4. **Score displays** (the headline of the request): arcade HUD (points/mult/ramp/streak/fire), `arcade-onfire` active-line treatment, end-screen grade hero + New-Best ribbon, header score pill.
5. **Difficulty gate / prep overlay**, debug HUD light touch, `#ytplayer-wrap` chrome.
6. **Smoke-test & screenshot** (see §6); adjust spacing/contrast.

Each step is independently viewable in the running app.

---

## 6. Testing / verification

- **Automated:** styling-only — the `.cjs` and `pytest` suites assert behavior, not CSS, so they must stay **green** (run them to confirm nothing was disturbed). `node --check` clean on any touched HTML-embedded scripts (none expected).
- **Selector-contract check:** grep that every class/ID in §4 still exists post-edit (no renames).
- **Manual (browser):** landing renders with the new look → load a song (or a local file in dev) → start a game run → confirm the active line, **word-scoring colors** (matched/partial/missed/key), the **arcade HUD** (points bump, multiplier, ramp, streak, ON FIRE + `arcade-onfire` line treatment), and the **grade end-screen** (gradient letter, stats, New-Best ribbon, share button) all render correctly. Screenshot landing + an in-game frame + the end screen.

---

## 7. Out of scope (YAGNI)

- **No behavior changes** — scoring, honesty model, matching, timing, ASR/provider logic, telemetry, playback adapters all untouched.
- **No markup restructuring** beyond consolidating `index.html`'s inline styles into classes (and adding wordmark/font markup). No new components, no layout re-architecture.
- **No `player.css` extraction** — keep `player.html`'s `<style>` in place for now (lower churn). Can revisit later.
- **No responsive/mobile redesign** — the app is desktop-Chrome/Edge gated; keep current layout behavior.
- **No animation rework** beyond what the token restyle implies.

## 8. Open items

- Final font is Space Grotesk; trivially swappable later via the single `--font` token if a different display face is preferred after seeing it live.
- Exact glow intensity / contrast on the active-line `arcade-onfire` treatment may need a nudge after the smoke-test on a real song.
