# Tiered recognizer + bring-your-own-key for the v1 demo deployment

- **Status:** accepted
- **Date:** 2026-06-05

For the first publicly-demoable deployment ("open it in Chrome on a laptop, plug in a mic, sing"), the **default recognizer is the browser Web Speech API (`browser_sr`)** — free, client-side, and already wired — with an **opt-in premium tier where a savvy user supplies their own OpenAI API key (kept client-side) to use `gpt-realtime-whisper`.** We chose this because `gpt-realtime-whisper` is the priciest path, the project is solo-funded on the author's own API credits with no monetization plan, and we cannot absorb per-user inference cost; Chrome's ubiquity makes "Chrome desktop only" a cheap constraint for a v1 demo.

This **deliberately keeps the *older* recognizer as the deployed default**, which runs against the [2026-06-04 core-loop research](../research/2026-06-04-core-loop-modernization.md) recommendation (Path A: consolidate to one modern streaming recognizer). The deviation is intentional and cost-driven, not an oversight — recorded here so the next reader doesn't "fix" it by ripping out browser SR.

## Scope (v1)

- **In:** desktop, Chrome/Edge, a microphone. Free browser-SR lane for everyone; BYO-key premium lane for those who have an OpenAI key.
- **Out (deferred to the "grand vision"):** mobile, non-Chrome/Edge browsers (Chrome/Edge are the supported targets; Firefox has no Web Speech support, others untested), and any project-funded shared key.

## Considered options

- **Project-funded shared key (everyone uses `gpt-realtime-whisper` on our dime).** Rejected: unbounded per-user cost we can't eat with no monetization.
- **Server-side local `faster-whisper` as the free tier.** Rejected: needs a beefy/GPU box and doesn't handle concurrent users; CPU inference is slow.
- **Full consolidation to one modern recognizer (per the research).** Rejected *for deployment*: the cost model wants a free default + a premium opt-in, i.e. tiers, not a single premium-only path. (Still the right call for a *funded* product later.)

## Consequences

- The **dual-recognizer architecture survives.** Path A's "consolidate to one recognizer" is reframed from an algorithm decision into a **deployment** decision. Docs and plans should not claim the app "is consolidating recognizers."
- The **interim-snapshot reconciliation machinery stays load-bearing** (`reconcileInterimSnapshot`, segment-reset detection, `_interimFloorSec`). It exists because browser SR emits interims and rarely fires `final` during continuous singing — and browser SR is now the *default* deployed lane, so this code is not removable.
- The **v1 demo is Chrome-desktop-only by design** — a known, accepted limitation, not a bug.
- **Open (deferred to `docs/operations/deployment.md`):** the exact BYO-key flow — browser mints the ephemeral realtime token *directly* with the user's key vs. the browser hands its key to our server to mint — and whether OpenAI permits the mint call from a browser (CORS). Today `/realtime-transcription-session` mints with the *server's* key; the BYO-key tier changes that.
