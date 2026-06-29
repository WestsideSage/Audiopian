var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load theme-helpers.js as a plain script (simulates browser <script> loading).
var filePath = path.join(__dirname, '..', 'static', 'theme-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var T = fakeModule.exports;

assert.strictEqual(T.THEME_STORAGE_KEY, 'audiopian-theme', 'stable storage key');

// Stored preference wins over OS.
assert.strictEqual(T.resolveInitialTheme({ stored: 'light', prefersLight: false }), 'light', 'stored light wins');
assert.strictEqual(T.resolveInitialTheme({ stored: 'dark', prefersLight: true }), 'dark', 'stored dark wins');

// No stored preference -> follow OS.
assert.strictEqual(T.resolveInitialTheme({ stored: null, prefersLight: true }), 'light', 'OS light');
assert.strictEqual(T.resolveInitialTheme({ stored: null, prefersLight: false }), 'dark', 'OS dark');

// Nothing known -> default dark (block-if-unsure: app's chosen default).
assert.strictEqual(T.resolveInitialTheme({}), 'dark', 'empty -> dark');
assert.strictEqual(T.resolveInitialTheme(), 'dark', 'no ctx -> dark');

// Junk stored value is ignored (falls through to OS/default).
assert.strictEqual(T.resolveInitialTheme({ stored: 'purple', prefersLight: true }), 'light', 'junk stored -> OS');
assert.strictEqual(T.resolveInitialTheme({ stored: 'purple' }), 'dark', 'junk stored, no OS -> dark');

// nextTheme toggles; anything not 'light' is treated as dark.
assert.strictEqual(T.nextTheme('dark'), 'light', 'dark -> light');
assert.strictEqual(T.nextTheme('light'), 'dark', 'light -> dark');
assert.strictEqual(T.nextTheme('whatever'), 'light', 'unknown -> light');

console.log('All theme-helpers tests passed.');
