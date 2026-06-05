# Deployed audio is client-side YouTube IFrame (any song), not a curated catalog

- **Status:** accepted
- **Date:** 2026-06-05
- **Related:** [ADR-0001](0001-tiered-recognizer-byo-key-deploy.md)

The core product thesis is **"sing the songs you genuinely love."** Karaokee exists to fix the karaoke-bar problem — huge catalogs that never have *your* song, the one you know cold and can shine on. So the ability to play **any** song is non-negotiable, which rules out a curated catalog. For the deployed app, the backing track plays **client-side via the YouTube IFrame Player API** (the browser streams from the user's own IP); the server downloads and holds **no audio**.

## Why not the alternatives

- **Curated bundled catalog** — betrays the thesis (and would skew to the author's rap taste); a fixed list *is* the exact karaoke-bar limitation the product reacts against.
- **Keep server-side `yt-dlp` download** — 403s from cloud IPs (SABR gating; the cookie fix needs a *local* browser), clobbers concurrent users via the single `temp/audio.webm`, and violates YouTube ToS. The IFrame Player API is the *sanctioned* embed path, so IFrame is also a compliance **upgrade**.
- **Hybrid (server fallback for embed-disabled videos)** — reintroduces all three problems for the fallback set; rejected for v1.

## Scope: "any song" = "any embeddable, synced song"

Prefer auto-generated **"… - Topic"** / audio uploads over music videos — more often embeddable, clean audio with no video intro, and they **match the LRC's reference timing** (music videos drift; the author already avoids them for this reason). On a miss (won't embed, or lrclib has no *synced* LRC), **degrade gracefully** — tell the user, let them pick another version — never break.

## Consequences

- Combined with ADR-0001 (browser-SR default), the deployed server becomes **near-stateless**: static frontend + lrclib lookup + telemetry collection — no audio download, no per-user temp file, no server inference. Cheap and simple to host.
- **Embeddability tax:** "any song" narrows to embeddable uploads; mitigated by Topic-upload preference + graceful fallback.
- **Clock-precision risk (top engineering risk):** the scoring clock moves from `<audio>`'s synchronous, frame-accurate `currentTime` (`static/player.js:1`, read across the whole timing core) to the IFrame API's coarser, ~250 ms-polled `getCurrentTime()`. Worst on fast rap with tight word windows. Solvable by interpolating between polls with `performance.now()`, but it's surgery in the highest-risk file — **de-risk with a throwaway spike before committing the refactor.**
- The "paste any YouTube URL → server download" flow and local `faster-whisper` survive as **local-dev-only** capabilities.
- **Future (out of v1 scope):** some "Topic" uploads offer clean (non-explicit) versions — a later lever for broadening the audience to users who'd rather not perform explicit lyrics. Quality-of-life, not v1.
