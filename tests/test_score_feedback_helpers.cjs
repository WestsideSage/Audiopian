var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load score-feedback-helpers.js as a plain script (simulates browser <script>
// loading). Parent package.json is "type": "module", so require() would treat
// a static/*.js file as ESM — mirror the new Function loader from
// tests/test_browser_support.cjs instead.
var filePath = path.join(__dirname, '..', 'static', 'score-feedback-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var SF = fakeModule.exports;

// ── formatPointsGain ─────────────────────────────────────────────────
// positive ints -> '+' + thousands-grouped
assert.strictEqual(SF.formatPointsGain(250), '+250', '250 -> +250');
assert.strictEqual(SF.formatPointsGain(1250), '+1,250', '1250 -> +1,250');
assert.strictEqual(SF.formatPointsGain(1), '+1', '1 -> +1');
assert.strictEqual(SF.formatPointsGain(999), '+999', '999 -> +999 (no group under 1000)');
assert.strictEqual(SF.formatPointsGain(1000), '+1,000', '1000 -> +1,000 (group boundary)');
assert.strictEqual(SF.formatPointsGain(1234567), '+1,234,567', 'multi-group grouping');
// zero / negative / non-finite -> '' (nothing to celebrate)
assert.strictEqual(SF.formatPointsGain(0), '', '0 -> empty');
assert.strictEqual(SF.formatPointsGain(-5), '', 'negative -> empty');
assert.strictEqual(SF.formatPointsGain(NaN), '', 'NaN -> empty');
assert.strictEqual(SF.formatPointsGain(Infinity), '', 'Infinity -> empty');
assert.strictEqual(SF.formatPointsGain(-Infinity), '', '-Infinity -> empty');
assert.strictEqual(SF.formatPointsGain(undefined), '', 'undefined -> empty');
assert.strictEqual(SF.formatPointsGain(null), '', 'null -> empty');
// fractional positive -> floored, then grouped (defensive; awarded points are ints)
assert.strictEqual(SF.formatPointsGain(250.9), '+250', 'fractional floored to +250');

// ── countUpValue ─────────────────────────────────────────────────────
// exact endpoints (contract)
assert.strictEqual(SF.countUpValue(0, 1000, 0), 0, 't=0 -> from');
assert.strictEqual(SF.countUpValue(0, 1000, 1), 1000, 't=1 -> to');
assert.strictEqual(SF.countUpValue(500, 500, 0), 500, 'equal endpoints, t=0');
assert.strictEqual(SF.countUpValue(500, 500, 1), 500, 'equal endpoints, t=1');
assert.strictEqual(SF.countUpValue(200, 1700, 0), 200, 'nonzero from, t=0');
assert.strictEqual(SF.countUpValue(200, 1700, 1), 1700, 'nonzero from, t=1');
// result is an integer at intermediate t
var midVal = SF.countUpValue(0, 1000, 0.5);
assert.strictEqual(midVal, Math.round(midVal), 'mid value is an integer');
// ease-out: at the midpoint, an out-curve is already PAST halfway
assert.ok(midVal > 500, 'ease-out is past halfway at t=0.5 (got ' + midVal + ')');
assert.ok(midVal < 1000, 'mid value below the endpoint');
// monotonic non-decreasing across the sweep
var prev = SF.countUpValue(0, 1000, 0);
for (var i = 1; i <= 10; i++) {
    var cur = SF.countUpValue(0, 1000, i / 10);
    assert.ok(cur >= prev, 'monotonic non-decreasing at t=' + (i / 10) + ' (' + cur + ' >= ' + prev + ')');
    prev = cur;
}
// clamps t outside [0,1] back to the endpoints
assert.strictEqual(SF.countUpValue(0, 1000, -0.5), 0, 't<0 clamps to from');
assert.strictEqual(SF.countUpValue(0, 1000, 1.5), 1000, 't>1 clamps to to');

// ── countUpDurationMs ────────────────────────────────────────────────
assert.strictEqual(SF.countUpDurationMs(0), 300, 'delta 0 -> floor 300');
assert.strictEqual(SF.countUpDurationMs(250), 400, '300 + 250*0.4 = 400');
assert.strictEqual(SF.countUpDurationMs(-250), 400, 'abs() -> negative delta same as positive');
assert.strictEqual(SF.countUpDurationMs(1000), 700, '300 + 1000*0.4 = 700');
assert.strictEqual(SF.countUpDurationMs(2250), 1200, '300 + 2250*0.4 = 1200 (exact cap)');
assert.strictEqual(SF.countUpDurationMs(100000), 1200, 'huge delta clamps to 1200');
assert.strictEqual(SF.countUpDurationMs(1), 300, 'round(300.4)=300');
assert.strictEqual(SF.countUpDurationMs(2), 301, 'round(300.8)=301');

// ── lineVerdict ──────────────────────────────────────────────────────
// boundaries
assert.strictEqual(SF.lineVerdict(4, 4), 'perfect', 'full score -> perfect');
assert.strictEqual(SF.lineVerdict(5, 4), 'perfect', 'over-full (r>1) -> perfect');
assert.strictEqual(SF.lineVerdict(3, 4), 'nice', 'exactly 0.75 -> nice');
assert.strictEqual(SF.lineVerdict(0.75, 1), 'nice', 'r=0.75 boundary -> nice');
assert.strictEqual(SF.lineVerdict(74, 100), 'partial', 'just under 0.75 -> partial');
assert.strictEqual(SF.lineVerdict(1, 100), 'partial', 'r just above 0 -> partial');
assert.strictEqual(SF.lineVerdict(0, 4), 'miss', 'zero score -> miss');
// maxScore <= 0 -> r forced to 0 -> miss (no divide-by-zero)
assert.strictEqual(SF.lineVerdict(0, 0), 'miss', 'maxScore 0 -> miss');
assert.strictEqual(SF.lineVerdict(3, 0), 'miss', 'maxScore 0 with score -> miss (r=0)');
assert.strictEqual(SF.lineVerdict(3, -4), 'miss', 'negative maxScore -> miss (r=0)');

// ── milestoneForStreak ───────────────────────────────────────────────
assert.strictEqual(SF.milestoneForStreak(9), null, '9 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(10), '10 STREAK', '10 -> milestone');
assert.strictEqual(SF.milestoneForStreak(11), null, '11 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(24), null, '24 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(25), '25 STREAK', '25 -> milestone');
assert.strictEqual(SF.milestoneForStreak(50), '50 STREAK', '50 -> milestone');
assert.strictEqual(SF.milestoneForStreak(51), null, '51 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(0), null, '0 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(100), null, '100 (not in set) -> no milestone');

// ── tierUpLabel ──────────────────────────────────────────────────────
assert.strictEqual(SF.tierUpLabel(1, 2), '2x', 'increase -> "2x"');
assert.strictEqual(SF.tierUpLabel(2, 4), '4x', 'increase to 4x');
assert.strictEqual(SF.tierUpLabel(2, 2), null, 'equal -> null (no tier-up)');
assert.strictEqual(SF.tierUpLabel(4, 2), null, 'decrease -> null');
assert.strictEqual(SF.tierUpLabel(1, 1), null, 'equal at 1 -> null');
assert.strictEqual(SF.tierUpLabel(0, 1), '1x', 'rise from 0 -> "1x"');

console.log('All score-feedback-helpers tests passed.');
