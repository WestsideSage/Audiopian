var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}

var arcade = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'scoring-arcade.js'));

// Helper: a phrase outcome hitting `hit` of `total` anchors, `required` to clear.
function clear(id, required, total, hit) {
    return { phraseId: id, anchorsRequired: required, anchorsTotal: total, anchorsHit: hit };
}

// --- 1. Initial state ---
var s = arcade.createArcadeState('medium');
assert.strictEqual(s.points, 0, 'starts at 0 points');
assert.strictEqual(s.multiplier, 1, 'starts at 1x');
assert.strictEqual(s.streak, 0, 'starts at 0 streak');

// --- 2. Single bare clear (medium, required 2, hit 2 of 4 -> not perfect) ---
var ev = arcade.commitPhrase(s, clear('p0', 2, 4, 2));
assert.strictEqual(ev.pointsAwarded, 250, 'bare clear pays base*required*baseScale (100*2*1.25)');
assert.strictEqual(ev.outcome, 'clear');
assert.strictEqual(ev.perfect, false);
assert.strictEqual(s.streak, 1);
assert.strictEqual(s.multiplier, 1, 'one clear does not yet tier up');

// --- 3. Ramp cadence: 4 bare clears (required 1, medium) -> tier up to 2x on the 4th ---
var r = arcade.createArcadeState('medium');
var mults = [];
for (var i = 0; i < 5; i++) {
    var e = arcade.commitPhrase(r, clear('rp' + i, 1, 3, 1));
    mults.push(e.multiplier);
}
// award uses current mult, THEN ramp advances. base = 100*1*1.25 = 125.
assert.deepStrictEqual(mults, [1, 1, 1, 2, 2], 'multiplier tiers up after 4 bare clears');
assert.strictEqual(r.points, 750, 'ramp cadence point total (125*4 @1x + 125*2 @2x)');

// --- 4. Perfect double-fills the ramp (+2): 2 perfects -> tier up ---
var p = arcade.createArcadeState('medium');
var pe1 = arcade.commitPhrase(p, clear('pp0', 1, 1, 1)); // hit all -> perfect
arcade.commitPhrase(p, clear('pp1', 1, 1, 1));
assert.strictEqual(pe1.perfect, true, 'hitting all anchors is perfect');
assert.strictEqual(p.multiplier, 2, 'two perfects (ramp +2 each) tier up');
assert.strictEqual(pe1.pointsAwarded, 188, 'perfect pays +50% (round(125*1.5))');

// --- 5. Miss resets multiplier, ramp, streak ---
var m = arcade.createArcadeState('hard');
for (var j = 0; j < 6; j++) arcade.commitPhrase(m, clear('mp' + j, 1, 2, 1));
assert.ok(m.multiplier > 1, 'built a multiplier');
var miss = arcade.commitPhrase(m, clear('mm', 2, 4, 0)); // hit 0 -> miss
assert.strictEqual(miss.outcome, 'miss');
assert.strictEqual(m.multiplier, 1, 'miss resets multiplier to 1');
assert.strictEqual(m.streak, 0, 'miss resets streak');

// --- 6. Partial holds (no points, no streak change, no reset) ---
var h = arcade.createArcadeState('medium');
arcade.commitPhrase(h, clear('hp0', 2, 4, 2)); // clear -> streak 1, ramp 1
var beforePoints = h.points, beforeStreak = h.streak, beforeRamp = h.ramp;
var part = arcade.commitPhrase(h, clear('hp1', 3, 5, 1)); // 0 < 1 < 3 -> partial
assert.strictEqual(part.outcome, 'partial');
assert.strictEqual(part.pointsAwarded, 0, 'partial awards no points');
assert.strictEqual(h.points, beforePoints, 'partial does not change points');
assert.strictEqual(h.streak, beforeStreak, 'partial holds streak');
assert.strictEqual(h.ramp, beforeRamp, 'partial holds ramp');

// --- 7. Difficulty payout monotonicity: identical clears, expert > easy ---
function totalFor(diff) {
    var st = arcade.createArcadeState(diff);
    for (var k = 0; k < 10; k++) arcade.commitPhrase(st, clear('d' + k, 2, 4, 2));
    return st.points;
}
assert.ok(totalFor('expert') > totalFor('easy'), 'expert out-pays easy for identical play');
assert.ok(totalFor('hard') > totalFor('medium'), 'hard out-pays medium');

// --- 8. Grade thresholds — difficulty-aware ('medium' is the default) ---
assert.strictEqual(arcade.gradeFor(90), 'S');            // medium S=87
assert.strictEqual(arcade.gradeFor(86), 'A');            // <87, >=73
assert.strictEqual(arcade.gradeFor(60), 'B');            // >=59
assert.strictEqual(arcade.gradeFor(45), 'C');            // >=45
assert.strictEqual(arcade.gradeFor(44), 'D');            // <45
// Easy aces low coverage; Expert is strict.
assert.strictEqual(arcade.gradeFor(93, 'easy'), 'S');    // easy S=80
assert.strictEqual(arcade.gradeFor(80, 'easy'), 'S');
assert.strictEqual(arcade.gradeFor(79, 'easy'), 'A');    // easy A=64
assert.strictEqual(arcade.gradeFor(32, 'easy'), 'C');    // easy C=32
assert.strictEqual(arcade.gradeFor(31, 'easy'), 'D');
assert.strictEqual(arcade.gradeFor(93, 'expert'), 'A');  // expert S=96 -> 93 is A (>=88)
assert.strictEqual(arcade.gradeFor(96, 'expert'), 'S');
assert.strictEqual(arcade.gradeFor(95, 'expert'), 'A');
// Monotonic: for a fixed pct, grade rank never improves as difficulty rises.
var gradeRank = { S: 5, A: 4, B: 3, C: 2, D: 1 };
['easy', 'medium', 'hard', 'expert'].reduce(function (prev, d) {
    var r = gradeRank[arcade.gradeFor(85, d)];
    assert.ok(r <= prev, 'grade for 85% is monotonic non-increasing across difficulty');
    return r;
}, 5);

// --- 9. Commit-once: same phraseId twice is ignored ---
var c = arcade.createArcadeState('medium');
var first = arcade.commitPhrase(c, clear('once', 2, 4, 2));
var dup = arcade.commitPhrase(c, clear('once', 2, 4, 2));
assert.ok(first && first.pointsAwarded > 0, 'first commit pays');
assert.strictEqual(dup, null, 'duplicate commit returns null');
assert.strictEqual(c.points, first.pointsAwarded, 'duplicate does not double-count');

// --- 10. Perfect threshold = "all anchors" (default) ---
assert.strictEqual(arcade.isPerfect(4, 2, 4), true, 'all anchors hit = perfect');
assert.strictEqual(arcade.isPerfect(3, 2, 4), false, 'missing one anchor != perfect');
assert.strictEqual(arcade.isPerfect(0, 0, 0), false, 'no anchors = not perfect');

// --- 11. On Fire at max multiplier; cleared by a miss ---
var f = arcade.createArcadeState('easy'); // maxMultiplier 4
for (var n = 0; n < 20; n++) arcade.commitPhrase(f, clear('fp' + n, 1, 2, 1));
assert.strictEqual(f.multiplier, 4, 'easy caps at 4x');
assert.strictEqual(f.onFire, true, 'on fire at max multiplier');
arcade.commitPhrase(f, clear('fmiss', 1, 2, 0));
assert.strictEqual(f.onFire, false, 'miss clears on fire');
assert.strictEqual(f.multiplier, 1, 'miss drops multiplier to 1');

// --- 12. Summary shape ---
var sum = arcade.getArcadeSummary(r);
assert.ok(typeof sum.points === 'number');
assert.ok(typeof sum.maxMultiplier === 'number');
assert.ok(typeof sum.longestStreak === 'number');
assert.ok(typeof sum.perfects === 'number');

// --- 13. rampProgress is 0..1; full at max multiplier ---
assert.ok(arcade.rampProgress(r) >= 0 && arcade.rampProgress(r) <= 1, 'ramp progress in [0,1]');
var fp = arcade.createArcadeState('easy');
for (var q = 0; q < 20; q++) arcade.commitPhrase(fp, clear('qp' + q, 1, 2, 1));
assert.strictEqual(fp.multiplier, 4, 'reached max multiplier');
assert.strictEqual(arcade.rampProgress(fp), 1, 'ramp shows full at max multiplier');

console.log('test_scoring_arcade.cjs: all assertions passed');
