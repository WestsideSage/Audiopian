var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'key-store.js'), 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var KS = fakeModule.exports;

// fake localStorage
function makeStorage() {
    var m = {};
    return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
        setItem: function (k, v) { m[k] = String(v); },
        removeItem: function (k) { delete m[k]; },
    };
}
var st = makeStorage();
var deps = { storage: st };

assert.strictEqual(KS.getKey(deps), '');
assert.strictEqual(KS.recognizerMode(deps), 'free');

KS.setKey('  sk-abc123  ', deps);
assert.strictEqual(KS.getKey(deps), 'sk-abc123', 'trims on set');
assert.strictEqual(KS.recognizerMode(deps), 'premium');

KS.clearKey(deps);
assert.strictEqual(KS.getKey(deps), '');
assert.strictEqual(KS.recognizerMode(deps), 'free');

console.log('All key-store tests passed.');
