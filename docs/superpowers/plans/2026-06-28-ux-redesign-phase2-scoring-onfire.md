# UX Redesign — Phase 2: Scoring Feedback, On-Fire & Results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the arcade-scoring data that is currently computed and discarded, and rebuild the gameplay reward + on-fire visuals as **event-driven motion** (not ambient decoration). Concretely: one unified score panel (points hero / accuracy secondary), a floating **+points** popup, a score **count-up**, a one-shot **tier-up** beat, **streak-milestone** callouts, per-line **PERFECT / NICE / partial** verdicts, the approved **C beat-synced on-fire** treatment, an on-brand **share-card** rebuild, and a **staged results entrance**. All render-layer only — the scoring state machines stay frozen.

**Architecture:** `scoring-arcade.js` already emits everything the visuals need (`pointsAwarded`, `points`, `multiplier`, `ramp`, `streak`, `onFire`, plus `perfect`/`outcome` on commit). This phase **reads that event payload** in `player.js` (`_renderArcadeHud`, `_onArcadeEvent`, `_renderLineScored`, `showEndModal`) and paints it using two **new pure UMD helpers** built by parallel plans — `beat-pulse-helpers.js` (tempo→pulse period + word-onset phase) and `score-feedback-helpers.js` (popup/count-up/verdict/tier/streak formatting). `player.js` **wires** these helpers; it never reimplements their logic. CSS for the score panel, on-fire, popups, and the results entrance lives in `static/style.css` (the player CSS now lives there after Phase 0/1). The share-card rebuild touches `share-card.js` (pure line-building — already test-covered) + `player.js` `_downloadShareImage` (the canvas draw).

**Tech Stack:** Plain HTML/CSS/JS (no build step), the UMD helper-isolation pattern (`new Function`-loadable for `.cjs` tests; `player.js` is the only DOM-bound file), Flask static serving (`python app.py` → http://localhost:5000), Node for JS tests. Beat-sync is **rate-matched + word-onset-anchored**, not phase-locked to the literal downbeat (YouTube IFrame is a cross-origin sandbox with no Web Audio access — accepted, per spec §3.4 / §6).

**Depends on:**
- **Phase 1** (surfaces re-skinned onto tokens/components; the player joined the theme system; Lucide icons; player CSS already relocated into `static/style.css` in Phase 0). The score panel + on-fire must read in **both** light and dark themes.
- **`static/beat-pulse-helpers.js`** (`window.KaraokeeBeatPulse`) — built by a separate parallel plan. Consumed here; **do not** reimplement.
- **`static/score-feedback-helpers.js`** (`window.KaraokeeScoreFeedback`) — built by a separate parallel plan. Consumed here; **do not** reimplement.

This plan implements spec **§3.4** (render layer; `scoring-arcade.js` frozen), **§3.7** (share-card rebuild), and the **§3.3** results staged entrance. Branch: `feat/ux-geist-redesign`.

**Frozen (never edit in this phase):** `static/scoring-arcade.js`, `static/scoring-session.js`, `static/scoring.js`, `static/phrase-engine.js`. If a visual seems to need a scoring change, stop — it doesn't; re-read the event payload (`commitPhrase` returns `{phraseId, outcome, perfect, pointsAwarded, points, multiplier, ramp, rampPerTier, streak, onFire}`).

**Canonical helper APIs consumed here (build/consume EXACTLY as written by the parallel plans):**

`window.KaraokeeBeatPulse`:
- `DEFAULT_PERIOD_MS = 480`
- `pulsePeriodMs(tempoClass)`: `'slow'`→700, `'normal'`→480, `'fast'`→350, else→480.
- `beatPhase(nowMs, periodMs, anchorMs)`: 0..1 fraction through the current beat; `((nowMs-anchorMs) mod periodMs)/periodMs` normalized to `[0,1)`; `periodMs<=0`→0; missing `anchorMs`→treat as 0; tolerates `nowMs` many periods after `anchorMs`.

`window.KaraokeeScoreFeedback`:
- `formatPointsGain(pointsAwarded)`: int>0 → `'+'` + thousands-grouped (`250`→`'+250'`, `1250`→`'+1,250'`); `<=0`/non-finite → `''`.
- `countUpValue(from, to, t)`: ease-out interpolated **integer** for `t`∈`[0,1]`; `countUpValue(from,to,0)===from`; `countUpValue(from,to,1)===to`.
- `countUpDurationMs(delta)`: `clamp(round(300 + abs(delta)*0.4), 300, 1200)`.
- `lineVerdict(score, maxScore)`: `r = (maxScore>0 ? score/maxScore : 0)`; `r>=1`→`'perfect'`; `r>=0.75`→`'nice'`; `r>0`→`'partial'`; else `'miss'`.
- `milestoneForStreak(streak)`: exactly `10|25|50` → `String(streak)+' STREAK'`; else `null`.
- `tierUpLabel(prevMultiplier, multiplier)`: `multiplier>prevMultiplier` → `String(multiplier)+'x'`; else `null`.

**Note on writing JS with template literals (Windows):** `player.js` and any helper using backtick template literals (`` `${x}` ``) must be edited with the **Edit/Write tool directly**, never via shell heredocs — Windows strips backtick contents in heredocs (see CLAUDE.md / MEMORY.md). This plan's `player.js` edits use plain string concatenation to stay safe, but if you choose template literals, use Edit/Write.

---

## Phase 2 boundaries (read before starting)

- **Render layer only.** No edits to the four frozen scoring files. Every number you display already exists on the arcade event or summary.
- **The two pulse/feedback helpers are pre-built** by parallel plans. Your job is to **call** them. If they are not yet present, their `tests/test_*.cjs` will be missing — coordinate; do **not** stub them inside `player.js`.
- **Beat anchor = a real sung word onset.** Capture the live clock (`this._now()` in **seconds**, ×1000 for ms) on each `wordMatched` render event and store it as `this._lastOnsetMs`. The pulse phase is anchored to that instant so it "reads locked" without Web Audio.
- **`prefers-reduced-motion` ⇒ vivid-but-static.** The on-fire look (warm gradient, embers, floor-glow, lockup) stays; the *pulse animation* and *count-up* do not run. Gate motion in `player.js` via `matchMedia('(prefers-reduced-motion: reduce)')` (the global CSS guard from Phase 0 also collapses animation durations as a backstop).
- **Both themes.** On-fire leans on **border/shape/embers/gradient/motion**, not a dark-only glow, so it reads on a white stage (spec §3.2). Verify in light mode too.
- **Lyrics stay still** during on-fire (readability). The pulse drives the score panel + lockup + floor-glow, never the lyric text position.
- **All existing tests stay green** (`tests/*.cjs`, `tests/test_*.py`).

---

## Task 1: Wire the new helpers into `player.html` (script includes)

**Files:**
- Modify: `static/player.html` (the `<script src="…">` block at the end of `<body>`)

The helpers are loaded as browser globals before `player.js`, matching the existing helper-include ordering.

- [ ] **Step 1: Add the two helper includes before `player.js`**

In `static/player.html`, locate the existing script include line:

```html
    <script src="/static/mic-check-helpers.js"></script>
```

(immediately before `<script src="/static/player.js"></script>`), and insert **before** the `player.js` line:

```html
    <script src="/static/beat-pulse-helpers.js"></script>
    <script src="/static/score-feedback-helpers.js"></script>
```

The final tail must read:

```html
    <script src="/static/mic-check-helpers.js"></script>
    <script src="/static/beat-pulse-helpers.js"></script>
    <script src="/static/score-feedback-helpers.js"></script>
    <script src="/static/player.js"></script>
```

- [ ] **Step 2: Verify the includes load (no 404, globals present)**

Run: `python app.py` then open http://localhost:5000/player (load any song via search, or the local-upload dev path).
In DevTools console:

```js
[!!window.KaraokeeBeatPulse, !!window.KaraokeeScoreFeedback]
```

Expected: `[true, true]`. Network tab shows both files `200`. (If `false`, the parallel helper plans haven't landed yet — stop and coordinate; do not proceed.)

- [ ] **Step 3: Commit**

```bash
git add static/player.html
git commit -m "feat(player): load beat-pulse + score-feedback helpers before player.js"
```

---

## Task 2: Unified score panel — markup (replace the two floating corners)

**Files:**
- Modify: `static/player.html` (the `.score-display` in `.player-header`, and the `.arcade-hud` block)

Today there are two separate floating readouts: `#score-display` (accuracy %, in the header) and the fixed `#arcadeHud` (points/mult/ramp/streak/fire). This task merges them into **one** `.panel`-based container with **points as the hero** and **accuracy secondary**, keeping every id `player.js` already writes (`ahPoints`, `ahMult`, `ahRampFill`, `ahStreak`, `ahStreakVal`, `ahFire`, `score-pct`) so the existing render path keeps working; we restyle and add new sub-elements next.

- [ ] **Step 1: Remove the standalone accuracy readout from the header**

In `static/player.html`, find the header line:

```html
        <div class="score-display" id="score-display" style="display:none"><span class="sd-label">Accuracy</span><span id="score-pct">0%</span></div>
```

Delete this entire line. (The `#score-pct` id moves into the unified panel below; `player.js` only sets its `textContent`, so location doesn't matter.)

- [ ] **Step 2: Replace the `.arcade-hud` block with the unified score panel**

In `static/player.html`, locate the block by its container opening tag `<div class="arcade-hud" id="arcadeHud"` and replace through its matching closing `</div>`. **Phase 1 (Task 18) may already have swapped the `#ahFire` inner text and the `#ahStreak` `&#128293;` entity for inline Lucide SVGs**, so do not match on the literal `ON FIRE` / `&#128293;` inner content — replace the whole container regardless of its current inner glyph form. The pre-Phase-1 block, for reference:

```html
    <div class="arcade-hud" id="arcadeHud" style="display:none" aria-hidden="true">
        <div class="ah-cap">Score</div>
        <div class="ah-points" id="ahPoints">0</div>
        <div class="ah-mult-row">
            <span class="ah-mult" id="ahMult">1&#215;</span>
            <div class="ah-ramp"><div class="ah-ramp-fill" id="ahRampFill"></div></div>
        </div>
        <div class="ah-streak" id="ahStreak" style="visibility:hidden">&#128293; <span id="ahStreakVal">0</span></div>
        <div class="ah-fire" id="ahFire" style="display:none">ON FIRE</div>
    </div>
```

Replace it **entirely** with:

```html
    <div class="score-panel panel" id="arcadeHud" style="display:none" aria-hidden="true">
        <div class="sp-hero">
            <div class="ah-cap">Score</div>
            <div class="ah-points" id="ahPoints">0</div>
            <div class="sp-popup" id="ahPopup"></div>
        </div>
        <div class="sp-meta">
            <div class="ah-mult-row">
                <span class="ah-mult" id="ahMult">1&#215;</span>
                <div class="ah-ramp"><div class="ah-ramp-fill" id="ahRampFill"></div></div>
            </div>
            <div class="sp-acc"><span class="sp-acc-label">Accuracy</span><span id="score-pct">0%</span></div>
        </div>
        <div class="ah-streak" id="ahStreak" style="visibility:hidden">&#128293; <span id="ahStreakVal">0</span></div>
        <div class="ah-fire" id="ahFire" style="display:none">ON FIRE</div>
        <div class="sp-milestone" id="ahMilestone"></div>
    </div>
```

What changed and why:
- The container is now a real `.panel` (1px border, token surface, `--shadow-card`) plus `.score-panel` for layout — replaces the two floating corners with one anchored container (spec §3.3 "one unified score panel … real container").
- New `#ahPopup` (the floating `+points` element), `#ahMilestone` (streak callout), and the relocated `#score-pct` accuracy readout (now secondary, under the points hero).
- All ids `player.js` writes today are preserved.

- [ ] **Step 3: Verify markup loads without breaking the player**

Run: `python app.py` then open http://localhost:5000/player and start Game Mode on a song.
Expected: the score panel appears (unstyled-ish until Task 3) but the page does not error; the points number still updates as you sing; accuracy % still updates. DevTools console clean.

- [ ] **Step 4: Run the JS + Python suites (guard)**

```bash
node tests/test_scoring_arcade.cjs
node tests/test_scoring_session.cjs
python -m pytest tests/test_app.py -q
```

Expected: all PASS (markup-only change; logic untouched).

- [ ] **Step 5: Commit**

```bash
git add static/player.html
git commit -m "feat(player): merge accuracy + arcade HUD into one unified score panel"
```

---

## Task 3: Unified score panel — styles (points hero, accuracy secondary, .panel)

**Files:**
- Modify: `static/style.css` (the relocated player CSS section — `.score-display`, `.arcade-hud`, `.ah-*` rules live here after Phase 0)

This restyles the panel onto tokens, makes points the hero and accuracy secondary, and adds the `+points` popup / milestone slots (animated in Task 4–5). No `player.js` change yet.

- [ ] **Step 1: Delete the now-dead `.score-display` rules**

In `static/style.css`, find and delete the three `.score-display*` rules (relocated from the player inline `<style>` in Phase 0):

```css
        .score-display {
            margin-left: auto;
            display: flex;
            align-items: baseline;
            gap: 7px;
            font-variant-numeric: tabular-nums;
        }
        .score-display .sd-label {
            font-size: 0.58rem; font-weight: 700; letter-spacing: .18em;
            text-transform: uppercase; color: var(--text-dim);
        }
        .score-display #score-pct { font-size: 1rem; color: var(--matched); font-weight: 700; }
```

(The header element that used them was removed in Task 2; `#score-pct` is restyled as `.sp-acc` below.)

- [ ] **Step 2: Replace the `.arcade-hud` + `.ah-*` rules with the score-panel rules**

In `static/style.css`, locate the rule by the **`.arcade-hud {` selector** (relocated from the player inline `<style>` in Phase 0). **Phase 1 (Task 18) already restyled this rule** — it added padding/background/border/box-shadow and changed `gap: 7px` to `gap: var(--space-2)` — so do **not** match on the literal `gap: 7px` or the absence of padding; replace the whole rule body regardless of its current declarations. The pre-Phase-1 rule, for reference:

```css
        /* ── Arcade floating HUD ─────────────────────────────────── */
        .arcade-hud {
            position: fixed; top: 70px; right: 18px; z-index: 90;
            display: flex; flex-direction: column; align-items: flex-end; gap: 7px;
            pointer-events: none; font-variant-numeric: tabular-nums;
        }
        .ah-cap {
            font-size: 0.62rem; font-weight: 700; letter-spacing: .24em;
            text-transform: uppercase; color: var(--text-dim); line-height: 1; margin-bottom: -3px;
        }
        .ah-points {
            font-size: 3.3rem; font-weight: 700; line-height: 1;
            color: transparent; background: linear-gradient(96deg,var(--p),var(--s));
            -webkit-background-clip: text; background-clip: text;
            filter: drop-shadow(0 0 14px rgba(45,212,238,.3));
            transition: transform .12s;
        }
        .ah-points.bump { transform: scale(1.16); }
        .ah-mult-row { display: flex; align-items: center; gap: 8px; }
        .ah-mult { font-size: 1.25rem; font-weight: 700; color: var(--s); }
        .ah-ramp { width: 96px; height: 7px; background: rgba(255,255,255,.1); border-radius: 999px; overflow: hidden; }
        .ah-ramp-fill { height: 100%; width: 0%; background: linear-gradient(90deg,var(--p),var(--s)); transition: width .2s; }
        .ah-streak { font-size: 1rem; color: var(--fire-b); font-weight: 700; }
```

Replace that **entire run** (from the `/* ── Arcade floating HUD ──… */` comment through the `.ah-streak` rule, **stopping before** `.ah-fire`) with:

```css
        /* ── Unified score panel ─────────────────────────────────────
           One anchored .panel container (replaces the two floating
           corners). Points is the hero; accuracy + multiplier secondary.
           Reads in both themes (token surface/border, no dark-only glow). */
        .score-panel {
            position: fixed; top: 64px; right: 18px; z-index: 90;
            display: flex; flex-direction: column; align-items: stretch; gap: var(--space-2);
            padding: var(--space-3) var(--space-4);
            min-width: 180px;
            pointer-events: none;
            font-variant-numeric: tabular-nums;
            font-family: var(--font-text);
            transform-origin: 100% 0;
        }
        .sp-hero { position: relative; text-align: right; }
        .ah-cap {
            font-size: var(--text-xs); font-weight: 700; letter-spacing: .24em;
            text-transform: uppercase; color: var(--text-faint); line-height: 1;
        }
        .ah-points {
            font-family: var(--font-display);
            font-size: var(--text-3xl); font-weight: 700; line-height: 1;
            letter-spacing: -.01em;
            color: transparent; background: var(--grad-accent);
            -webkit-background-clip: text; background-clip: text;
        }
        /* The bump on each clear is kept as a subtle scale via the popup spring;
           the hero number itself no longer hard-snaps (count-up in Task 4). */
        .sp-meta {
            display: flex; align-items: center; justify-content: flex-end;
            gap: var(--space-3); flex-wrap: wrap;
        }
        .ah-mult-row { display: flex; align-items: center; gap: var(--space-2); }
        .ah-mult { font-family: var(--font-display); font-size: var(--text-md); font-weight: 700; color: var(--s); }
        .ah-ramp { width: 80px; height: 6px; background: var(--surface-3); border-radius: var(--r-pill); overflow: hidden; }
        .ah-ramp-fill { height: 100%; width: 0%; background: var(--grad-accent); transition: width var(--dur-base) var(--ease-out); }
        .sp-acc { display: flex; align-items: baseline; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-dim); }
        .sp-acc-label { font-size: var(--text-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); }
        .sp-acc #score-pct { color: var(--matched); font-weight: 700; }
        .ah-streak { align-self: flex-end; font-size: var(--text-sm); color: var(--fire-b); font-weight: 700; }
```

What changed: the container is a `.panel` (Task 2 markup added the class) with token padding; the points number uses `--font-display` at `--text-3xl` as the hero; the multiplier/ramp/accuracy are demoted into a secondary meta row; all metrics use tokens (no hardcoded rgba/px), so they read in both themes. The old `.ah-points.bump` hard scale is dropped — the reward beat now comes from the popup (Task 4).

- [ ] **Step 3: Verify the panel looks like a coherent points-hero card**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode, sing a couple of lines.
Expected: a single bordered panel top-right; large gradient points number on top, a small `1× [ramp bar]` + `ACCURACY n%` row beneath, streak under that when ≥2. Toggle the theme (player has a toggle after Phase 1) → the panel reads cleanly in **light** too (border + surface visible, points gradient legible, no invisible text).

- [ ] **Step 4: Commit**

```bash
git add static/style.css
git commit -m "feat(player): style unified score panel (points hero, accuracy secondary, tokens)"
```

---

## Task 4: Floating +points popup + score count-up (wire `formatPointsGain` / `countUpValue` / `countUpDurationMs`)

**Files:**
- Modify: `static/style.css` (add `.sp-popup` animation)
- Modify: `static/player.js` (`_renderArcadeHud` — replace the hard `textContent` snap)

Today the hero number hard-snaps (`ptsEl.textContent = String(st.points)`) and only triggers a 130ms scale bump (`player.js` `_renderArcadeHud`). This task replaces the snap with a count-up animation from the previous total and floats a `+250`-style popup on each clear.

- [ ] **Step 1: Add the popup style**

In `static/style.css`, immediately after the `.ah-points { … }` rule (added in Task 3), add:

```css
        /* Floating +points reward popup (one per clear). Springs up + fades. */
        .sp-popup {
            position: absolute; top: -2px; right: 0;
            font-family: var(--font-display);
            font-size: var(--text-lg); font-weight: 700;
            color: var(--matched);
            opacity: 0; pointer-events: none;
            text-shadow: 0 0 12px rgba(45,212,238,.0);
        }
        .sp-popup.show {
            animation: spPopup var(--dur-slow) var(--ease-spring) forwards;
        }
        @keyframes spPopup {
            0%   { opacity: 0; transform: translateY(6px) scale(.9); }
            30%  { opacity: 1; transform: translateY(-10px) scale(1.05); }
            100% { opacity: 0; transform: translateY(-26px) scale(1); }
        }
        /* On-fire, the popup burns warm instead of cyan-green. */
        body.arcade-onfire .sp-popup { color: var(--fire-c); }
```

- [ ] **Step 2: Replace the points-snap block in `_renderArcadeHud` with count-up + popup**

In `static/player.js`, find the points block inside `_renderArcadeHud` (anchor on the `ahPoints` lookup):

```js
        var st = this._arcadeState;
        var ptsEl = document.getElementById('ahPoints');
        if (ptsEl) {
            ptsEl.textContent = String(st.points);
            if (evt && evt.pointsAwarded > 0) {
                ptsEl.classList.add('bump');
                setTimeout(function () { ptsEl.classList.remove('bump'); }, 130);
            }
        }
```

Replace that block with:

```js
        var st = this._arcadeState;
        var ptsEl = document.getElementById('ahPoints');
        if (ptsEl) {
            // Count-up from the previously-shown total to the new total instead of a hard
            // snap. score-feedback-helpers owns the easing + duration; player.js only drives
            // the rAF loop. prefers-reduced-motion -> snap straight to the final value.
            var from = (typeof this._shownPoints === 'number') ? this._shownPoints : 0;
            var to = st.points;
            this._shownPoints = to;
            this._animateScoreCountUp(ptsEl, from, to);

            // Floating +points popup on each clear (pointsAwarded > 0).
            if (evt && window.KaraokeeScoreFeedback) {
                var gain = KaraokeeScoreFeedback.formatPointsGain(evt.pointsAwarded);
                if (gain) {
                    var popEl = document.getElementById('ahPopup');
                    if (popEl) {
                        popEl.textContent = gain;
                        // Restart the CSS animation: remove, force reflow, re-add.
                        popEl.classList.remove('show');
                        void popEl.offsetWidth;
                        popEl.classList.add('show');
                    }
                }
            }
        }
```

- [ ] **Step 3: Add the `_animateScoreCountUp` helper method on the controller**

In `static/player.js`, add this method to the `GameMode` class, immediately **after** `_renderArcadeHud` (and before `_hideArcadeHud`). It is a thin rAF driver over `KaraokeeScoreFeedback`:

```js
    // Drive the score number from `from` to `to` using the pure count-up helper.
    // Cancels any in-flight count-up so rapid clears don't stack loops. Honors
    // prefers-reduced-motion by snapping straight to the final value.
    _animateScoreCountUp(el, from, to) {
        if (this._countUpRaf) { cancelAnimationFrame(this._countUpRaf); this._countUpRaf = null; }
        if (!window.KaraokeeScoreFeedback || from === to) { el.textContent = String(to); return; }
        var reduce = false;
        try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
        if (reduce) { el.textContent = String(to); return; }
        var dur = KaraokeeScoreFeedback.countUpDurationMs(to - from);
        var start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var self = this;
        function frame(now) {
            var t = dur > 0 ? Math.min(1, (now - start) / dur) : 1;
            el.textContent = String(KaraokeeScoreFeedback.countUpValue(from, to, t));
            if (t < 1) {
                self._countUpRaf = requestAnimationFrame(frame);
            } else {
                el.textContent = String(to);
                self._countUpRaf = null;
            }
        }
        this._countUpRaf = requestAnimationFrame(frame);
    }
```

- [ ] **Step 4: Reset `_shownPoints` / cancel the count-up on game start + stop**

So a replay starts the count-up from 0 and a stop doesn't leave a dangling rAF. In `static/player.js`, find where the arcade HUD is hidden on stop, `_hideArcadeHud`:

```js
    _hideArcadeHud() {
        var hud = document.getElementById('arcadeHud');
        if (hud) hud.style.display = 'none';
        document.body.classList.remove('arcade-onfire');
    }
```

Replace it with:

```js
    _hideArcadeHud() {
        var hud = document.getElementById('arcadeHud');
        if (hud) hud.style.display = 'none';
        document.body.classList.remove('arcade-onfire');
        if (this._countUpRaf) { cancelAnimationFrame(this._countUpRaf); this._countUpRaf = null; }
        this._shownPoints = 0;
    }
```

Then ensure `_shownPoints` is reset when a run starts. In `static/player.js`, locate the run-state reset that sets `this._endShown = false;` (the `// idempotency latch for showEndModal (reset per song)` line) and add immediately after it:

```js
        this._shownPoints = 0;       // last score value painted by the count-up (reset per song)
```

- [ ] **Step 5: Verify count-up + popup**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode, sing several lines.
Expected:
- On each cleared phrase, a `+N` (or `+1,234`) popup springs up over the score and fades.
- The hero number **counts up** to the new total instead of snapping.
- Enable OS "Reduce motion" → the number snaps (no count-up), the popup does not spring (Phase 0 global guard collapses the keyframe), but values stay correct.
- DevTools console clean.

- [ ] **Step 6: Run the suites (guard the render path)**

```bash
node tests/test_scoring_arcade.cjs
node tests/test_scoring_session.cjs
node tests/test_telemetry_helpers.cjs
```

Expected: all PASS (no scoring logic touched).

- [ ] **Step 7: Commit**

```bash
git add static/style.css static/player.js
git commit -m "feat(player): +points popup + score count-up (wire score-feedback helpers)"
```

---

## Task 5: Tier-up beat + streak milestones (wire `tierUpLabel` / `milestoneForStreak`)

**Files:**
- Modify: `static/style.css` (`.ah-mult` tier-up flash + `.sp-milestone` callout)
- Modify: `static/player.js` (`_renderArcadeHud` — read prev/new multiplier + streak)

A one-shot beat when the multiplier increases (distinct from on-fire), and a milestone callout at streaks 10/25/50 (visually distinct from on-fire — these are blue/brand, on-fire is warm).

- [ ] **Step 1: Add the tier-up flash + milestone styles**

In `static/style.css`, immediately after the `.ah-mult { … }` rule (from Task 3), add:

```css
        /* One-shot tier-up beat when the multiplier increases. */
        .ah-mult.tierup { animation: tierUp var(--dur-slow) var(--ease-spring); }
        @keyframes tierUp {
            0%   { transform: scale(1);   color: var(--s); }
            35%  { transform: scale(1.5); color: var(--p); }
            100% { transform: scale(1);   color: var(--s); }
        }
        /* Streak milestone callout (10/25/50). Brand/blue — distinct from the warm
           on-fire treatment, so a streak callout is never confused with ignition. */
        .sp-milestone {
            align-self: center;
            font-family: var(--font-display);
            font-size: var(--text-sm); font-weight: 800; letter-spacing: .14em;
            color: var(--p);
            opacity: 0; pointer-events: none;
            text-transform: uppercase;
        }
        .sp-milestone.show { animation: spMilestone 1.1s var(--ease-out) forwards; }
        @keyframes spMilestone {
            0%   { opacity: 0; transform: translateY(8px) scale(.8); }
            20%  { opacity: 1; transform: translateY(0) scale(1.1); }
            80%  { opacity: 1; transform: translateY(0) scale(1); }
            100% { opacity: 0; transform: translateY(-6px) scale(1); }
        }
```

- [ ] **Step 2: Add tier-up + milestone wiring to `_renderArcadeHud`**

In `static/player.js`, find the multiplier block inside `_renderArcadeHud`:

```js
        var multEl = document.getElementById('ahMult');
        if (multEl) multEl.textContent = st.multiplier + '×';
```

Replace it with:

```js
        var multEl = document.getElementById('ahMult');
        if (multEl) {
            // One-shot tier-up beat when the multiplier crosses up. score-feedback-helpers
            // decides if a tier-up label is warranted from prev vs new multiplier.
            var prevMult = (typeof this._shownMult === 'number') ? this._shownMult : 1;
            multEl.textContent = st.multiplier + '×';
            if (window.KaraokeeScoreFeedback) {
                var tierLabel = KaraokeeScoreFeedback.tierUpLabel(prevMult, st.multiplier);
                if (tierLabel) {
                    multEl.classList.remove('tierup');
                    void multEl.offsetWidth;   // restart the animation
                    multEl.classList.add('tierup');
                }
            }
            this._shownMult = st.multiplier;
        }

        // Streak milestone callout at 10 / 25 / 50 (distinct from on-fire).
        if (evt && window.KaraokeeScoreFeedback) {
            var msLabel = KaraokeeScoreFeedback.milestoneForStreak(evt.streak);
            if (msLabel) {
                var msEl = document.getElementById('ahMilestone');
                if (msEl) {
                    msEl.textContent = msLabel;
                    msEl.classList.remove('show');
                    void msEl.offsetWidth;
                    msEl.classList.add('show');
                }
            }
        }
```

- [ ] **Step 3: Reset `_shownMult` on game start + stop**

In `static/player.js`, in `_hideArcadeHud` (edited in Task 4), add `this._shownMult = 1;` alongside the `this._shownPoints = 0;` line:

```js
        if (this._countUpRaf) { cancelAnimationFrame(this._countUpRaf); this._countUpRaf = null; }
        this._shownPoints = 0;
        this._shownMult = 1;
```

And next to the per-song `this._shownPoints = 0;` reset added in Task 4 Step 4 (after `this._endShown = false;`), add:

```js
        this._shownMult = 1;         // last multiplier painted (drives the tier-up beat; reset per song)
```

- [ ] **Step 4: Verify tier-up + milestones**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode on an **easy** song, and clear several phrases in a row.
Expected:
- When the multiplier ticks up (1×→2×→…), the `×` number pops once (scale + brand color flash), then settles.
- At streak 10 (and 25/50 if reached), a brand-blue "10 STREAK" callout flashes in the panel, clearly different from the warm on-fire lockup.
- Misses reset the multiplier (no spurious tier-up on the reset — `tierUpLabel` only fires on an increase).
- Console clean.

- [ ] **Step 5: Commit**

```bash
git add static/style.css static/player.js
git commit -m "feat(player): tier-up beat + streak milestone callouts (wire score-feedback)"
```

---

## Task 6: Per-line PERFECT / NICE / partial verdicts (wire `lineVerdict`)

**Files:**
- Modify: `static/style.css` (`.line-score-flash` verdict variants)
- Modify: `static/player.js` (`_renderLineScored` — replace the bare `+3/4`)

Today `_renderLineScored` shows the bare fraction `'+' + e.matched + '/' + e.scoredTotal`. The spec replaces that with a worded verdict (PERFECT / NICE / partial) derived from the score ratio. `lineVerdict(score, maxScore)` returns `'perfect' | 'nice' | 'partial' | 'miss'`; the event already carries `e.matched` (score) and `e.scoredTotal` (max).

- [ ] **Step 1: Add verdict styles**

In `static/style.css`, find the `.line-score-flash` rule (relocated from the player inline `<style>`):

```css
        /* Per-line score flash */
        .line-score-flash {
            position: absolute;
            right: 24px;
            font-size: 0.85rem;
            color: var(--matched);
            font-weight: 700;
            pointer-events: none;
            animation: fadeOut 1.2s ease forwards;
        }
```

Replace it with:

```css
        /* Per-line verdict flash (PERFECT / NICE / partial). Worded, not a bare fraction. */
        .line-score-flash {
            position: absolute;
            right: var(--space-5);
            font-family: var(--font-display);
            font-size: var(--text-sm);
            font-weight: 800;
            letter-spacing: .1em;
            text-transform: uppercase;
            color: var(--matched);
            pointer-events: none;
            animation: fadeOut 1.2s ease forwards;
        }
        .line-score-flash.v-perfect { color: var(--matched); }
        .line-score-flash.v-nice    { color: var(--p); }
        .line-score-flash.v-partial { color: var(--partial); }
```

(`miss` lines never reach this flash today — `_renderLineScored` only paints on a scored line — but the helper returning `'miss'` is handled defensively in Step 2.)

- [ ] **Step 2: Replace the fraction text in `_renderLineScored`**

In `static/player.js`, find the flash-building block inside `_renderLineScored`:

```js
            // Flash per-line score
            var flash = document.createElement('div');
            flash.className = 'line-score-flash';
            flash.textContent = '+' + e.matched + '/' + e.scoredTotal;
            flash.style.top = lineEl.offsetTop + 'px';
            document.getElementById('lyrics-container').appendChild(flash);
            setTimeout(function () { flash.remove(); }, 1300);
```

Replace it with:

```js
            // Flash a worded per-line verdict (PERFECT / NICE / partial) instead of the
            // bare +matched/total fraction. score-feedback-helpers maps the ratio to a
            // verdict; player.js only paints the label + class.
            var flash = document.createElement('div');
            flash.className = 'line-score-flash';
            var verdict = window.KaraokeeScoreFeedback
                ? KaraokeeScoreFeedback.lineVerdict(e.matched, e.scoredTotal)
                : 'partial';
            var verdictLabel = { perfect: 'PERFECT', nice: 'NICE', partial: 'partial', miss: 'miss' };
            flash.textContent = verdictLabel[verdict] || 'partial';
            flash.classList.add('v-' + verdict);
            flash.style.top = lineEl.offsetTop + 'px';
            document.getElementById('lyrics-container').appendChild(flash);
            setTimeout(function () { flash.remove(); }, 1300);
```

- [ ] **Step 3: Verify verdicts**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode, sing.
Expected: each scored line flashes a worded verdict — "PERFECT" (green) when you nail it, "NICE" (brand blue) for a strong-but-not-full line, "partial" (amber) for a weak line — replacing the old `+3/4`. Colors read in both themes.

- [ ] **Step 4: Commit**

```bash
git add static/style.css static/player.js
git commit -m "feat(player): per-line PERFECT/NICE/partial verdicts (wire lineVerdict)"
```

---

## Task 7: Capture the word-onset beat anchor (feed `beatPhase`)

**Files:**
- Modify: `static/player.js` (`_renderEvents` `wordMatched` case — record the live onset)

The beat pulse (Task 8) anchors its phase to a real sung word onset so it "reads locked" without Web Audio. Each `wordMatched` render event corresponds to a word sung at the current clock; record that instant in **milliseconds**. This task only captures the anchor (no visual yet), keeping the change isolated and reviewable.

- [ ] **Step 1: Record the onset on each `wordMatched`**

In `static/player.js`, find the `wordMatched` case in `_renderEvents`:

```js
                case 'wordMatched': this._logMatch(e.spokenWord, e.targetWord, e.method, e.editDistance, e.phoneticMatch, e.score, e.matched, e.windowPosition); break;
```

Replace it with:

```js
                case 'wordMatched':
                    // Capture this sung word's onset (live clock, ms) as the beat anchor for
                    // the on-fire pulse (beatPhase). Render-only; does not touch scoring.
                    this._lastOnsetMs = this._now() * 1000;
                    this._logMatch(e.spokenWord, e.targetWord, e.method, e.editDistance, e.phoneticMatch, e.score, e.matched, e.windowPosition);
                    break;
```

- [ ] **Step 2: Initialize `_lastOnsetMs` on game start**

In `static/player.js`, next to the per-song reset added in Task 4/5 (after `this._endShown = false;`), add:

```js
        this._lastOnsetMs = 0;       // last sung-word onset (ms) — beat anchor for on-fire pulse (reset per song)
```

- [ ] **Step 3: Verify the anchor updates (console probe)**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode, sing a few words.
In DevTools console:

```js
gameMode._lastOnsetMs
```

Expected: a positive, increasing number while you sing (it tracks the live clock at each matched word). `0` before any match. No errors.

- [ ] **Step 4: Run the suites (guard)**

```bash
node tests/test_scoring_session.cjs
node tests/test_scoring_arcade.cjs
```

Expected: PASS (render-only; no scoring change).

- [ ] **Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat(player): capture sung-word onset as the on-fire beat anchor"
```

---

## Task 8: The C beat-synced on-fire — markup + styles (vivid, both themes, embers + floor-glow + lockup)

**Files:**
- Modify: `static/player.html` (replace the bare `ON FIRE` element with the lockup + embers + floor-glow)
- Modify: `static/style.css` (on-fire treatment driven by a `--beat` custom property; lyrics held steady)

This builds the **visual** on-fire treatment. Task 9 drives its pulse via the helper-computed phase. The treatment is the approved "C": a bold "ON FIRE" lockup, warm gradient active lyric, embers, and a warm floor-glow — all leaning on border/shape/gradient/embers (not a dark-only glow) so it reads on a white stage too. The pulse intensity is driven by a `--beat` (0..1) custom property set on `<body>` in Task 9; static here.

- [ ] **Step 1: Replace the bare `ahFire` element with the on-fire lockup + embers**

In `static/player.html`, find the on-fire element inside the score panel (added in Task 2):

```html
        <div class="ah-fire" id="ahFire" style="display:none">ON FIRE</div>
```

Replace it with:

```html
        <div class="ah-fire" id="ahFire" style="display:none">
            <span class="ah-fire-flames" aria-hidden="true">
                <span class="ember"></span><span class="ember"></span><span class="ember"></span>
                <span class="ember"></span><span class="ember"></span>
            </span>
            <span class="ah-fire-label">ON FIRE</span>
        </div>
```

Then, immediately **after** the closing `</div>` of the score panel (`id="arcadeHud"`), add the floor-glow element (a fixed full-width warm wash at the bottom of the stage, shown only on-fire):

```html
    <div class="onfire-floor" id="onFireFloor" aria-hidden="true"></div>
```

- [ ] **Step 2: Replace the on-fire CSS with the C beat-synced treatment**

In `static/style.css`, find the current on-fire rules (relocated from the player inline `<style>`), starting at `.ah-fire` and running through the `body.arcade-onfire #lyrics-container::after` rule:

```css
        .ah-fire {
            font-size: 0.8rem; font-weight: 800; letter-spacing: .18em;
            color: #fff; background: linear-gradient(95deg,var(--fire-a),var(--fire-b));
            padding: 3px 12px; border-radius: 8px; box-shadow: 0 0 18px rgba(255,84,112,.5);
            animation: firePulse 0.7s ease-in-out infinite alternate;
        }
        @keyframes firePulse { from { box-shadow: 0 0 10px rgba(255,84,112,.5); } to { box-shadow: 0 0 22px rgba(255,159,69,.85); } }

        /* On Fire — bold active-line treatment; lyrics stay readable. */
        body.arcade-onfire .lyric-line.active {
            background: linear-gradient(90deg,var(--fire-a),var(--fire-b),#ffd24a);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
            text-shadow: 0 0 18px rgba(255,152,0,.4);
        }
        /* In Game Mode the active line is per-word spans; keep each word's OWN colour
           (key-word cyan, matched green, partial amber, missed red) during ON FIRE rather
           than letting the line's gradient fill mask them — so the scoring stays readable
           on a streak. A warm glow keeps the fire energy; the key-word cue's own cyan glow
           still wins via specificity, so key words stay distinct. */
        body.arcade-onfire .lyric-line.active .word-span {
            -webkit-text-fill-color: currentColor;
            text-shadow: 0 0 14px rgba(255,120,40,.45);
        }
        body.arcade-onfire #lyrics-container::after {
            content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 1;
            box-shadow: inset 0 -120px 120px -90px rgba(255,106,0,.6), inset 0 120px 120px -90px rgba(255,106,0,.38);
        }
```

Replace that **entire run** with:

```css
        /* ── On Fire ("C", beat-synced) ───────────────────────────────
           Event-driven ignition -> sustained pulse driven by --beat (0..1,
           set on <body> from the helper-computed phase in player.js) -> fade.
           Leans on border/shape/gradient/embers/motion (NOT a dark-only glow)
           so it reads in both themes. Lyrics are held steady for readability. */

        /* The bold "ON FIRE" lockup. Border + gradient fill carry it on white. */
        .ah-fire {
            position: relative;
            display: inline-flex; align-items: center; gap: var(--space-1);
            align-self: flex-end;
            font-family: var(--font-display);
            font-size: var(--text-sm); font-weight: 800; letter-spacing: .2em;
            color: #fff;
            background: linear-gradient(95deg, var(--fire-a), var(--fire-b), var(--fire-c));
            border: 1px solid var(--fire-c);
            padding: var(--space-1) var(--space-3);
            border-radius: var(--r-pill);
            /* Pulse the warm glow with the beat. --beat is 0 at rest. */
            box-shadow: 0 0 calc(8px + 18px * var(--beat, 0)) rgba(255,140,40, calc(.35 + .5 * var(--beat, 0)));
        }
        .ah-fire-label { line-height: 1; }
        .ah-fire-flames { position: relative; display: inline-flex; width: 14px; height: 14px; }
        .ah-fire-flames .ember {
            position: absolute; bottom: 0; width: 3px; height: 3px; border-radius: 50%;
            background: var(--fire-c);
            opacity: calc(.4 + .6 * var(--beat, 0));
            animation: ember 1.1s ease-in infinite;
        }
        .ah-fire-flames .ember:nth-child(1) { left: 0;  animation-delay: 0s; }
        .ah-fire-flames .ember:nth-child(2) { left: 4px; animation-delay: .18s; }
        .ah-fire-flames .ember:nth-child(3) { left: 8px; animation-delay: .36s; }
        .ah-fire-flames .ember:nth-child(4) { left: 11px; animation-delay: .52s; }
        .ah-fire-flames .ember:nth-child(5) { left: 2px; animation-delay: .7s; }
        @keyframes ember {
            0%   { transform: translateY(0)    scale(1);  opacity: .9; }
            100% { transform: translateY(-12px) scale(.3); opacity: 0; }
        }

        /* The score panel itself breathes a hair with the beat when on-fire. */
        body.arcade-onfire .score-panel {
            border-color: var(--fire-c);
            transform: scale(calc(1 + .015 * var(--beat, 0)));
        }
        body.arcade-onfire .ah-points { background: linear-gradient(95deg, var(--fire-a), var(--fire-b), var(--fire-c)); -webkit-background-clip: text; background-clip: text; }

        /* On Fire — bold active lyric (held STEADY; pulse never moves the text). */
        body.arcade-onfire .lyric-line.active {
            background: linear-gradient(90deg, var(--fire-a), var(--fire-b), var(--fire-c));
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
            text-shadow: 0 0 18px rgba(255,152,0,.35);
        }
        /* In Game Mode the active line is per-word spans; keep each word's OWN colour
           (key-word cyan, matched green, partial amber, missed red) during ON FIRE so the
           scoring stays readable on a streak. A warm glow keeps the fire energy. */
        body.arcade-onfire .lyric-line.active .word-span {
            -webkit-text-fill-color: currentColor;
            text-shadow: 0 0 14px rgba(255,120,40,.45);
        }

        /* Warm floor-glow at the bottom of the stage — pulses with --beat. Hidden
           until on-fire. Works on white because it is an additive warm wash, not a
           dark vignette. */
        .onfire-floor {
            position: fixed; left: 0; right: 0; bottom: 0; height: 220px;
            pointer-events: none; z-index: 1; opacity: 0;
            background: radial-gradient(120% 140% at 50% 140%,
                rgba(255,106,0, calc(.45 + .35 * var(--beat, 0))) 0%,
                rgba(255,160,40,.18) 38%, transparent 70%);
            transition: opacity var(--dur-slow) var(--ease-out);
        }
        body.arcade-onfire .onfire-floor { opacity: 1; }
```

Notes:
- `--beat` defaults to `0` (`var(--beat, 0)`), so a static render (no JS) shows a calm, vivid-but-unpulsing on-fire — which is exactly the `prefers-reduced-motion` target. The pulse comes from Task 9 writing `--beat` each frame.
- The ember keyframe animation is collapsed to instant by the Phase 0 global `prefers-reduced-motion` guard, so embers freeze when reduced-motion is on (vivid-but-static), per spec.

- [ ] **Step 3: Verify the static on-fire look in both themes**

Run: `python app.py` then open http://localhost:5000/player. To force the state for a visual check without a long streak, in DevTools console:

```js
document.body.classList.add('arcade-onfire');
document.getElementById('ahFire').style.display = 'inline-flex';
```

Expected: the "ON FIRE" lockup (warm gradient pill + bordered + embers), the score panel border turns warm, the active lyric burns warm, and a warm floor-glow rises from the bottom. Toggle the theme → it still reads on the **white** stage (border + gradient + floor wash visible; no reliance on a dark backdrop). Then:

```js
document.body.classList.remove('arcade-onfire');
document.getElementById('ahFire').style.display = 'none';
```

Expected: the stage returns to normal.

- [ ] **Step 4: Commit**

```bash
git add static/player.html static/style.css
git commit -m "feat(player): C beat-synced on-fire treatment (lockup, embers, floor-glow, both themes)"
```

---

## Task 9: Drive the on-fire pulse from the beat helper (wire `pulsePeriodMs` + `beatPhase`)

**Files:**
- Modify: `static/player.js` (`_renderArcadeHud` — show/hide fire + start/stop the pulse loop; a new `_onFirePulseFrame`)

This is the motion driver: when `evt.onFire` flips on, start a rAF loop that, each frame, computes the beat phase from `pulsePeriodMs(tempoClass)` + `beatPhase(now, period, anchor)` and writes a `--beat` (0..1) custom property on `<body>`. On exit, stop the loop and fade out. Reduced-motion holds `--beat` at a static value (no loop), so the vivid look stays but doesn't pulse.

- [ ] **Step 1: Replace the fire show/hide block in `_renderArcadeHud`**

In `static/player.js`, find the fire block at the end of `_renderArcadeHud`:

```js
        var fire = document.getElementById('ahFire');
        if (fire) fire.style.display = st.onFire ? 'block' : 'none';
        document.body.classList.toggle('arcade-onfire', !!st.onFire);
```

Replace it with:

```js
        var fire = document.getElementById('ahFire');
        if (fire) fire.style.display = st.onFire ? 'inline-flex' : 'none';
        var wasOnFire = document.body.classList.contains('arcade-onfire');
        document.body.classList.toggle('arcade-onfire', !!st.onFire);
        if (st.onFire && !wasOnFire) this._startOnFirePulse();
        else if (!st.onFire && wasOnFire) this._stopOnFirePulse();
```

- [ ] **Step 2: Add `_startOnFirePulse` / `_onFirePulseFrame` / `_stopOnFirePulse` to the controller**

In `static/player.js`, add these three methods to the `GameMode` class, immediately **after** `_renderArcadeHud` (alongside `_animateScoreCountUp` from Task 4). They wire `KaraokeeBeatPulse`; they do not reimplement its math.

```js
    // Begin the on-fire pulse loop: each frame, write a --beat (0..1) custom property on
    // <body> from the helper-computed beat phase, anchored to the last sung-word onset.
    // Reduced-motion -> hold a static vivid --beat (no loop), per spec.
    _startOnFirePulse() {
        var body = document.body;
        var reduce = false;
        try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
        if (reduce || !window.KaraokeeBeatPulse) {
            body.style.setProperty('--beat', '0.6');   // vivid-but-static
            return;
        }
        if (this._onFireRaf) return;   // already running
        var self = this;
        this._onFireRaf = requestAnimationFrame(function step(now) {
            self._onFirePulseFrame(now);
            self._onFireRaf = requestAnimationFrame(step);
        });
    }

    // One pulse frame: 0..1 triangle wave over the beat period so the glow swells and
    // recedes once per beat. Period from the active line's tempo class; phase anchored to
    // the last sung-word onset (captured in _renderEvents). Pure helpers do the math.
    _onFirePulseFrame(nowMs) {
        if (!window.KaraokeeBeatPulse) return;
        var tempoClass = 'normal';
        if (this.allWordTimings && this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
            tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'normal';
        }
        var period = KaraokeeBeatPulse.pulsePeriodMs(tempoClass);
        var phase = KaraokeeBeatPulse.beatPhase(nowMs, period, this._lastOnsetMs || 0);
        // Triangle wave: 0 -> 1 -> 0 across the beat, so the glow breathes symmetrically.
        var beat = phase < 0.5 ? (phase * 2) : (2 - phase * 2);
        document.body.style.setProperty('--beat', beat.toFixed(3));
    }

    // Stop the pulse loop and relax --beat to 0 (the CSS transition fades the glow out).
    _stopOnFirePulse() {
        if (this._onFireRaf) { cancelAnimationFrame(this._onFireRaf); this._onFireRaf = null; }
        document.body.style.setProperty('--beat', '0');
    }
```

- [ ] **Step 3: Stop the pulse on HUD hide (stop / song-end / replay)**

In `static/player.js`, in `_hideArcadeHud` (edited in Tasks 4–5), add a `_stopOnFirePulse()` call so the loop never leaks past the run:

```js
    _hideArcadeHud() {
        var hud = document.getElementById('arcadeHud');
        if (hud) hud.style.display = 'none';
        document.body.classList.remove('arcade-onfire');
        this._stopOnFirePulse();
        if (this._countUpRaf) { cancelAnimationFrame(this._countUpRaf); this._countUpRaf = null; }
        this._shownPoints = 0;
        this._shownMult = 1;
    }
```

- [ ] **Step 4: Verify the pulse reads beat-locked + reduced-motion holds steady**

Run: `python app.py` then open http://localhost:5000/player, start Game Mode on a song, and build a streak to max multiplier (on **easy** this is fastest) to trigger on-fire.
Expected:
- On ignition the on-fire treatment appears and the warm glow + floor-glow + score panel **pulse** at a steady rate that visually tracks the song's pace (faster songs pulse quicker).
- Watch `getComputedStyle(document.body).getPropertyValue('--beat')` in console — it oscillates 0↔~1.
- Misses (dropping out of max multiplier) end on-fire; `--beat` relaxes to `0`, glow fades.
- Enable OS "Reduce motion", trigger on-fire again → the vivid look holds **steady** (`--beat` pinned to `0.6`, no oscillation, embers frozen by the Phase 0 guard).
- Console clean; no rAF left running after the song ends (`gameMode._onFireRaf` is `null`).

- [ ] **Step 5: Run the suites (guard)**

```bash
node tests/test_scoring_arcade.cjs
node tests/test_scoring_session.cjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add static/player.js
git commit -m "feat(player): drive on-fire pulse from beat-pulse helper (rate-matched, onset-anchored)"
```

---

## Task 10: On-brand share-card rebuild (`share-card.js` brand line + `_downloadShareImage` canvas)

**Files:**
- Modify: `tests/test_share_card.cjs` (add a wordmark/grade/stat/song golden, if not already covered)
- Modify: `static/share-card.js` (keep brand `AUDIOPIAN`; the line-building stays pure + test-covered)
- Modify: `static/player.js` (`_downloadShareImage` — on-brand canvas, Space Grotesk, brand gradient, `audiopian-score.png`)

`buildShareCardLines` already returns `{brand:'AUDIOPIAN', grade, stat, song}` — the pure part is correct. The redesign rebuilds the **canvas draw**: app backdrop, Space Grotesk for the display numbers, a real cyan→magenta accent (not the stray `#8b5cf6`), wordmark, and the corrected `audiopian-score.png` filename (the cleanup item from spec §3.6).

- [ ] **Step 1 (TDD): Confirm/extend the share-card golden test**

Read `tests/test_share_card.cjs`. It must assert the four returned lines for a representative summary. If it does not already assert `brand === 'AUDIOPIAN'` and a `DIFF · pts · %` stat, add a case. Append (or confirm present) in `tests/test_share_card.cjs`:

```js
// Brand + on-card lines (Phase 2 share-card rebuild — pure lines unchanged, asserted explicitly).
var L = buildShareCardLines(
    { grade: 'A', points: 1250, percent: 82, difficulty: 'hard' },
    { artist: 'Queen', title: 'Bohemian Rhapsody' }
);
assert.strictEqual(L.brand, 'AUDIOPIAN', 'brand is AUDIOPIAN');
assert.strictEqual(L.grade, 'A', 'grade passthrough');
assert.strictEqual(L.stat, 'HARD · 1250 pts · 82%', 'DIFF · pts · % stat');
assert.strictEqual(L.song, 'Queen — Bohemian Rhapsody', 'artist — title');
```

(If the file already has an identical assertion, skip — do not duplicate.)

- [ ] **Step 2: Run the share-card test (expected PASS — pure logic is unchanged)**

Run: `node tests/test_share_card.cjs`
Expected: PASS — `All share-card tests passed.` (We are not changing `share-card.js` logic; this locks the contract before the canvas rebuild.)

- [ ] **Step 3: Rebuild the canvas draw in `_downloadShareImage`**

In `static/player.js`, locate the `_downloadShareImage(summary) {` method **by its function name** — Phase 1 already renamed its download to `audiopian-score.png`, so do **not** search for `karaokee-score.png` (it no longer exists by the time Phase 2 runs). Replace the **entire** method (the block below shows its post-Phase-1 state):

```js
    _downloadShareImage(summary) {
        if (typeof buildShareCardLines !== 'function' || typeof document === 'undefined') return;
        var sd = (typeof songData !== 'undefined' && songData) ? songData : {};
        var L = buildShareCardLines(summary, sd);
        var c = document.createElement('canvas');
        c.width = 1080; c.height = 1080;
        var x = c.getContext('2d');
        if (!x) return;
        x.fillStyle = '#0b0b12'; x.fillRect(0, 0, 1080, 1080);
        x.textAlign = 'center';
        x.fillStyle = '#8b5cf6'; x.font = 'bold 64px sans-serif';  x.fillText(L.brand, 540, 170);
        x.fillStyle = '#ffffff'; x.font = 'bold 320px sans-serif'; x.fillText(L.grade, 540, 620);
        x.fillStyle = '#e5e7eb'; x.font = '52px sans-serif';       x.fillText(L.stat, 540, 770);
        x.fillStyle = '#9ca3af'; x.font = '40px sans-serif';       x.fillText(L.song, 540, 860);
        var a = document.createElement('a');
        a.href = c.toDataURL('image/png');
        a.download = 'audiopian-score.png';
        document.body.appendChild(a); a.click(); a.remove();
    }
```

with the on-brand version:

```js
    // Render the final grade/score/song to a 1080x1080 PNG on the app's brand and download
    // it. Pure line-building (truncation, DIFF · pts · % stat) stays in share-card.js
    // (buildShareCardLines); this method only draws + triggers the download. On-brand:
    // app backdrop, Space Grotesk display face, real cyan->magenta accent, wordmark,
    // audiopian-score.png filename.
    _downloadShareImage(summary) {
        if (typeof buildShareCardLines !== 'function' || typeof document === 'undefined') return;
        var sd = (typeof songData !== 'undefined' && songData) ? songData : {};
        var L = buildShareCardLines(summary, sd);
        var c = document.createElement('canvas');
        c.width = 1080; c.height = 1080;
        var x = c.getContext('2d');
        if (!x) return;

        // Brand display face. Falls back gracefully if Space Grotesk isn't decoded yet.
        var DISPLAY = "700 {px}px 'Space Grotesk', 'Segoe UI', sans-serif";
        var TEXT = "{px}px 'Inter', 'Segoe UI', sans-serif";
        function fDisplay(px) { return DISPLAY.replace('{px}', px); }
        function fText(px) { return TEXT.replace('{px}', px); }

        // App backdrop: deep base + the brand wash (cyan/magenta radials), matching the stage.
        x.fillStyle = '#0b0b12'; x.fillRect(0, 0, 1080, 1080);
        var g1 = x.createRadialGradient(1080, 0, 0, 1080, 0, 900);
        g1.addColorStop(0, 'rgba(240,70,143,0.16)'); g1.addColorStop(1, 'rgba(240,70,143,0)');
        x.fillStyle = g1; x.fillRect(0, 0, 1080, 1080);
        var g2 = x.createRadialGradient(0, 1080, 0, 0, 1080, 900);
        g2.addColorStop(0, 'rgba(45,212,238,0.14)'); g2.addColorStop(1, 'rgba(45,212,238,0)');
        x.fillStyle = g2; x.fillRect(0, 0, 1080, 1080);

        x.textAlign = 'center';

        // Wordmark — brand cyan->magenta gradient text.
        var brandGrad = x.createLinearGradient(380, 0, 700, 0);
        brandGrad.addColorStop(0, '#2dd4ee'); brandGrad.addColorStop(1, '#f0468f');
        x.fillStyle = brandGrad; x.font = fDisplay(60); x.fillText(L.brand, 540, 180);

        // Grade — huge brand-gradient letter (the hero).
        var gradeGrad = x.createLinearGradient(360, 360, 720, 720);
        gradeGrad.addColorStop(0, '#2dd4ee'); gradeGrad.addColorStop(0.6, '#f0468f'); gradeGrad.addColorStop(1, '#3ddc84');
        x.fillStyle = gradeGrad; x.font = fDisplay(320); x.fillText(L.grade, 540, 640);

        // Stat (DIFF · pts · %) and song.
        x.fillStyle = '#e5e7eb'; x.font = fDisplay(54); x.fillText(L.stat, 540, 790);
        x.fillStyle = '#9ca3af'; x.font = fText(40);    x.fillText(L.song, 540, 880);

        var a = document.createElement('a');
        a.href = c.toDataURL('image/png');
        a.download = 'audiopian-score.png';
        document.body.appendChild(a); a.click(); a.remove();
    }
```

(Note: this method uses plain single-quoted strings + `.replace`, not backtick template literals, to stay safe on Windows. If you prefer template literals, edit with the Edit/Write tool — never a shell heredoc.)

- [ ] **Step 4: Ensure Space Grotesk is available to the canvas**

The player `<head>` already loads Space Grotesk (`fonts.googleapis.com/css2?family=Space+Grotesk…`). Canvas `fillText` uses a font only if it's already decoded; the first share after page load may fall back. To make the brand face reliable, in `static/player.js` `_downloadShareImage`, **before** the `var c = document.createElement('canvas')` line, add a best-effort font preload (no-op where `document.fonts` is unavailable):

```js
        // Best-effort: ensure the display face is decoded before drawing to canvas.
        try { if (document.fonts && document.fonts.load) { document.fonts.load("700 64px 'Space Grotesk'"); } } catch (e) {}
```

(This is fire-and-forget — if the font isn't ready the canvas falls back to Segoe UI/sans-serif, which is acceptable; a second click renders branded.)

- [ ] **Step 5: Verify the share image**

Run: `python app.py` then open http://localhost:5000/player, finish a Game Mode run, click **Share image** on the end screen.
Expected: a downloaded **`audiopian-score.png`** with: the brand wash backdrop, a cyan→magenta "AUDIOPIAN" wordmark, a huge brand-gradient grade letter, the `DIFF · pts · %` stat, and the song line. Filename is `audiopian-score.png` (not `karaokee-score.png`).

- [ ] **Step 6: Run the share-card test again (guard)**

Run: `node tests/test_share_card.cjs`
Expected: PASS (pure logic untouched).

- [ ] **Step 7: Commit**

```bash
git add static/share-card.js tests/test_share_card.cjs static/player.js
git commit -m "feat(share): on-brand share-card rebuild (Space Grotesk, brand gradient, audiopian-score.png)"
```

---

## Task 11: Results staged entrance — styles (overlay fade → card → grade pop → NEW BEST)

**Files:**
- Modify: `static/style.css` (the `.game-modal`, `.game-modal-box`, `.grade-*`, `.nb-ribbon` rules — relocated player CSS) + new staged-entrance keyframes
- Modify: `static/player.html` (drop the dead `.game-modal-title/-score/-stats` only if still present; reconcile NEW BEST ribbon idiom)

The end screen currently hard-flips `display:flex`. This task adds a CSS-driven staged entrance keyed off a `data-stage` attribute that `player.js` advances (Task 12): overlay fade → card scale-in → grade pop → points count-up → NEW BEST settle. It also reskins the grade hero onto the Geist scorecard look and replaces the rotated neon NEW BEST sticker with a clean ribbon (spec §3.3).

- [ ] **Step 1: Replace the modal + grade-hero + ribbon styles**

In `static/style.css`, find the block from `/* End-of-song modal */` through the `.game-modal-actions` rule (relocated from the player inline `<style>`). It includes `.game-modal`, `.game-modal-box`, the dead `.game-modal-title/-score/-stats`, the `.grade-*` rules, and `.nb-ribbon`. Replace the **whole run** with:

```css
        /* ── End-of-song results (staged entrance) ───────────────────
           Stages are driven by [data-stage] on .game-modal, advanced by
           player.js. prefers-reduced-motion collapses the timings (Phase 0
           global guard) so the screen still appears, just without motion. */
        .game-modal {
            position: fixed; inset: 0;
            background: rgba(5,6,12,0.8);
            backdrop-filter: blur(6px);
            display: flex; align-items: center; justify-content: center;
            z-index: 100;
            opacity: 0;
            transition: opacity var(--dur-slow) var(--ease-out);
        }
        :root[data-theme="light"] .game-modal { background: rgba(255,255,255,0.7); }
        .game-modal[data-stage] { opacity: 1; }

        .game-modal-box {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--r-lg);
            padding: var(--space-8);
            text-align: center;
            min-width: 320px;
            box-shadow: var(--shadow-modal);
            transform: scale(.92); opacity: 0;
            transition: transform var(--dur-slow) var(--ease-spring), opacity var(--dur-slow) var(--ease-out);
        }
        .game-modal[data-stage="card"] .game-modal-box,
        .game-modal[data-stage="grade"] .game-modal-box,
        .game-modal[data-stage="points"] .game-modal-box,
        .game-modal[data-stage="best"] .game-modal-box,
        .game-modal[data-stage="done"] .game-modal-box {
            transform: scale(1); opacity: 1;
        }

        /* ── Grade-hero scorecard ─────────────────────────────────── */
        .grade-hero { position: relative; margin-bottom: var(--space-5); }
        .grade-letter {
            font-family: var(--font-display);
            font-size: 5rem; font-weight: 700; line-height: 1; letter-spacing: -.02em;
            background: linear-gradient(135deg, var(--p), var(--s) 60%, var(--matched));
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent; color: transparent;
            transform: scale(.6); opacity: 0;
            transition: transform var(--dur-slow) var(--ease-spring), opacity var(--dur-base) var(--ease-out);
        }
        .game-modal[data-stage="grade"] .grade-letter,
        .game-modal[data-stage="points"] .grade-letter,
        .game-modal[data-stage="best"] .grade-letter,
        .game-modal[data-stage="done"] .grade-letter { transform: scale(1); opacity: 1; }

        .grade-points {
            font-family: var(--font-display);
            font-size: var(--text-xl); font-weight: 800; color: var(--matched);
            margin-top: var(--space-1); font-variant-numeric: tabular-nums;
        }
        /* Tabular 2-col stat grid (Geist scorecard). */
        .grade-stats {
            display: grid; grid-template-columns: auto auto; gap: 4px var(--space-5);
            justify-content: center; text-align: left;
            color: var(--text-dim); font-size: var(--text-sm); margin-top: var(--space-4);
        }
        .grade-stats > div { display: contents; }
        .grade-stats span { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }

        /* NEW BEST — clean ribbon (drops the rotated neon-sticker idiom). */
        .nb-ribbon {
            position: absolute; top: -14px; left: 50%; transform: translateX(-50%) translateY(-6px);
            background: var(--grad-accent); color: #04121a;
            font-family: var(--font-display);
            font-weight: 800; font-size: var(--text-xs); letter-spacing: .14em;
            padding: var(--space-1) var(--space-3); border-radius: var(--r-pill);
            opacity: 0;
            transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-spring);
        }
        .game-modal[data-stage="best"] .nb-ribbon[data-best="1"],
        .game-modal[data-stage="done"] .nb-ribbon[data-best="1"] {
            opacity: 1; transform: translateX(-50%) translateY(0);
        }

        .game-modal-actions { display: flex; gap: var(--space-3); justify-content: center; margin-top: var(--space-5); }
```

What changed: the dead `.game-modal-title/-score/-stats` rules are gone (cleanup §3.6); the modal/box/grade/ribbon get token-driven transitions keyed to `[data-stage]`; the stat block is a tabular 2-col grid; NEW BEST is a centered ribbon using the brand gradient (no rotation / neon sticker).

- [ ] **Step 2: Tag the NEW BEST ribbon so the stage selector can target it**

In `static/player.html`, find the ribbon in the grade hero:

```html
                <div class="nb-ribbon" id="nbRibbon" style="display:none">NEW BEST</div>
```

Replace it with (drop the inline `display:none`; the stage CSS controls visibility, and `player.js` sets `data-best`):

```html
                <div class="nb-ribbon" id="nbRibbon" data-best="0">NEW BEST</div>
```

- [ ] **Step 3: Confirm the dead modal-title/score/stats markup is absent**

Run: `grep -n "game-modal-title\|game-modal-score\|game-modal-stats" static/player.html`
Expected: **no output** (these were CSS-only; the markup uses `.grade-*`). If any appear, they're stale — leave the markup task to Phase 1's dead-UI cleanup and only ensure the CSS rules are removed here (Step 1 already removed them).

- [ ] **Step 4: Verify the scorecard styling (static, before the JS staging)**

Run: `python app.py`, finish a run to open the end screen. (Staging is wired in Task 12; for now the modal may appear without the staged reveal — that's expected.) Force-check the look in DevTools:

```js
document.getElementById('gameModal').setAttribute('data-stage','done');
```

Expected: the scorecard reads cleanly — gradient grade letter, points, a tidy 2-col stat grid, a centered NEW BEST ribbon when `data-best="1"`. Toggle theme → reads in light too (the overlay uses the light scrim).

- [ ] **Step 5: Commit**

```bash
git add static/style.css static/player.html
git commit -m "feat(results): Geist scorecard + staged-entrance styles + clean NEW BEST ribbon"
```

---

## Task 12: Results staged entrance — sequencing in `showEndModal`

**Files:**
- Modify: `static/player.js` (`showEndModal` — advance `data-stage`; count-up the grade points; set `data-best`)

This drives the staged entrance: set `data-stage` through `overlay → card → grade → points → best → done` on a timeline, count up the grade points using the same `countUpValue` helper, and reveal NEW BEST last. Reduced-motion collapses the timeline (the Phase 0 CSS guard makes each transition instant; we still set the final stage).

- [ ] **Step 1: Replace the hero-reveal + final `display:flex` tail of `showEndModal`**

In `static/player.js`, find the tail of `showEndModal` from where it sets the grade fields through the final modal show. The relevant region is the `if (useArcade) { … }` body that ends with `if (hero) hero.style.display = 'block';`, followed by the `else { … }` and the final `document.getElementById('gameModal').style.display = 'flex';`.

Inside the `if (useArcade)` block, find the grade-field writes (anchor on `gradePoints`):

```js
            document.getElementById('gradeLetter').textContent = grade;
            document.getElementById('gradePoints').textContent = String(summary.points);
            document.getElementById('gradeAcc').textContent = pct + '%';
```

Replace `document.getElementById('gradePoints').textContent = String(summary.points);` with a deferred count-up driven in the staging timeline (set to 0 now; the timeline animates it):

```js
            document.getElementById('gradeLetter').textContent = grade;
            document.getElementById('gradePoints').textContent = '0';
            document.getElementById('gradeAcc').textContent = pct + '%';
```

Then find the NEW BEST ribbon write in the same block:

```js
            document.getElementById('nbRibbon').style.display = isBest ? 'block' : 'none';
```

Replace it with (drive the staged ribbon via `data-best`, not `display`):

```js
            document.getElementById('nbRibbon').setAttribute('data-best', isBest ? '1' : '0');
```

- [ ] **Step 2: Replace the final modal-show line with the staged timeline**

In `static/player.js`, find the final line of `showEndModal`:

```js
        document.getElementById('gameModal').style.display = 'flex';
    }
```

Replace it with:

```js
        var modal = document.getElementById('gameModal');
        modal.style.display = 'flex';
        this._runResultsEntrance(modal, useArcade ? summary.points : 0);
    }
```

- [ ] **Step 3: Add the `_runResultsEntrance` method**

In `static/player.js`, add this method to the `GameMode` class, immediately **after** `showEndModal`:

```js
    // Drive the staged results entrance via [data-stage] on the modal:
    // overlay fade -> card scale-in -> grade pop -> points count-up -> NEW BEST -> done.
    // Reduced-motion: jump straight to 'done' (CSS guard already makes transitions
    // instant) and snap the grade points to final.
    _runResultsEntrance(modal, finalPoints) {
        var self = this;
        var reduce = false;
        try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
        var ptsEl = document.getElementById('gradePoints');

        function setStage(s) { modal.setAttribute('data-stage', s); }

        if (reduce) {
            if (ptsEl) ptsEl.textContent = String(finalPoints);
            setStage('done');
            return;
        }

        // Timeline (ms): each stage is a CSS transition target.
        setStage('overlay');
        setTimeout(function () { setStage('card'); }, 80);
        setTimeout(function () { setStage('grade'); }, 360);
        setTimeout(function () {
            setStage('points');
            // Count the grade points up using the same helper as the in-game HUD.
            if (ptsEl && window.KaraokeeScoreFeedback && finalPoints > 0) {
                var dur = KaraokeeScoreFeedback.countUpDurationMs(finalPoints);
                var start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                (function frame(now) {
                    var t = dur > 0 ? Math.min(1, (now - start) / dur) : 1;
                    ptsEl.textContent = String(KaraokeeScoreFeedback.countUpValue(0, finalPoints, t));
                    if (t < 1) requestAnimationFrame(frame);
                    else ptsEl.textContent = String(finalPoints);
                })(start);
            } else if (ptsEl) {
                ptsEl.textContent = String(finalPoints);
            }
        }, 700);
        setTimeout(function () { setStage('best'); }, 1300);
        setTimeout(function () { setStage('done'); }, 1700);
    }
```

- [ ] **Step 4: Clear `data-stage` so a replay re-runs the entrance**

The end screen is reused on replay; the stale `data-stage` would skip the animation. In `static/player.js`, find `replayGame` (the function wired to the "Play Again" button) and where it hides the modal (`gameModal` `display = 'none'`). Add a `removeAttribute('data-stage')` next to that hide. Locate:

```js
    document.getElementById('gameModal').style.display = 'none';
```

(inside `replayGame`) and replace with:

```js
    var _gm = document.getElementById('gameModal');
    _gm.style.display = 'none';
    _gm.removeAttribute('data-stage');
```

(If `replayGame` hides the modal differently, apply the `removeAttribute('data-stage')` adjacent to wherever it sets the modal `display` to `none`. The `_endShown` latch is already reset in the start path.)

- [ ] **Step 5: Verify the staged entrance**

Run: `python app.py`, finish a Game Mode run.
Expected, in order: the overlay fades in → the card scales up → the grade letter pops → the points **count up** from 0 → NEW BEST ribbon slides in last (only when it's a new best). Click **Play Again**, finish again → the entrance **replays** (not a hard flip).
Enable OS "Reduce motion" → the end screen appears fully formed (final points, ribbon if best), no animation.

- [ ] **Step 6: Run the suites (guard)**

```bash
node tests/test_scoring_session.cjs
node tests/test_scoring_arcade.cjs
python -m pytest tests/test_app.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(results): staged entrance (fade -> card -> grade -> points count-up -> NEW BEST)"
```

---

## Task 13: Phase 2 integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run every JS `.cjs` test**

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … passed." line; no failures. In particular `test_scoring_arcade.cjs`, `test_scoring_session.cjs`, `test_share_card.cjs`, `test_telemetry_helpers.cjs`, plus the new `test_beat_pulse_helpers.cjs` / `test_score_feedback_helpers.cjs` from the parallel plans.

- [ ] **Step 2: Run the Python suite**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS.

- [ ] **Step 3: Confirm the frozen scoring files are untouched**

```bash
git diff --name-only feat/ux-geist-redesign | grep -E 'scoring-arcade\.js|scoring-session\.js|^static/scoring\.js|phrase-engine\.js' || echo "OK: no frozen scoring files changed"
```

Expected: `OK: no frozen scoring files changed`. (If any frozen file appears, revert that change — Phase 2 is render-layer only.)

- [ ] **Step 4: Full gameplay manual matrix (preview)**

Run: `python app.py`, play a full Game Mode run on an **easy** song (fastest path to on-fire), in **dark**, then repeat in **light**:
- Unified score panel: points hero counts up; `+N` popup springs on each clear; accuracy % updates; multiplier + ramp move.
- Tier-up beat pops when the multiplier increases; streak milestone callout at 10.
- Per-line verdicts flash PERFECT/NICE/partial.
- On-fire ignites at max multiplier, pulses at a rate that tracks the song's pace, with embers + warm floor-glow + bold lockup; lyrics stay still; reads in **both** themes; ends and fades when you drop out.
- End screen: staged entrance (fade → card → grade pop → points count-up → NEW BEST); Share image downloads **`audiopian-score.png`** on-brand; Play Again re-runs the entrance.
- Enable OS "Reduce motion" and re-run: every state is vivid-but-static (no pulse, no count-up, no spring); nothing is invisible or broken.

- [ ] **Step 5: Confirm the branch state**

```bash
git log --oneline feat/ux-geist-redesign -14
git status
```

Expected: the Phase-2 commits on `feat/ux-geist-redesign`; clean working tree.

---

## Phase 2 done — what's next

Phase 2 surfaces the previously-discarded arcade reward data (one unified score panel, +points popup, count-up, tier-up beat, streak milestones, per-line verdicts), rebuilds on-fire as the approved C beat-synced treatment (rate-matched + word-onset-anchored, reads in both themes, reduced-motion-safe), rebuilds the share-card on-brand (`audiopian-score.png`), and stages the results entrance — all render-layer, with the four scoring files frozen and every test green.

- **Phase 3** — progressive **word-by-word fill** (`word-fill-helpers.js` + `tests/test_word_fill_helpers.cjs`), the highest-risk item: a pure left-to-right color sweep overlay driven off `interpolateWordTimings` (note: the live word objects use `estimatedTime` / `windowStart` / `windowEnd`, mapped onto the helper's `{start, end}` in **seconds** at the consuming site), verified to not change what the scorer credits before it's wired live.
