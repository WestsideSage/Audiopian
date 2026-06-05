const assert = require('assert');
const H = require('../static/commit-helpers.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

// capMsForTempo
check('capMsForTempo maps tempo classes', () => {
  assert.strictEqual(H.capMsForTempo('fast'), 1500);
  assert.strictEqual(H.capMsForTempo('slow'), 2500);
  assert.strictEqual(H.capMsForTempo('normal'), 2000);
  assert.strictEqual(H.capMsForTempo('medium'), 2000); // relative-tempo class
  assert.strictEqual(H.capMsForTempo(undefined), 2000);
});

// speech-end commits when there was speech
check('speech-end fires a commit after speech', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.noteSpeechEnd(s, 1500).commit, true);
});

// empty-buffer guard: no speech since last commit -> no commit
check('speech-end without speech-since-commit does not commit', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s, 1500);     // commits (speech happened)
  H.noteCommitted(s, 1500);     // speaking=false -> speechSinceCommit cleared
  assert.strictEqual(H.noteSpeechEnd(s, 2000).commit, false); // no new speech
});

// cap fires on continuous speech past the cap, not before
check('cap fires only after the tempo cap elapses', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.checkCap(s, 2400, 'fast').commit, false); // 1400 < 1500
  assert.strictEqual(H.checkCap(s, 2600, 'fast').commit, true);  // 1600 >= 1500
});

// cap does not fire when not speaking
check('cap does not fire when silent', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s, 1500);
  assert.strictEqual(H.checkCap(s, 9000, 'fast').commit, false);
});

// no double-commit: after a speech-end commit, cap stays quiet
check('no double-commit after speech-end', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s, 1500);
  H.noteCommitted(s, 1500);
  assert.strictEqual(H.checkCap(s, 5000, 'fast').commit, false);
});

// min inter-commit guard: a cap commit immediately followed by speech-end must NOT
// emit a tiny fragment — the guard defers it (the advisor's #3 fix).
check('min inter-commit guard defers a too-soon speech-end', () => {
  const s = H.createCommitState(); // minInterCommitMs = 350
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.checkCap(s, 2600, 'fast').commit, true); // cap commit
  H.noteCommitted(s, 2600);
  assert.strictEqual(H.noteSpeechEnd(s, 2700).commit, false);   // 100ms later -> deferred
});

// mid-speech cap commit is periodic; a later end (past the guard) still commits
check('mid-speech cap commit is periodic; later end still commits', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.checkCap(s, 2600, 'fast').commit, true); // first cap
  H.noteCommitted(s, 2600);                                     // still speaking
  assert.strictEqual(H.checkCap(s, 2700, 'fast').commit, false);// too soon
  assert.strictEqual(H.checkCap(s, 4200, 'fast').commit, true); // next window
  H.noteCommitted(s, 4200);
  assert.strictEqual(H.noteSpeechEnd(s, 4600).commit, true);    // 400ms later -> commits
});

console.log('commit-helpers: ' + passed + ' checks passed');
