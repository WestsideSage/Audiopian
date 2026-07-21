#!/usr/bin/env node
'use strict';

var fs = require('node:fs');
var path = require('node:path');
var telemetry = require('../static/telemetry-helpers.js');

function jsonFiles(target) {
    if (!fs.existsSync(target)) return [];
    var stat = fs.statSync(target);
    if (stat.isFile()) return path.extname(target).toLowerCase() === '.json' ? [target] : [];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(function (entry) {
        return jsonFiles(path.join(target, entry.name));
    });
}

var RUN_COLUMNS = [
    'file', 'sizeBytes', 'schemaVersion', 'profile', 'startedAt', 'song', 'difficulty',
    'provider', 'intent', 'completed', 'honestLyricPct', 'composite', 'points', 'grade',
    'maxMultiplier', 'clears', 'partials', 'misses', 'neutral', 'voicedMisses',
    'lateCredits', 'suspectedCheeseInflation'
];

function runRow(payload, file, sizeBytes) {
    payload = payload || {};
    var meta = payload.meta || {};
    var summary = payload.summary || {};
    var scores = summary.scores || {};
    var arcade = summary.arcade || {};
    var honesty = summary.honesty || {};
    var v3Outcomes = payload.analysis && payload.analysis.phraseOutcomes;
    var v2Outcomes = summary.phraseOutcomes || {};
    var flags = payload.analysis && payload.analysis.flagCounts || {};
    return {
        file: file,
        sizeBytes: sizeBytes || 0,
        schemaVersion: Number(meta.schemaVersion || 0),
        profile: meta.telemetryProfile || 'legacy',
        startedAt: meta.startedAt || '',
        song: meta.songTitle || '',
        difficulty: summary.difficulty || (payload.phraseEngine && payload.phraseEngine.difficulty) || '',
        provider: meta.whisperProvider || (meta.whisperStatusFinal && meta.whisperStatusFinal.provider) || '',
        intent: honesty.benchmarkIntent || '',
        completed: !!meta.completed,
        honestLyricPct: scores.honestLyricPct == null ? null : scores.honestLyricPct,
        composite: scores.composite == null ? null : scores.composite,
        points: arcade.points == null ? null : arcade.points,
        grade: arcade.grade || '',
        maxMultiplier: arcade.maxMultiplier == null ? null : arcade.maxMultiplier,
        clears: v3Outcomes ? (v3Outcomes.clear || 0) : (v2Outcomes.cleared || 0),
        partials: v3Outcomes ? (v3Outcomes.partial || 0) : (v2Outcomes.partial || 0),
        misses: v3Outcomes ? (v3Outcomes.miss || 0) : (v2Outcomes.missed || 0),
        neutral: v3Outcomes ? (v3Outcomes.neutral || 0) : 0,
        voicedMisses: flags.voiced_miss || 0,
        lateCredits: flags.late_credit || 0,
        suspectedCheeseInflation: !!honesty.suspectedCheeseInflation
    };
}

function csvCell(value) {
    if (value == null) return '';
    if (typeof value === 'string') return '"' + value.replace(/"/g, '""') + '"';
    return String(value);
}

function toCsv(rows) {
    return RUN_COLUMNS.join(',') + '\n' + (rows || []).map(function (row) {
        return RUN_COLUMNS.map(function (key) { return csvCell(row[key]); }).join(',');
    }).join('\n') + '\n';
}

function summarize(targets) {
    var result = {
        filesSeen: 0, analyzedRuns: 0, skippedUiTests: 0, invalidFiles: 0,
        totalBytes: 0, schemaVersions: {}, profiles: {}, runs: []
    };
    targets.flatMap(jsonFiles).forEach(function (file) {
        result.filesSeen++;
        try {
            var payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!telemetry.shouldAnalyzeRun(payload)) result.skippedUiTests++;
            else {
                var sizeBytes = fs.statSync(file).size;
                var row = runRow(payload, file, sizeBytes);
                result.analyzedRuns++;
                result.totalBytes += sizeBytes;
                result.schemaVersions[row.schemaVersion] = (result.schemaVersions[row.schemaVersion] || 0) + 1;
                result.profiles[row.profile] = (result.profiles[row.profile] || 0) + 1;
                result.runs.push(row);
            }
        } catch (error) {
            result.invalidFiles++;
        }
    });
    result.runs.sort(function (a, b) { return a.startedAt.localeCompare(b.startedAt) || a.file.localeCompare(b.file); });
    return result;
}

if (require.main === module) {
    var args = process.argv.slice(2);
    var csv = args.indexOf('--csv') >= 0;
    var targets = args.filter(function (arg) { return arg !== '--csv'; });
    if (!targets.length) targets = [path.join(__dirname, '..', 'output_telemetry')];
    var report = summarize(targets);
    process.stdout.write(csv ? toCsv(report.runs) : JSON.stringify(report, null, 2) + '\n');
}

module.exports = { RUN_COLUMNS: RUN_COLUMNS, jsonFiles: jsonFiles, runRow: runRow, summarize: summarize, toCsv: toCsv };
