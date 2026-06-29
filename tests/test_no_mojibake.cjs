// Regression guard: the static assets must stay clean UTF-8, with no stray BOM
// and no double-encoded "mojibake". On this Windows toolchain an editor/tool once
// re-read UTF-8 as Windows-1252 and re-saved it, turning "—" into "â€"" across
// static/player.html and static/style.css. This test fails loudly if that recurs.
//
// Run: node tests/test_no_mojibake.cjs
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var staticDir = path.join(__dirname, '..', 'static');
var EXTS = ['.html', '.css', '.js', '.svg'];
var SKIP_DIRS = ['vendor']; // third-party (vendored VAD) — not ours to police

// Lead-byte pairs that signal UTF-8 re-encoded from Windows-1252: the high
// typographic chars (—, …, "", –, ─, ×) all double-encode to a byte starting
// 0xC3 0x82 (Â…) / 0xC3 0x83 (Ã…) / 0xC3 0xA2 (â…). Clean middle-dot · is
// 0xC2 0xB7 and is deliberately NOT matched.
var MOJIBAKE = [
    Buffer.from([0xc3, 0x82]),
    Buffer.from([0xc3, 0x83]),
    Buffer.from([0xc3, 0xa2])
];
var BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function walk(dir) {
    var out = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.indexOf(e.name) === -1) out = out.concat(walk(path.join(dir, e.name)));
        } else if (EXTS.indexOf(path.extname(e.name)) !== -1) {
            out.push(path.join(dir, e.name));
        }
    });
    return out;
}

var files = walk(staticDir);
assert.ok(files.length > 0, 'expected to find static assets to scan');

var problems = [];
files.forEach(function (f) {
    var buf = fs.readFileSync(f);
    var rel = path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
    if (buf.length >= 3 && buf.slice(0, 3).equals(BOM)) {
        problems.push(rel + ' starts with a UTF-8 BOM');
    }
    MOJIBAKE.forEach(function (sig) {
        if (buf.indexOf(sig) !== -1) {
            problems.push(rel + ' contains mojibake byte sequence 0x' + sig.toString('hex'));
        }
    });
});

assert.strictEqual(
    problems.length, 0,
    'static assets must be clean UTF-8 (no BOM / mojibake):\n  ' + problems.join('\n  ')
);
console.log('All no-mojibake guard checks passed (' + files.length + ' static files scanned).');
