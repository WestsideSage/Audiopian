# UX Redesign — Plan Index & Execution Coordination

**Read this first.** It is the map for the Audiopian Geist-inspired UX redesign: which plans exist, what depends on what, what can run in parallel, the recommended dispatch order, and the cross-plan coordination notes that prevent agents from stepping on each other.

- **Spec (authoritative):** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md`
- **Branch:** `feat/ux-geist-redesign`
- **Frozen:** `scoring-arcade.js`, `scoring-session.js`, `scoring.js`, `phrase-engine.js` — the entire redesign is **render-layer only**. No plan changes scoring logic.
- **No build step:** plain HTML/CSS/JS served by Flask (`python app.py` → http://localhost:5000). JS tests: `node tests/test_*.cjs`. Python tests: `pytest`.

## The plans

| # | Plan file | Kind | Depends on | Parallel-safe? |
|---|-----------|------|-----------|----------------|
| 0 | `2026-06-28-ux-redesign-phase0-foundation.md` | Foundation (sequential root) | — | No (edits shared files) |
| H1 | `2026-06-28-ux-redesign-helper-beat-pulse.md` | Pure helper | — | **Yes** (new files only) |
| H2 | `2026-06-28-ux-redesign-helper-score-feedback.md` | Pure helper | — | **Yes** (new files only) |
| H3 | `2026-06-28-ux-redesign-helper-word-fill.md` | Pure helper | — | **Yes** (new files only) |
| 1 | `2026-06-28-ux-redesign-phase1-reskin.md` | Surface re-skin | Phase 0 | No (edits shared files) |
| 2 | `2026-06-28-ux-redesign-phase2-scoring-onfire.md` | Scoring/on-fire/results | Phase 1 + H1 + H2 | No (edits shared files) |
| 3 | `2026-06-28-ux-redesign-phase3-word-fill.md` | Word-by-word fill | Phase 2 + H3 | No (edits shared files) |

## Dependency graph

```
            ┌──────────────── parallel-safe (new files only) ───────────────┐
            │   H1 beat-pulse        H2 score-feedback        H3 word-fill   │
            └─────┬───────────────────────┬─────────────────────────┬───────┘
                  │                        │                         │
 Phase 0 ──► Phase 1 ──────────────► Phase 2 ──────────────────► Phase 3
 (tokens,   (re-skin surfaces,      (score panel, +pts popup,   (progressive
  theme,     Lucide, thumbnails,     count-up, on-fire beat-     word fill)
  toggle)    cleanup, player         sync [H1], feedback [H2],
             joins theme)            share-card, results entrance)
```

- **Phase 0 and all three helpers (H1/H2/H3) share no files** — they can ALL run at the same time (4 concurrent agents).
- Phases 0→1→2→3 are a **strict chain** on the shared files `style.css` / `player.html` / `player.js`. They must land in order.
- H1/H2 must be merged **before Phase 2** starts wiring them; H3 before Phase 3.

## Recommended Codex dispatch order

**Wave A (start immediately, in parallel — 4 agents):**
- Phase 0  ·  H1 beat-pulse  ·  H2 score-feedback  ·  H3 word-fill

**Wave B (after Phase 0 merges):**
- Phase 1  (the helpers may still be finishing — no conflict, different files)

**Wave C (after Phase 1 merges AND H1 + H2 are merged):**
- Phase 2

**Wave D (after Phase 2 merges AND H3 is merged):**
- Phase 3

Critical path is `Phase 0 → 1 → 2 → 3`; the helpers are "free" wall-clock because they overlap the phase chain.

## Branch / merge strategy for parallel agents

The phases edit the **same** shared files, so do **not** run Phase 1/2/3 concurrently on independent branches and merge later — you'll get conflicts and "foundation not there yet" failures. Two safe models:

1. **Single integration branch (simplest):** everything commits onto `feat/ux-geist-redesign` in dependency order. Helpers can be committed any time; phases strictly in order. One agent at a time on the phase chain; helper agents can interleave freely.
2. **Branch-per-unit with ordered merges:** each helper on its own short-lived branch (merge whenever — new files, conflict-free). Each phase on its own branch **cut from the previous phase's merged result** and merged before the next phase starts. Never have two phase branches open against the same base.

## Cross-plan coordination notes (resolve these — they span plans)

These are the seams between plans. Each is already noted inside the relevant plan, but they live here too because an agent working one plan can't see the others.

1. **Share-card filename rename is owned by Phase 1; the rebuild is Phase 2.** Phase 1 performs the `karaokee-score.png` → `audiopian-score.png` rename (it's in the §3.6 cleanup list). Phase 2 rebuilds the share image. → **Phase 2 must NOT anchor on the literal string `karaokee-score.png`** (Phase 1 already changed it). Locate the download code by the `_downloadShareImage` function and the `a.download =` assignment, and treat the filename as already `audiopian-score.png`.

2. **`.word-span` color anchor moves under Phase 1.** Phase 3 locates the word-span CSS rule. Phase 1 remaps the hardcoded player colors (`#4b4e60`, `#6c6f82`, etc.) onto tokens. → **Phase 3 must locate the rule by the selector `.lyric-line.active .word-span` (and the `.word-span` base rule), NOT by the literal `color:#4b4e60`** — that literal will be a `var(--…)` token by the time Phase 3 runs.

3. **Score-panel ownership is split intentionally.** Phase 1 wraps the existing accuracy + arcade HUD in a real `.panel` container (skin only). Phase 2 restructures it into the **points-hero** `.score-panel` (points big, accuracy secondary) and relocates `#score-pct`. → Phase 1 should keep its HUD change to a container/skin and not over-invest in the internal layout; Phase 2 owns the final structure. Phase 2 reads whatever Phase 1 left and rebuilds.

4. **`#searchBtn` id is RETAINED (recorded spec deviation).** The spec §3.6 listed the `#searchBtn` id as removable ("never queried"). Phase 1's new search loading-state **does** query it (`getElementById('searchBtn')`), so Phase 1 keeps the id. → Do not "re-clean" this id in any later pass; it is intentionally kept.

5. **Player CSS location after Phase 0.** Phase 0 Task 7 relocates `player.html`'s inline `<style>` into `style.css`. Phases 1/2/3 therefore edit player styling **in `style.css`**, not in `player.html`. Each plan instructs grep-locating the selector and falling back to `player.html` only if Phase 0 wasn't applied. Always run Phase 0 first.

6. **word-fill field mapping: Phase 3 is authoritative.** The H3 helper is pure `{start, end}` seconds. The H3 plan *illustrates* one possible mapping (`estimatedTime` → next word's `estimatedTime`); Phase 3 actually uses `windowStart` → `start`, `windowEnd` → `end` from `scoring.js interpolateWordTimings`. → Use **Phase 3's** mapping (`windowStart`/`windowEnd`); the helper plan's mapping comment is illustrative only.

7. **beat-phase is a saw wave in `[0,1)`.** H1's `beatPhase` returns `0` at an exact downbeat, not `1`. → Phase 2's on-fire visual should derive a symmetric swell (e.g. `1 - |2·phase − 1|` or `sin(phase·π)`) in the consumer, not expect a peak at `1`. (Also noted at the end of the H1 plan.)

8. **`#8b5cf6` stray color** in the share canvas is fixed as part of Phase 2's share-card rebuild (not Phase 1).

## Deviations from the spec (accepted, recorded)

- **`#searchBtn` id kept** — see note 4 (the cleanup item is voided by a new use).
- **Player footer bar omitted** — Phase 1 does not add a bottom footer to the player (it would overlap the fixed transport controls); the player's required legal/disclosure surface is satisfied by the existing prep-overlay point-of-capture line. Recorded in Phase 1.
- **Share-card rebuild deferred Phase 1 → Phase 2** — to avoid editing the canvas twice; Phase 1 does only the filename rename.

## Status / progress

- [x] Spec written & committed (`be2d5e2`)
- [x] Phase 0 plan written
- [x] H1 / H2 / H3 helper plans written
- [x] Phase 1 / 2 / 3 plans written
- [ ] Wave A executed (Phase 0 + H1 + H2 + H3)
- [ ] Wave B executed (Phase 1)
- [ ] Wave C executed (Phase 2)
- [ ] Wave D executed (Phase 3)

Each plan carries its own `REQUIRED SUB-SKILL` header for execution (subagent-driven-development or executing-plans). Anchored line numbers in the plans are as of 2026-06-28; the sequential phases shift them, which is why the phase plans locate by stable markers (function names, CSS selectors, unique strings) — prefer those over raw line numbers when executing.
