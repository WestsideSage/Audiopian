var assert = require('node:assert');
var report = require('../scripts/summarize-telemetry.cjs');

var v3 = {
    meta: {
        schemaVersion: 3, telemetryProfile: 'compact', songTitle: 'Artist — Song',
        startedAt: '2026-07-20T20:00:00Z', completed: true, whisperProvider: 'browser_sr'
    },
    summary: {
        difficulty: 'expert', scores: { honestLyricPct: 91, composite: 88 },
        arcade: { points: 12000, grade: 'A', maxMultiplier: 6 },
        honesty: { benchmarkIntent: 'good_expert_run', suspectedCheeseInflation: false }
    },
    analysis: {
        phraseOutcomes: { clear: 8, partial: 1, miss: 1, neutral: 2 },
        flagCounts: { voiced_miss: 1, late_credit: 3 }
    }
};
var row3 = report.runRow(v3, 'v3.json', 1234);
assert.deepStrictEqual(row3, {
    file: 'v3.json', sizeBytes: 1234, schemaVersion: 3, profile: 'compact',
    startedAt: '2026-07-20T20:00:00Z', song: 'Artist — Song', difficulty: 'expert',
    provider: 'browser_sr', intent: 'good_expert_run', completed: true,
    honestLyricPct: 91, composite: 88, points: 12000, grade: 'A', maxMultiplier: 6,
    clears: 8, partials: 1, misses: 1, neutral: 2, voicedMisses: 1, lateCredits: 3,
    suspectedCheeseInflation: false
});

var v2 = {
    meta: { schemaVersion: 2, songTitle: 'Old Song', startedAt: '2026-06-01', completed: false },
    summary: {
        difficulty: 'medium', scores: { honestLyricPct: 55, composite: 50 },
        arcade: { points: 400, grade: 'D', maxMultiplier: 2 },
        phraseOutcomes: { cleared: 2, partial: 3, missed: 4 },
        honesty: { benchmarkIntent: '', suspectedCheeseInflation: true }
    }
};
var row2 = report.runRow(v2, 'v2.json', 99);
assert.strictEqual(row2.profile, 'legacy');
assert.deepStrictEqual([row2.clears, row2.partials, row2.misses, row2.neutral], [2, 3, 4, 0]);

var csv = report.toCsv([row3]);
assert.ok(csv.startsWith('file,sizeBytes,schemaVersion,profile,'), 'CSV exposes stable analyst columns');
assert.ok(csv.includes('"Artist — Song"'), 'CSV quotes string values');
assert.ok(csv.includes(',91,88,12000,'), 'CSV includes score columns');

console.log('test_telemetry_report.cjs: all assertions passed');
