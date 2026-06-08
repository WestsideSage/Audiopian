# Scoring

How your singing becomes a score, start to finish. (The word-by-word matching has its own page — [`matching.md`](matching.md) — and the shared vocabulary is in [`CONTEXT.md`](../../CONTEXT.md).)

Karaokee scores in layers, each building on the last.

## 1. Is this word a match?

`scoring.js` decides whether a word you sang matches a lyric word — exactly, by sound (so "night" = "knight"), or by a close-enough spelling. The how is in [`matching.md`](matching.md). Each lyric word also carries a **weight**, by how much it matters (`match-helpers.js`, `classifyWord`):

| Kind of word | Weight | Example |
|---|---|---|
| **core** | 1.0 | the words that carry the line |
| **function** | 0.5 | small connective words ("the", "and", "of") |
| **ad-lib** | 0 | throwaways and anything in parentheses ("ooh", "(yeah)") — they don't count for *or* against you |

## 2. Line-level math

When a line is sung, `computeLineScore` (`scoring.js`) adds up the weight of the words you hit versus the total weight available. A line counts as **perfect** when you hit at least **90%** of the available weight (`scoring.js:503`). These per-line totals add up across the whole run.

## 3. Phrases and "anchors" (key words)

Rather than judging every word equally, the **phrase engine** (`phrase-engine.js`) groups the lyrics into phrases and picks the **anchors** — the key words that prove you actually sang that phrase. How many anchors you must hit (`anchorsRequired`) scales with difficulty, with two fairness adjustments:

- on long lines (4+ anchors) you never need *all* of them — at most all-but-one (`phrase-engine.js:199`);
- on fast, word-dense passages the bar drops further, because nobody hits every word in a rapid-fire verse (`phrase-engine.js:206`).

A phrase is credited once you hit its required anchors (`phrase-engine.js:315`).

## 4. The Honest % (the headline number)

The **Honest %** answers "how much of this song did I *actually* sing?" It's simply: of the anchors in all the phrases that have *already gone by*, how many did you hit? Computed by `getHonestPct` (`scoring-session.js:779`) and refreshed as you play.

## 5. Late credit ("reconciliation")

The accurate recognizer sometimes confirms a word *after* its line has passed. Karaokee credits that word to the line you actually sang it on, which **raises your Honest %** — but it does **not** go back and boost the arcade combo you'd already locked in. (This split is nicknamed "blessed divergence"; `scoring-session.js:905`.)

## 6. The arcade layer

`scoring-arcade.js` turns phrase credits into the game-y score: combos for consecutive hits, points, and a final letter grade. This is the **only scoring path** (the legacy V1 scorer and its `karaokee_v2` / **V**-key A/B toggle were retired 2026-06-08) — see [ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md).

## Where it all comes together

`scoring-session.js` runs the sequence for each phrase as it ends — settle → reconcile → commit → refresh the Honest % (`scoring-session.js:724`) — and hands the screen "draw this" messages; `player.js` just paints them.

## Tests

`tests/test_scoring.cjs` covers the word-match methods and line math; `tests/test_phrase_engine.cjs` and `test_phrase_score.cjs` cover anchors and phrase settling; `tests/test_scoring_session.cjs` covers the end-to-end sequence.
