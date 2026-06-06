/**
 * Playback-source adapter. Lets player.js drive either a plain <audio> element
 * (uploaded local files, dev) or the YouTube IFrame player behind one duck-typed
 * contract, so the scoring/UI code is source-agnostic.
 *
 * Contract (both AudioElementSource and YouTubeIframeSource return this shape):
 *   play(): Promise|void   // begin playback. For UNMUTED audio, MUST be called from a user gesture.
 *   pause(): void
 *   seek(seconds): void
 *   currentTime(): number  // seconds; 0 when unknown
 *   duration(): number     // seconds; 0 when not yet loaded
 *   isPaused(): boolean
 *   setVolume(v): void     // v in [0,1]
 *   onReady(cb): void      // cb() once ready to play
 *   onEnded(cb): void      // cb() at end of media
 *   onState(cb): void      // cb(state); state in 'unstarted'|'playing'|'paused'|'buffering'|'cued'|'ended'
 *   destroy(): void
 */
function AudioElementSource(el) {
    var ready = [], ended = [], stateCbs = [];
    function emit(list, arg) { for (var i = 0; i < list.length; i++) list[i](arg); }
    el.addEventListener('canplay', function () { emit(ready); });
    el.addEventListener('ended', function () { emit(ended); });
    el.addEventListener('playing', function () { emit(stateCbs, 'playing'); });
    el.addEventListener('pause', function () { emit(stateCbs, 'paused'); });
    el.addEventListener('waiting', function () { emit(stateCbs, 'buffering'); });
    return {
        play: function () { return el.play(); },
        pause: function () { el.pause(); },
        seek: function (t) { el.currentTime = t; },
        currentTime: function () { return isFinite(el.currentTime) ? el.currentTime : 0; },
        duration: function () { return isFinite(el.duration) ? el.duration : 0; },
        isPaused: function () { return !!el.paused; },
        setVolume: function (v) { el.volume = v; },
        onReady: function (cb) { ready.push(cb); },
        onEnded: function (cb) { ended.push(cb); },
        onState: function (cb) { stateCbs.push(cb); },
        destroy: function () { try { el.pause(); } catch (e) {} }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AudioElementSource };
}
