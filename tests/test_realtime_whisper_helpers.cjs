const assert = require('assert');
const realtime = require('../static/realtime-whisper.js');

function testFloat32ToPcm16Base64ClampsAndEncodes() {
  const encoded = realtime.float32ToPcm16Base64(new Float32Array([-1, 0, 1]));
  const bytes = Buffer.from(encoded, 'base64');

  assert.strictEqual(bytes.length, 6);
  assert.strictEqual(bytes.readInt16LE(0), -32768);
  assert.strictEqual(bytes.readInt16LE(2), 0);
  assert.strictEqual(bytes.readInt16LE(4), 32767);
}

function testBuildAppendAudioEvent() {
  const event = realtime.buildAppendAudioEvent('abc123');

  assert.deepStrictEqual(event, {
    type: 'input_audio_buffer.append',
    audio: 'abc123',
  });
}

function testBuildSessionUpdateEvent() {
  const event = realtime.buildSessionUpdateEvent({
    model: 'gpt-realtime-whisper',
    prompt: 'lyrics vocabulary',
  });

  assert.deepStrictEqual(event, {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: 'gpt-realtime-whisper',
            language: 'en',
          },
        },
      },
      include: ['item.input_audio_transcription.logprobs'],
    },
  });
}

function testBuildSessionUpdateEventKeepsPromptForSupportedModels() {
  const event = realtime.buildSessionUpdateEvent({
    model: 'gpt-4o-mini-transcribe',
    prompt: 'lyrics vocabulary',
  });

  assert.strictEqual(
    event.session.audio.input.transcription.prompt,
    'lyrics vocabulary'
  );
}

function testExtractClientSecret() {
  assert.strictEqual(
    realtime.extractClientSecret({ client_secret: { value: 'ek_test' } }),
    'ek_test'
  );
  assert.strictEqual(
    realtime.extractClientSecret({ value: 'ek_direct' }),
    'ek_direct'
  );
  assert.throws(() => realtime.extractClientSecret({}), /client_secret/);
}

testFloat32ToPcm16Base64ClampsAndEncodes();
testBuildAppendAudioEvent();
testBuildSessionUpdateEvent();
testBuildSessionUpdateEventKeepsPromptForSupportedModels();
testExtractClientSecret();
console.log('realtime whisper helper tests passed');
