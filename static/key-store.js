/**
 * BYO-key store + recognizer-mode decision. Replaces server provider resolution
 * for the deployed app: a stored OpenAI key -> 'premium', else 'free'.
 * `deps.storage` injectable for tests; defaults to window.localStorage.
 */
var KEY_STORAGE = 'openai_api_key';

function _store(deps) {
    if (deps && deps.storage) return deps.storage;
    if (typeof localStorage !== 'undefined') return localStorage;
    return null;
}

function getKey(deps) {
    var s = _store(deps);
    return s ? (s.getItem(KEY_STORAGE) || '') : '';
}

function setKey(k, deps) {
    var s = _store(deps);
    if (s) s.setItem(KEY_STORAGE, String(k || '').trim());
}

function clearKey(deps) {
    var s = _store(deps);
    if (s) s.removeItem(KEY_STORAGE);
}

function recognizerMode(deps) {
    return getKey(deps) ? 'premium' : 'free';
}

var KaraokeeKeyStore = { getKey: getKey, setKey: setKey, clearKey: clearKey, recognizerMode: recognizerMode };
if (typeof window !== 'undefined') window.KaraokeeKeyStore = KaraokeeKeyStore;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeKeyStore;
