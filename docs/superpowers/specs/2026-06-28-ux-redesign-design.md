# Audiopian UX Redesign — Design Spec

- **Date:** 2026-06-28
- **Status:** Approved (brainstorming complete) — ready for implementation planning
- **Author:** Westside Sage + Claude
- **Supersedes:** the ad-hoc styling that grew up across `static/style.css` + the inline `<style>` in `static/player.html`
- **Grounded in:** a full-frontend UX audit (8 parallel sector audits + synthesis), 2026-06-28

## 1. Goal

The app's gameplay/UX has never had a ground-up design pass — only gameplay/scoring iteration. The flow is good; the *look* is three divergent visual languages in one repo (a clean landing/legal card system, a 490-line inline neon-arcade player skin, and an off-brand canvas share-card). Rebuild the entire frontend on **one coherent, well-established design language** inspired by Vercel's **Geist** — clean, minimal, "official" — while making the arcade moments (on-fire, scoring) genuinely more exciting via *event-driven motion* rather than ambient decoration.

Non-negotiables carried in from the existing architecture: **no build step** (plain HTML/CSS/JS served by Flask/Cloudflare static), the **JS helper-isolation pattern** (pure UMD helpers + `.cjs` tests; `player.js` is the only DOM-bound file), and **scoring logic stays untouched** (`scoring-arcade.js` / `scoring-session.js` / `scoring.js` / `phrase-engine.js` are pure and tested — this redesign is render-layer only).

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Theme | **Dual light/dark**, header toggle, **default dark**, choice persisted; the gameplay stage **follows the theme** (no permanent dark "theater") |
| 2 | Headline score | **Points is the hero** (and the share number); **accuracy %** is the secondary honesty stat (still stars on the results screen) |
| 3 | On-fire | **Full-arcade ("C")**, **beat-synced** — event-driven ignition → sustained pulse on the song's tempo → fade; `prefers-reduced-motion` ⇒ vivid look held steady |
| 4 | Typography | **Split** — **Space Grotesk** (wordmark, headings, big score numbers) + **Inter** (body, UI, legal). Geist Sans is an optional drop-in swap for Inter later. |
| 5 | Foundation | A real **design-token layer** + shared component classes; extract the player's inline CSS into the shared sheet |
| 6 | Word-by-word fill | **In scope** (heaviest item; gated behind tests — touches the live scoring render path) |
| 7 | Mobile | **Out of scope** — player stays desktop-gated; responsive/viewport **left untouched**. (Cheap *non-mobile* head hygiene — favicon, meta description, OG/Twitter cards — is still in.) |
| 8 | Pickers | **Real thumbnails** (videoId already in hand) |
| 9 | Icons | **Lucide** inline SVG replaces all emoji/entity icons |
| 10 | Execution | **Foundation first, then re-skin** (token/component layer → surfaces → scoring/on-fire → word-fill) |

## 3. Design detail

### 3.1 Token + component foundation

`static/style.css` becomes the **single source of truth**, linked by every page (`index.html`, `player.html`, `terms/privacy/dmca.html`). The ~490-line inline `<style>` block in `player.html` is removed and re-homed here as token-driven component + player rules.

**Token groups** (representative values — final hues tuned in implementation against Geist):

- **Neutral ramp:** `--gray-50 … --gray-900` (low-chroma). Dark theme maps surfaces/text/borders onto it; light theme overrides. Every hardcoded grey in `player.html` (`#4b4e60`, `#6c6f82`, `#aaa`, `#ccc`, `#666`, `#555`, `#fff`) remaps onto this ramp.
- **Semantic aliases:** `--bg`, `--bg-elev`, `--surface`, `--surface-2`, `--text`, `--text-dim`, `--text-faint`, `--border`, `--border-strong`, `--bg-wash` (kills the 3×-duplicated background wash).
- **Two accent identities (intentionally distinct):**
  - **Brand** = cyan→magenta. Used *sparingly*: active key-word, logo dot, focus ring, primary CTA accent. A single canonical gradient angle (no more 96/95/135/90deg copies).
  - **Fire** = warm red→orange→gold. Used **only** in the on-fire state, so "on fire" is visually its own event, never confused with the normal brand accent.
- **Scoring colors:** `--key` (key-word cyan), `--matched` (green), `--partial` (amber), `--missed` (red) — promoted to real tokens and actually consumed (the current `--key` is defined but unused).
- **Type scale:** `--text-xs … --text-3xl` + `--font-display` (Space Grotesk), `--font-text` (Inter), `--font-mono` (replaces the debug HUD's hardcoded Courier New). Consolidates the ~25 ad-hoc rem sizes and the 3 near-duplicate "tiny uppercase label" treatments.
- **Spacing scale:** 4px base (`--space-1 … --space-8`); replaces 100% literal px.
- **Radius:** one language (`--r-sm`, `--r`, `--r-lg`, `--r-pill`); player's hardcoded 7/8/999px adopt it.
- **Shadows:** `--shadow-card`, `--shadow-modal`, `--glow`; replaces copy-pasted `0 24px 60px rgba(0,0,0,.5)` literals.
- **Motion:** `--dur-fast/-base/-slow`, `--ease-out`, `--ease-spring`; plus a **global `@media (prefers-reduced-motion: reduce)`** guard (none exists today anywhere).

**Reusable components** (replace per-element re-derivations):

- `.btn` with `--variant` modifiers: `primary` (brand), `secondary`, `ghost`. Player's `.ctrl-btn`/`.back-btn`/`.offset-btn`/`.game-modal` buttons inherit instead of re-styling.
- `.card` / `.panel` (1px border, token surface, `--shadow-card`).
- `.pill`, `.chip`.
- **Universal `:focus-visible`** ring (reuse the existing input ring pattern) on *all* buttons, links, transport controls, and result rows — currently nearly absent (only inputs + one `.diff-card`).

### 3.2 Theme system mechanics

- Dark tokens live on `:root`; `:root[data-theme="light"]` overrides them.
- **No-FOUC boot:** a tiny inline `<script>` in each page `<head>` (before the stylesheet's paint) reads `localStorage['audiopian-theme']`; if unset, falls back to `window.matchMedia('(prefers-color-scheme: light)')`; sets `data-theme` on `<html>` immediately.
- Header **theme toggle** (Lucide sun/moon) on every page writes `localStorage` and flips `data-theme`.
- The stage follows the theme. Consequence (accepted): the on-fire glow must read on white → the fire treatment leans on **border/shape/embers/motion**, not a dark-only glow. (This discipline is baked into 3.4.)

### 3.3 Surfaces

- **Landing (`index.html`):**
  - Value prop above the fold (headline + sub: *scored · free · any song · in your browser*).
  - **Thumbnail pickers** for both the lyrics-search results and the resolve-stage video picker (YouTube thumb + album art where available).
  - **Unify the two status systems** (`#status` vs `#searchStatus`) into one, and **fix the verified bug**: there is no `#searchStatus.error/.success` rule today, so primary-path errors ("No songs found") render colorless. Add `role=status`/`role=alert`.
  - Real loading state: disable + spinner the Search button (never disabled today); skeleton rows.
  - Redesigned "best match" badge (replace the `'  ✓'` string-concat + near-invisible border).
  - Result rows become real keyboard-operable controls.
  - Header: wordmark + theme toggle.
  - Improve the desktop-only interstitial into a helpful screen (`role=dialog`, one-line "why", copy-link).
- **Prep overlay (`player.html` / `player.js`):**
  - Responsive difficulty grid (fix brittle fixed-150px wrap).
  - One primary **Start**; demote **Just-listen / Clean / Mic-check** into a secondary toolbar.
  - **Clean mode** becomes a real switch.
  - Explicit loading state above the cards.
  - Polished **3·2·1 count-in** (per-tick label, "Go!" frame, clean numerals).
  - Keep the live per-song key-word preview and the point-of-capture privacy disclosure (both good).
- **Player stage:**
  - Add a **quiet wordmark** to the header (gameplay has zero branding today).
  - **One unified score panel** (real container: 1px border, faint backdrop) replacing the two floating corners — **points hero**, accuracy secondary.
  - Lucide transport/volume/mic icons.
  - Restyled lyric reader (center-stacked large type retained — the right instinct).
- **Results (`.game-modal` → grade hero):**
  - **Staged entrance:** overlay fade → card scale-in → grade pop → points count-up → NEW BEST after settle (today it's a hard `display` flip).
  - Geist **scorecard** layout: headline grade + points, then a tabular 2-col stat grid, secondary metadata de-emphasized; reconcile the NEW BEST ribbon (drop the rotated neon-sticker idiom).
  - Button hierarchy: primary **Play Again**, secondary Share / Back; `Back` → real `<a href="/">`; Esc-to-close + `role=dialog`/`aria-modal`.
- **Legal (`terms/privacy/dmca.html`):** reskin onto the flat light "doc" surface; Inter body ~16px/1.7; remove shipped operator TODO comments.
- **Global:** one shared footer across landing + player + legal (three different bottom treatments today); dynamic © year.

### 3.4 Scoring & on-fire (render layer only)

`scoring-arcade.js` already computes everything (`points`, `pointsAwarded`, `multiplier`, ramp, `streak`, `onFire`, `grade`). The redesign **surfaces the data that's currently discarded** and rebuilds the visuals:

- **`pointsAwarded` is shown:** a floating **+250** spring on each clear (in the event today, only triggers a scale bump — `player.js:1158`).
- **Score count-up** on the total instead of the hard `textContent` snap (`player.js:1157`).
- **One-shot tier-up beat** when the multiplier increases.
- **Streak-milestone callouts** at 10 / 25 / 50, visually distinct from on-fire.
- **Per-line verdict:** **PERFECT / NICE / partial** replacing the bare `+3/4` fraction (`player.js:1015`).
- **On-fire = the approved "C, beat-synced" treatment:** event-driven **ignition** (one-shot) → **sustained pulse** whose rate comes from the song's tempo class (`sync-helpers.js`) and whose phase is anchored to **word-onsets** (already tracked) so it reads as beat-locked → **fade** on exit. Embers + warm floor-glow + a bold "ON FIRE" lockup + gradient-flamed active lyric. Lyrics stay still for readability. `prefers-reduced-motion` ⇒ the vivid state holds steady (no pulse). Phase-lock to the literal downbeat is **not** possible (YouTube IFrame is a cross-origin sandbox — no Web Audio access); accepted.
- **Word-by-word fill:** progressive left-to-right color sweep across each word as its timing window passes (vs today's discrete grey→green/amber/red snap), driven off `interpolateWordTimings`. **Highest-risk item** — gated behind tests and verified not to disturb scoring honesty before it's wired live.

**New pure helpers (UMD + `.cjs` tests), so `player.js` does not grow:**

- `beat-pulse-helpers.js` — tempo-class → pulse period, word-onset phase anchor, reduced-motion gating.
- `score-feedback-helpers.js` — `+points` popup formatting, count-up step sequencing, tier-up/streak-milestone trigger logic, per-line verdict mapping (score → PERFECT/NICE/partial).
- `word-fill-helpers.js` — per-word fill progress (0–1) from word timings + clock.

### 3.5 Icons & assets

- **Lucide** as inline SVG (no build step; either a tiny vendored subset or copied path data), sized from an icon token, replacing every emoji/entity (`🎮 ▶ ⏮ ⏭ 🔊 🎤 🔥 ♪ ← ✓`).
- **Head hygiene (non-mobile):** favicon, meta description, OG/Twitter share cards on all pages.

### 3.6 Cleanup (audit-verified dead UI)

Remove only well-supported items (each confirmed against source in the audit):

- `@keyframes confirmPulse` + `.word-span.asr-confirmed` (class is only ever *removed*, never added — `player.js:1028`) and the dangling `'asr-confirmed'` in the `classList.remove`.
- `.game-modal-title` / `.game-modal-score` / `.game-modal-stats` (CSS-only, no HTML/JS ref — superseded by `.grade-*`).
- `--key` indirection (either delete or actually wire it — this spec **wires it**, §3.1).
- `--fire-a` / `--fire-b` in the *landing* sheet (dead there; they move into the shared layer with the player CSS).
- `.tagline a` / `.tagline a:hover` (tagline is plain text).
- bare-`h1` fallback (all h1s are `.wordmark` / `h1.doc-title`).
- `.hint-text` + `label .hint` (orphaned).
- `#searchBtn` id (never queried).
- Shipped operator TODO comments (`terms.html:62`, `dmca.html:50-52`).
- Stale share filename `karaokee-score.png` → **`audiopian-score.png`** (`player.js:1772`).

**Keep:** `#debug-hud` (D-key gated — just reskin onto tokens), `#localUploadSection`/`#audio` (dev-scoped).

### 3.7 Share card rebuild

The 1080² canvas share image (`player.js` `_downloadShareImage` + `share-card.js`) is rebuilt on-brand: app backdrop, Space Grotesk (loaded for canvas), real cyan→magenta accent (not the stray `#8b5cf6`), wordmark, `audiopian-score.png` filename. `share-card.js`'s pure `buildShareCardLines` stays test-covered.

## 4. Testing & isolation

- Preserve the helper-isolation pattern: **all new logic lands as pure UMD helpers with `.cjs` tests** (`beat-pulse-helpers`, `score-feedback-helpers`, `word-fill-helpers`), never as new branching inside `player.js`.
- All existing JS (`tests/*.cjs`) and Python (`tests/test_*.py`) tests stay green.
- Visual/interaction changes verified in the live preview (theme toggle, on-fire ignition, count-up, word-fill, results entrance, focus rings).
- Word-fill specifically: prove the fill is a pure overlay on the existing paint and does not change what the scorer credits.

## 5. Sequencing (phased, each independently shippable)

- **Phase 0 — Foundation:** token layer + dual-theme + boot script + theme toggle + component classes; extract player inline `<style>` into `style.css`. No visible redesign yet beyond the toggle; everything still works.
- **Phase 1 — Re-skin surfaces:** landing, prep, player shell, results, legal, footer onto tokens/components; Lucide icons; thumbnails; status-system fix; head hygiene; dead-UI cleanup.
- **Phase 2 — Scoring feedback & on-fire:** unified score panel, +points popup, count-up, tier-up, streak milestones, per-line verdicts, the C beat-synced on-fire, share-card rebuild, results staged entrance.
- **Phase 3 — Word-by-word fill:** the progressive sweep, behind its helper + tests, verified against scoring honesty.

## 6. Risks & out of scope

- **Word-fill** is the one item that can destabilize the live scoring render → isolated helper, tests, and pre-wire verification (Phase 3, last).
- **Beat-sync** cannot phase-lock to the literal downbeat (YouTube IFrame sandbox) — rate-matched + word-onset-anchored is accepted as "reads locked."
- **Mobile** responsive/viewport is untouched; player stays desktop-gated.
- **No build step** preserved throughout (fonts self-hosted/CDN, Lucide inline).

## 7. Files of record

- `static/style.css` — the new single source of truth (tokens + components + player rules).
- `static/player.html` — inline `<style>` removed; markup updated for new components/icons/score panel.
- `static/index.html`, `static/terms.html`, `static/privacy.html`, `static/dmca.html` — reskin + theme boot + head hygiene + shared footer.
- `static/player.js` — render-layer wiring of the new helpers (DOM only).
- **New:** `static/beat-pulse-helpers.js`, `static/score-feedback-helpers.js`, `static/word-fill-helpers.js` (+ `tests/test_*.cjs`).
- `static/share-card.js` + `player.js` `_downloadShareImage` — on-brand rebuild.
- `scoring-arcade.js` / `scoring-session.js` / `scoring.js` / `phrase-engine.js` — **untouched** (logic frozen).

## 8. Open defaults (proceed unless changed)

- Body/UI text face = **Inter** (Geist Sans is a later one-line swap).
- Theme default = **dark**; first-visit honors OS preference.
- `prefers-reduced-motion` = vivid-but-static for on-fire; no count-up/pulse.
- On-fire pulse intensity ≈ the approved 125-BPM mock feel.
