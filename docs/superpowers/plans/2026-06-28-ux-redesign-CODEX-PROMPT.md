# Codex execution prompt — Audiopian UX redesign

Paste the block below to Codex. (If you run Codex in the **cloud**, first push the
`feat/ux-geist-redesign` branch so the plan docs are available to it; for local
Codex CLI the branch is already present.)

---

You are implementing a planned, multi-phase frontend redesign of **Audiopian**, a pure-static browser karaoke app: plain HTML/CSS/JS under `static/`, **no build step**, served in dev by Flask (`python app.py` → http://localhost:5000). The work is already specced and decomposed into bite-sized, mostly test-driven implementation plans. Your job is to execute those plans exactly, in the right order, on the existing branch — not to redesign anything yourself.

## Start here
1. Work on the existing branch `feat/ux-geist-redesign`. It already contains the spec and all plans; do **not** create a new branch or start from `main`.
2. Read in full the coordination index: `docs/superpowers/plans/2026-06-28-ux-redesign-INDEX.md`. It is the source of truth for ordering, dependencies, and the cross-plan "seam" notes. Then skim the spec `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` for context.

## Execution order
Execute these plan files in this order. The first four are independent (new files / additive only) and may be done in any order. The three phases edit the same shared files (`static/style.css`, `static/player.html`, `static/player.js`) and **must run strictly one at a time, in order** — never interleave them.

Wave A — independent, any order:
- `docs/superpowers/plans/2026-06-28-ux-redesign-phase0-foundation.md`
- `docs/superpowers/plans/2026-06-28-ux-redesign-helper-beat-pulse.md`
- `docs/superpowers/plans/2026-06-28-ux-redesign-helper-score-feedback.md`
- `docs/superpowers/plans/2026-06-28-ux-redesign-helper-word-fill.md`

Then, strictly in order:
- `docs/superpowers/plans/2026-06-28-ux-redesign-phase1-reskin.md`
- `docs/superpowers/plans/2026-06-28-ux-redesign-phase2-scoring-onfire.md`
- `docs/superpowers/plans/2026-06-28-ux-redesign-phase3-word-fill.md`

## How to execute each plan
- Work through its tasks in order; treat each task's `- [ ]` steps literally and use the exact code shown.
- For the `*-helpers.js` modules it is strict TDD: write the failing test → run it and confirm it FAILS → write the minimal implementation → run it and confirm it PASSES → commit. JS tests run as `node tests/<name>.cjs`.
- For CSS/markup tasks: make the small per-task edit, then run the plan's preview-verification step (start `python app.py`, open the page, confirm what the step describes). Do not skip verification.
- Commit after each task using the plan's commit message. One task = one commit.
- After finishing a whole plan, run the full suite and confirm green before starting the next plan:
  - JS: `for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done`
  - Python: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q`

## Hard rules
- **Never modify the frozen scoring files**: `static/scoring-arcade.js`, `static/scoring-session.js`, `static/scoring.js`, `static/phrase-engine.js`. This redesign is render-layer only. If a step seems to require editing them, stop and report.
- **No build step.** Do not add bundlers, frameworks, a `package.json`, or npm scripts. Fonts load via `<link>`/self-host; icons are inline SVG.
- **Prefer stable anchors over line numbers.** The plans cite some line numbers as "(currently ~L###)", but the sequential phases shift them — locate code by the function name / CSS selector / unique string the plan names. If an exact-string find fails, find the stable marker rather than forcing the literal or inventing code.
- **Honor the seam notes** in the INDEX's "Cross-plan coordination notes" and "Deviations" sections (e.g. the share image is `audiopian-score.png` by Phase 2; locate `.word-span` by selector and use `var(--text-faint)`; the `#searchBtn` id is intentionally kept). Don't undo a deliberate deviation.
- **Dark mode must stay pixel-identical through Phase 0** (it adds tokens + the theme toggle only); the visible re-skin begins in Phase 1.
- **Windows authoring note:** when a step creates/edits a JS file containing backtick template literals, use the file editor, not a shell heredoc (heredocs strip backtick contents on Windows).
- **Stay green.** Do not proceed past a failing test, and do not work around a missing anchor by guessing.

## Integration
Commit per task on `feat/ux-geist-redesign`. Do **not** merge to `main`, force-push, or open a PR unless explicitly told to. When all plans are executed and the full suite is green, post a summary (commits made, tests passing, anything you had to deviate on) and stop.

## If you get stuck
If an anchor genuinely doesn't exist, a test won't pass after a reasonable attempt, or a step is ambiguous, **stop and report** the specific file/symbol and what you observed — do not invent code or expand scope.

---

### Optional: running Wave A in parallel
For maximum speed you can run the four Wave-A plans in four separate Codex sessions concurrently (they touch disjoint files — the three helpers create only new `static/*-helpers.js` + `tests/*.cjs`, and Phase 0 touches `style.css`/HTML). The three phases must still be a single sequential track. To split, give each parallel session the same block above but restrict it to one plan file, and have the phase track wait until Phase 0 (and, for Phase 2, the beat-pulse + score-feedback helpers; for Phase 3, the word-fill helper) are merged.
