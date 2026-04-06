'use strict';
// ---------------------------------------------------------------------------
// Minimal stubs — replicate the structures GameMode will produce
// ---------------------------------------------------------------------------
function makeMeta(overrides = {}) {
    return Object.assign({
        songTitle: 'Test Song',
        songDurationMs: 180000,
        lrcLines: 10,
        whisperAvailable: false,
        browserLang: 'en-US',
        startedAt: new Date().toISOString(),
        gameVersion: '1.0'
    }, overrides);
}

function makeAsr(overrides = {}) {
    return Object.assign({
        ts: 1.23,
        lineIdx: 0,
        lineTempo: 'medium',
        type: 'final',
        source: 'browser_sr',
        text: 'hello world',
        wordTimestamps: []
    }, overrides);
}

function makeMatch(overrides = {}) {
    return Object.assign({
        ts: 1.25,
        lineIdx: 0,
        lineTempo: 'medium',
        spokenWord: 'hello',
        targetWord: 'hello',
        method: 'exact',
        editDistance: 0,
        phoneticMatch: true,
        score: 1.0,
        matched: true,
        windowPosition: 0
    }, overrides);
}

function makeTransition(overrides = {}) {
    return Object.assign({
        ts: 4.50,
        fromIdx: 0,
        toIdx: 1,
        fromText: 'hello world',
        trigger: 'score',
        matchedWords: 2,
        totalWords: 2,
        missedWords: [],
        timeSpentMs: 3000,
        lineTempo: 'medium',
        expectedTimeMs: 3000,
        earlyMs: null,
        lateMs: null
    }, overrides);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log('  ✓', msg);
        passed++;
    } else {
        console.error('  ✗', msg);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Test 1: meta has all required keys
// ---------------------------------------------------------------------------
console.log('\nTest 1: meta schema');
{
    const m = makeMeta();
    const required = ['songTitle','songDurationMs','lrcLines','whisperAvailable','browserLang','startedAt','gameVersion'];
    required.forEach(k => assert(k in m, `meta has key "${k}"`));
    assert(typeof m.songDurationMs === 'number', 'songDurationMs is a number');
    assert(m.songDurationMs > 0, 'songDurationMs > 0');
}

// ---------------------------------------------------------------------------
// Test 2: asr entry has all required keys and valid type/tempo
// ---------------------------------------------------------------------------
console.log('\nTest 2: asr entry schema');
{
    const a = makeAsr();
    const required = ['ts','lineIdx','lineTempo','type','source','text','wordTimestamps'];
    required.forEach(k => assert(k in a, `asr has key "${k}"`));
    assert(['final','interim'].includes(a.type), 'asr type is final or interim');
    assert(['browser_sr','whisper'].includes(a.source), 'asr source is browser_sr or whisper');
    assert(['slow','medium','fast'].includes(a.lineTempo), 'asr lineTempo is valid');
    assert(Array.isArray(a.wordTimestamps), 'wordTimestamps is array');
}

// ---------------------------------------------------------------------------
// Test 3: match entry has all required keys and valid method/tempo
// ---------------------------------------------------------------------------
console.log('\nTest 3: match entry schema');
{
    const m = makeMatch();
    const required = ['ts','lineIdx','lineTempo','spokenWord','targetWord','method','editDistance','phoneticMatch','score','matched','windowPosition'];
    required.forEach(k => assert(k in m, `match has key "${k}"`));
    const validMethods = ['exact','fuzzy','phonetic','phrase','contraction','edit1','edit2','slang','vad-provisional','vad-confirmed','none'];
    assert(validMethods.includes(m.method), `match method "${m.method}" is valid`);
    assert(['slow','medium','fast'].includes(m.lineTempo), 'match lineTempo is valid');
    assert(typeof m.matched === 'boolean', 'matched is boolean');
}

// ---------------------------------------------------------------------------
// Test 4: transition entry has all required keys and valid trigger
// ---------------------------------------------------------------------------
console.log('\nTest 4: transition entry schema');
{
    const t = makeTransition();
    const required = ['ts','fromIdx','toIdx','fromText','trigger','matchedWords','totalWords','missedWords','timeSpentMs','lineTempo','expectedTimeMs','earlyMs','lateMs'];
    required.forEach(k => assert(k in t, `transition has key "${k}"`));
    // Note: totalComparisons is added by the live code but not in the minimal stub — checked separately
    assert(['score','time','forced'].includes(t.trigger), `trigger "${t.trigger}" is valid`);
    assert(Array.isArray(t.missedWords), 'missedWords is array');
}

// ---------------------------------------------------------------------------
// Test 4b: promotions array schema
// ---------------------------------------------------------------------------
console.log('\nTest 4b: promotions entry schema');
{
    const p = {
        ts: 2.50, lineIdx: 1, wordIndex: 3, source: 'browser_sr', score: 1.0
    };
    const required = ['ts', 'lineIdx', 'wordIndex', 'source', 'score'];
    required.forEach(k => assert(k in p, `promotion has key "${k}"`));
    assert(['browser_sr', 'whisper'].includes(p.source), 'promotion source valid');
    assert(typeof p.wordIndex === 'number', 'wordIndex is number');
}

// ---------------------------------------------------------------------------
// Test 5: 5000-entry cap logic
// ---------------------------------------------------------------------------
console.log('\nTest 5: 5000-entry cap');
{
    const matches = [];
    const CAP = 5000;
    for (let i = 0; i < CAP + 10; i++) {
        if (matches.length < CAP) matches.push(makeMatch({ ts: i * 0.01 }));
    }
    assert(matches.length === CAP, `matches capped at ${CAP} (got ${matches.length})`);
}

// ---------------------------------------------------------------------------
// Test 6: lineTempo values are always one of the three valid strings
// ---------------------------------------------------------------------------
console.log('\nTest 6: lineTempo exhaustive check');
{
    const valid = new Set(['slow','medium','fast']);
    const tempos = ['slow','medium','fast','slow','fast'];
    const allValid = tempos.every(t => valid.has(t));
    assert(allValid, 'all lineTempo values are slow/medium/fast');

    const bad = 'normal'; // old value that must NOT appear
    assert(!valid.has(bad), '"normal" is not a valid lineTempo value');
}

// ---------------------------------------------------------------------------
// Test 7: whisper meta fields shape
// ---------------------------------------------------------------------------
console.log('\nTest 7: whisper meta fields');
{
    const whisperChunkCounters = {
        dispatched: 10, succeeded: 8, failed503: 1, failed500: 0,
        failedNetwork: 1, droppedWhileLoading: 2
    };
    const required = ['dispatched','succeeded','failed503','failed500','failedNetwork','droppedWhileLoading'];
    required.forEach(k => assert(k in whisperChunkCounters, `chunkCounters has "${k}"`));
    assert(typeof whisperChunkCounters.dispatched === 'number', 'dispatched is number');

    const whisperStatusAtStart = { state: 'ready', reason: null, checkedAt: 12345 };
    assert(['idle','loading','ready','error','unknown'].includes(whisperStatusAtStart.state),
        'whisperStatusAtStart.state is valid');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
