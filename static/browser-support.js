/**
 * Pure browser-support predicate for the desktop-Chrome interstitial. No DOM /
 * globals — the caller passes navigator.userAgent + a Web Speech capability flag,
 * so the support matrix is testable in Node.js.
 *
 * v1 target (ADR-0001): the FREE lane needs the Web Speech API, which ships only
 * in desktop Chrome / Edge. So: supported iff Web Speech is present AND the UA is
 * not mobile. Block-if-unsure — missing input returns false (better a clear "use
 * desktop Chrome" screen than a silently broken mic/scoring session).
 *
 * @param {Object} ctx
 * @param {string}  [ctx.userAgent]            navigator.userAgent.
 * @param {boolean} [ctx.hasSpeechRecognition] !!(window.SpeechRecognition || window.webkitSpeechRecognition).
 * @returns {boolean} true if the free lane can run here.
 */
function isSupportedBrowser(ctx) {
    ctx = ctx || {};
    if (!ctx.hasSpeechRecognition) return false;
    var ua = ctx.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
    return true;
}

// Node.js exports for testing; browser ignores this (function is a <script> global).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isSupportedBrowser: isSupportedBrowser };
}
