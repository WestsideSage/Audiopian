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
var S = path.join(__dirname, '..', 'static');
function load(name, deps) {
    return loadBrowserCommonJs(path.join(S, name), Object.assign({
        require: function (spec) {
            var m = { './match-helpers.js': mh, './sync-helpers.js': sh,
                      './scoring.js': scoring, './phrase-engine.js': phrase,
                      './scoring-arcade.js': arcade }[spec];
            if (!m) throw new Error('Unexpected require: ' + spec);
            return m;
        }, globalThis: globalThis
    }, deps || {}));
}
var mh = loadBrowserCommonJs(path.join(S, 'match-helpers.js'));
var sh = loadBrowserCommonJs(path.join(S, 'sync-helpers.js'));
var scoring = load('scoring.js');
var phrase = load('phrase-engine.js');
var arcade = loadBrowserCommonJs(path.join(S, 'scoring-arcade.js'));
var session = load('scoring-session.js');

// Minimal one-line song; a single matching final should score the line.
function lyric(time, text) { return { time: time, text: text }; }
var cfg = {
    lyrics: [lyric(0, 'hello world')],
    allWordTimings: scoring.interpolateWordTimings([lyric(0, 'hello world')]),
    phrasePlan: null, difficulty: 'medium', flags: { KARAOKEE_V2: true }
};
var s = session.createSession(cfg);
var ev = session.setActiveLine(s, 0, 0.0);
session.ingestFinal(s, 'hello world', 'browser_sr');
var out = session.tick(s, 1.0);
var scored = out.filter(function (e) { return e.type === 'wordMatched'; });
assert.ok(scored.length >= 1, 'expected at least one wordMatched event for "hello world"');

console.log('Scoring session tests passed.');
