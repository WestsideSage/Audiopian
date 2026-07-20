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

function summarize(targets) {
    var result = { filesSeen: 0, analyzedRuns: 0, skippedUiTests: 0, invalidFiles: 0 };
    targets.flatMap(jsonFiles).forEach(function (file) {
        result.filesSeen++;
        try {
            var payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!telemetry.shouldAnalyzeRun(payload)) result.skippedUiTests++;
            else result.analyzedRuns++;
        } catch (error) {
            result.invalidFiles++;
        }
    });
    return result;
}

if (require.main === module) {
    var targets = process.argv.slice(2);
    if (!targets.length) targets = [path.join(__dirname, '..', 'output_telemetry')];
    process.stdout.write(JSON.stringify(summarize(targets), null, 2) + '\n');
}

module.exports = { jsonFiles: jsonFiles, summarize: summarize };
