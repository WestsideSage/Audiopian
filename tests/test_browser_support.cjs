var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load browser-support.js as a plain script (simulates browser <script> loading).
// Parent package.json is "type": "module", so require() would treat .js as ESM.
var filePath = path.join(__dirname, '..', 'static', 'browser-support.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var isSupportedBrowser = fakeModule.exports.isSupportedBrowser;

// Real-world UA strings for the support matrix.
var CHROME_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var EDGE_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
var FIREFOX_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';
var CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
var IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
var IPAD_SAFARI = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// SUPPORTED: desktop Chrome / Edge with Web Speech.
assert.strictEqual(isSupportedBrowser({ userAgent: CHROME_DESKTOP, hasSpeechRecognition: true }), true, 'Chrome desktop + SR -> supported');
assert.strictEqual(isSupportedBrowser({ userAgent: EDGE_DESKTOP, hasSpeechRecognition: true }), true, 'Edge desktop + SR -> supported');

// UNSUPPORTED: no Web Speech (Firefox/Safari desktop), even on a desktop UA.
assert.strictEqual(isSupportedBrowser({ userAgent: FIREFOX_DESKTOP, hasSpeechRecognition: false }), false, 'Firefox desktop (no SR) -> unsupported');
assert.strictEqual(isSupportedBrowser({ userAgent: CHROME_DESKTOP, hasSpeechRecognition: false }), false, 'no SR -> unsupported regardless of UA');

// UNSUPPORTED: mobile, even mobile Chrome that reports SR (app is desktop-only).
assert.strictEqual(isSupportedBrowser({ userAgent: CHROME_ANDROID, hasSpeechRecognition: true }), false, 'Android Chrome -> unsupported (mobile)');
assert.strictEqual(isSupportedBrowser({ userAgent: IPHONE_SAFARI, hasSpeechRecognition: true }), false, 'iPhone -> unsupported (mobile)');
assert.strictEqual(isSupportedBrowser({ userAgent: IPAD_SAFARI, hasSpeechRecognition: true }), false, 'iPad -> unsupported (mobile)');

// Defensive: block-if-unsure (missing/empty input -> unsupported, not a broken session).
assert.strictEqual(isSupportedBrowser({}), false, 'empty ctx -> unsupported');
assert.strictEqual(isSupportedBrowser(), false, 'no ctx -> unsupported');
assert.strictEqual(isSupportedBrowser({ hasSpeechRecognition: true }), true, 'SR + no UA string -> supported (UA absent, not mobile)');

console.log('All browser-support tests passed.');
