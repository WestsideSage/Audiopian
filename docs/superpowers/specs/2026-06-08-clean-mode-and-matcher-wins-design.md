# Spec: Clean/Explicit mode + matcher QoL wins (2026-06-08)

## Summary
Two small, additive scoring features, grounded in the 2026-06-08 recording batches:

1. **Clean / Explicit mode** — an opt-in mode that (a) never makes profanity a required key word and (b) masks profanity in the displayed lyrics, so a song can be played/recorded PG without getting dinged for curse words you skip.
2. **Substantial-affix match** — credit a key word when the recognizer transcribed a substantial prefix/suffix of it (e.g. `battle` for `battlecry`), fixing a class of "I clearly said it and it didn't score" misses.

Plus a content-policy guard: the **hard-R n-word variant is never scored** in any mode.

These are pure-helper changes with `.cjs` tests; no architecture changes. The matcher change touches golden-tested code, so it ships with cheese-guard tests first.

## Motivation (evidence)
From the user's own runs (`output_telemetry/2026-06-08/`, debug on):
- Of 220 uncredited key words across 8 new runs, **88%** were words the recognizer returned *nothing usable* for (recall ceiling); only **12%** were heard-but-not-credited, and those were the **repeated-word / filler guards working as intended** (`already_consumed`, `generic_word`), not mapping gaps. **Zero** were timing-window misses; **zero** common-word failures.
- Conclusion: a *dynamic per-song word map* has ~no payoff and a real cheese surface (it would be tempted to map `the→type`). **Explicitly out of scope.**
- The one recurring, genuinely-fixable class is **affix truncation**: `battlecry←battle` (×2), `reached←reach`, `preached←preach`, `ballerass←baller`, `distasteful←tasteful` — all clean same-word cases, no false-positive-prone pairs.
- The only same-word profanity "variant" the recognizer produced was the **-a n-word being mis-transcribed as the hard-R form**; per user decision the hard-R variant is never treated as said, so no mapping is added — a never-score guard is added instead.

## Goals
- Clean mode: profanity never required as a key word; profanity masked in displayed lyrics; toggle persisted like difficulty.
- Affix match recovers substantial prefix/suffix truncations without opening cheese.
- Hard-R n-word is never an anchor and never credits, in all modes.
- All existing golden suites (24 `.cjs`) + 55 pytest stay green.

## Non-goals
- Dynamic / per-song word map (no payoff, cheese risk).
- Censoring telemetry, share images, or audio — display-only.
- Changing the recognizer, VAD, premium path, or arcade/grade logic.
- Lowering global match thresholds.

---

## Feature ① — Clean / Explicit mode

### Mode flag
- One boolean, persisted in `localStorage` under key `cleanMode` (`'1'` = clean; absent/`'0'` = explicit). Default **Explicit** (today's behavior); Clean is opt-in.
- Surfaced as a small toggle on the difficulty/prep screen (`player.html` diff-gate). Same plumbing path as `difficulty`.
- Threaded into `buildPhrasePlan(lyrics, { difficulty, clean })` → `selectAnchors`.

### New pure helper: `static/profanity.js` (`window.KaraokeeProfanity`)
- `isProfane(word)` — true if `word` (normalized) is in the **clean-mode profanity set**: strong words (e.g. fuck/shit/bitch/dick/pussy/cock/cunt + common inflections) **and** slurs, **including the song-standard -a n-word variant**. **Excludes** mild words (damn, hell, ass) per "strong + slurs".
- `isNeverScore(word)` — true for the **hard-R n-word variant(s)** only (derived in code from the -a entries, not spelled out in source). Strict subset, applied in *all* modes. **Note the deliberate asymmetry:** the -a variant is in `isProfane` only — so clean mode censors/excludes it, but explicit mode keeps it as a normal, creditable key word; the hard-R variant is additionally `isNeverScore`, so it is *never* an anchor and *never* credits, in either mode.
- `censorWord(word)` — masking for display, keeping the first letter and matching length (`fuck`→`f***`, `shit`→`s***`). Operates on the original display token; preserves surrounding punctuation.
- UMD module, loaded before `player.js`; `.cjs`-tested (`tests/test_profanity.cjs`).

### Scoring relief (anchor selection)
In `phrase-engine.js selectAnchors`:
- Exclude a word from anchors when `isNeverScore(word)` (**all modes**) OR (`clean` && `isProfane(word)`).
- Anchor-less fallback: if a line has no anchors after exclusion, it stays **non-scoring** (`anchorsRequired = 0`) — it must **not** fall back to filler anchors that re-introduce profanity. (Today's all-filler fallback only runs when the original line was filler-only; guard it so excluded-profanity lines don't trigger it.)
- Effect: a cursing line scores on its clean key words; a profanity-only line neither helps nor hurts (like an all-ad-lib line).

### Display censoring
- In **clean mode only**, mask `isProfane` words in the rendered lyrics via `censorWord`. Applies to the main lyric render (the `.word-span` text) and the difficulty preview.
- **Display-only**: scoring uses the internal normalized words, which are unchanged — censoring the visible text changes nothing about matching/scoring.

### Hard-R never-score guard (matcher)
- In `scoring.js wordsMatchScore`/`wordsMatch`: if `isNeverScore(spoken)` or `isNeverScore(target)`, return no-match (score 0). Belt-and-suspenders so the hard-R can never credit any anchor via any path (line scorer, phrase engine, reconcile, affix). Combined with the `selectAnchors` exclusion, the hard-R is fully neutralized: never required, never creditable, in all modes.

---

## Feature ② — Substantial-affix match (`scoring.js`)

### Rule
Add to `wordsMatch` and `wordsMatchScore`, after the existing phonetic/edit checks, before returning no-match:

> If one of `{spoken, target}` is a strict prefix **or** suffix of the other, and the **shorter** token is **≥ 5 characters** and **≥ 60%** of the longer token's length → match.

- Score/method: treat as a high-confidence lexical match (method `affix`), score `1.0` (it is the same word, just truncated by the recognizer). (Alternative: `0.9`; pick `1.0` for parity with the `-ing` truncation rule already returning `1.0`.)
- Direction: applies whether the recognizer returned the shorter (`battle` for `battlecry`) or the longer form.

### Why these thresholds
- `≥ 5 chars` + `≥ 60%` admits `battle/battlecry` (6/9=.67), `reach/reached` (5/7=.71), `tasteful/distasteful` (8/11=.73) and rejects short-common-prefix false positives: `ever→everything`, `over→overcome`, `in→into`, `with→without` (all < 5 chars or < 60%).
- Accepted edge: rare different-word collisions ≥5 chars & ≥60% (e.g. `should/shoulder` 6/8=.75). Low impact (you still have to sing most of the real word; not a cheese exploit). Documented, not guarded further.
- Known trade-off: `must←mustve` (4 chars) stays unfixed — acceptable for the conservative threshold.

### Cheese-guard tests (write FIRST, must fail before the rule exists)
- MUST match: `battlecry↔battle`, `reached↔reach`, `preached↔preach`, `distasteful↔tasteful`.
- MUST NOT match: `ever↛everything`, `over↛overcome`, `in↛into`, `the↛theater`, `art↛articulate` (short prefix), `cat↛category`.
- Interaction: `isNeverScore` still wins (hard-R never matches even if affix-eligible).

---

## Files touched
- **New:** `static/profanity.js`, `tests/test_profanity.cjs`.
- **Edit:** `static/scoring.js` (affix rule + never-score guard), `tests/test_scoring.cjs` (affix match + cheese-guard tests), `static/phrase-engine.js` (`selectAnchors` exclusions + fallback guard; `buildPhrasePlan` `clean` option), `tests/test_phrase_engine.cjs` (clean-mode anchor exclusion), `static/player.js` (mode toggle read/persist; pass `clean` to `buildPhrasePlan`; censor on render), `static/player.html` (toggle UI + load `profanity.js`), `CLAUDE.md` (helper list).

## Testing & rollout
- TDD each pure helper; cheese-guard tests precede the affix rule.
- Full `.cjs` suite (24 + new) and pytest (55) green; `node --check` on edited browser files.
- Manual: a clean-mode run on an explicit song (curses masked + not required), an explicit-mode run (unchanged), and a `battlecry` re-test (now scores).
- Ships behind the existing test discipline; push `main` when green (auto-deploys).

## Open defaults (chosen, reversible)
- Default mode **Explicit** (no behavior change for existing play); Clean opt-in.
- Affix score **1.0**, thresholds **≥5 / ≥60%**.
- Never-score list scoped to the **hard-R n-word** only; trivially extensible to other slurs later if desired.
