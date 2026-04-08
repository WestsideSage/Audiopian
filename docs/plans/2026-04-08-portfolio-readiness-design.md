# Portfolio Readiness Pass — Design Document

**Date:** 2026-04-08
**Goal:** Transform the Karaokee repo from a rough side project into a resume-worthy portfolio piece.

## Problem Statement

The core engineering is strong — dual-track ASR, phonetic matching, adaptive sync, telemetry-driven iteration — but the repo presentation undermines it. An interviewer cloning this repo would be confused by two frontends, overwhelmed by 32 flat design docs, and distracted by dead/disabled features.

## Narrative

The project should tell this story: "I built a real-time karaoke scoring engine that combines browser speech recognition with Whisper ASR, uses phonetic matching and edit distance for fuzzy word comparison, adapts timing windows by song tempo, and I instrumented it with telemetry to iterate on the algorithm using real gameplay data."

## Decisions

### Vocal separation: Remove entirely
- Currently disabled in `app.py` (commented-out block), tests skipped, endpoints exist but don't fire
- Removal simplifies the codebase, removes half-finished impression
- Can be re-added later as a deliberate feature with its own design doc and PR
- Scope: delete `vocal_remover.py`, `test_vocal_remover.py`, separation endpoints in `app.py`, separation state globals, frontend separation polling/toggle code

### React/TypeScript frontend: Remove entirely
- `src/` contains 734 lines of orphaned React code (hooks, components, parser)
- `package.json` misidentifies the project as Vite/React
- The actual working frontend is static HTML/JS in `static/`
- Scope: delete `src/`, `package.json`

### Design docs: Keep but organize
- The 32 design/implementation docs show engineering maturity and iterative improvement
- Reorganize into chronological subdirectories with an index for scannability
- Preserve the "how it started vs how it's going" progression

### Telemetry output: Remove from git, keep locally
- 56MB of session JSON committed to repo is noise
- Add to `.gitignore`, remove from git tracking
- Data stays on disk for continued analysis

## Cleanup Plan

### Phase 1 — Safe Cleanup (Low Risk, High Impact)

1. **Delete orphaned React frontend** — `src/`, `package.json`
2. **Delete misc dead files** — `demo.json`, `temp/write_tests.py`
3. **Remove vocal separation entirely** — `vocal_remover.py`, `test_vocal_remover.py`, separation endpoints/state in `app.py`, frontend separation code in `player.html`/`player.js`
4. **Remove commented-out separation block** in `app.py`
5. **Fix duplicate `import threading`** in `app.py`
6. **Remove `output_telemetry/` from git tracking** — add to `.gitignore`
7. **Add `.gitignore` entries** — telemetry output, logs, IDE files
8. **Clean up stale git branches** — `feat/time-gated-matching`, `backup/local-prototype-snapshot`, `telemetry-driven-tuning`

### Phase 2 — Structural Improvements (Medium Risk, High Impact)

9. **Fix broken `maxEditDistance` JS test** — determine correct behavior, fix assertion
10. **Pin `requirements.txt` versions**
11. **Fix thread safety** — add lock around `_last_duration` write in `app.py`
12. **Fix Flask debug mode** — use `FLASK_DEBUG` env var instead of hardcoded `True`
13. **Add basic logging** — replace silent exception swallowing in `lyrics.py`
14. **Organize `docs/plans/`** — group by month or feature area, add index README

### Phase 3 — Resume-Facing Polish

15. **Write README** — project description, architecture overview, setup instructions, demo flow, tech stack
16. **Add GitHub Actions CI** — run pytest on push
17. **Move hardcoded config to env vars** — Whisper model, device, Demucs model (with sensible defaults)

### Phase 4 — Optional Stretch

18. Add type hints to Python backend
19. Add architecture diagram (Mermaid) to README
20. Accessibility improvements (ARIA labels, keyboard navigation)
21. Dockerfile for easy demo setup

## What This Achieves

- Removes ~800 lines of dead/orphaned code
- Removes ~56MB of committed telemetry data
- Eliminates the "two frontends" confusion
- Eliminates the "half-disabled feature" impression
- Makes the repo clonable and understandable in under 5 minutes
- Positions the project to tell a coherent, impressive technical story
