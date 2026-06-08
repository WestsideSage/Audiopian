# Arcade scoring promoted to the default experience; lyric-axis frozen at its honesty ceiling

- **Status:** accepted
- **Date:** 2026-06-05
- **Related:** [ADR-0001](0001-tiered-recognizer-byo-key-deploy.md), [ADR-0002](0002-any-song-client-side-youtube-iframe.md)

> **Update — 2026-06-08: V1 fully retired; arcade is now the *only* scoring path.** The follow-on to this ADR shipped (branch `refactor/retire-v1-scoring`): the legacy V1 scorer, the `karaokee_v2` flag, and the `V` A/B toggle were all deleted. So "promoted from a flagged experiment to the default" below is **superseded** — there is no flag and no V1 alternative, just the single arcade/V2 stack. The standing **anti-cheese sing-test gate was run and PASSED** for this change: user-confirmed cheese scores ~0 with no multiplier lift, and an honest *Uproar* run scored 98% / grade S ≈ the prior 99%/S baseline (scoring behavior unchanged — the V2 logic was untouched). The repeated-hook residual and the global-leaderboard caveat (below) still stand as documented limitations. Deployed live to Cloudflare 2026-06-08.

We are **done improving the scoring algorithm for now.** The lyric-axis scorer (match → reconcile → score) is treated as **frozen at its threshold-bound honesty ceiling** — the [2026-06-04 core-loop research](../research/2026-06-04-core-loop-modernization.md) found lyric-axis anti-cheese is *structurally capped* (no ASR / alignment / GOP paradigm fixes it), so further threshold tuning has diminishing returns. The **arcade scoring layer (`karaokee_v2`) is promoted from a flagged experiment to the default, primary experience** for the v1 demo.

## Why we're confident enough to ship arcade as the default

Honest-singing recognition is validated across multiple pre/post-patch telemetry schemas — most recently a **99% Expert run of *Praise Da Lord*** (one missed word), a large improvement over V1-era runs of the same song. That evidence covers the **recognition / fairness axis**: *honest singing scores correctly.*

## What is NOT cleared — and why that's acceptable here

The standing **human anti-cheese sing-test gate** and the **known residual** (skipping a line *identical* to one just sung still over-credits) are **deferred, not resolved.** A 99% honest run validates honest scoring, not the *anti-cheese* axis — a different thing. For a **portfolio demo that is not a ranked competition**, this is an acceptable trade: ship arcade-on and document the residual as a known limitation. The gate was framed for a *competitive* default-on flip; a demo has lower stakes.

> ⚠️ A future **global leaderboard** would re-raise these stakes (public ranking gives the residual a clout payoff, and client-side scores are forgeable) — so the leaderboard stays a post-v1 stretch, and the anti-cheese gate must be revisited *before* any competitive ranking ships.

## Deferred, not abandoned

- **Path B (pitch / melody axis)** and **Path C (alignment-first timing)** — the next *algorithm* frontier per the research — are deferred behind the deployment milestone. Pitch needs a Demucs stem + a validation dive; deferring honors the research's own "not yet earned the budget" caveat.
- The next milestone is **deployment / demo-ability**, not algorithm work (see ADR-0001, ADR-0002).
