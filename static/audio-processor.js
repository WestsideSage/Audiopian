/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * chunks to the main thread. Chunk size is dynamically adjustable via
 * port messages. Also posts RMS energy level every ~100ms (1600 samples)
 * for voice activity detection.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // default: 2 seconds at 16000 Hz
        this._energyBuf = [];
        this._energyTarget = 1600; // ~100ms at 16kHz

        // Listen for dynamic chunk size changes
        this.port.onmessage = function(e) {
            if (e.data && e.data.type === 'setChunkSize' && typeof e.data.samples === 'number') {
                this._target = Math.max(1600, Math.min(64000, e.data.samples)); // clamp to 0.1s-4s
            }
        }.bind(this);
    }

    process(inputs) {
        var channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (var i = 0; i < channel.length; i++) {
            this._buf.push(channel[i]);
            this._energyBuf.push(channel[i]);
        }

        // Post energy level every ~100ms for voice activity detection
        if (this._energyBuf.length >= this._energyTarget) {
            var samples = this._energyBuf.splice(0, this._energyTarget);
            var sumSq = 0;
            for (var i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
            var rms = Math.sqrt(sumSq / samples.length);
            this.port.postMessage({ type: 'energy', rms: rms });
        }

        // Post audio chunk when buffer reaches target
        if (this._buf.length >= this._target) {
            var chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage({ type: 'chunk', data: chunk });
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
