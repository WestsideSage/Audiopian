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
        this._overlapEnabled = false;
        this._overlapBuf = [];
        this._overlapTarget = 16000;
        this._overlapPhase = 0;

        // Listen for dynamic chunk size changes
        this.port.onmessage = function(e) {
            if (e.data && e.data.type === 'setChunkSize' && typeof e.data.samples === 'number') {
                this._target = Math.max(1600, Math.min(64000, e.data.samples)); // clamp to 0.1s-4s
            } else if (e.data && e.data.type === 'flush') {
                if (this._buf.length >= 1600) {
                    var chunk = new Float32Array(this._buf.splice(0, this._buf.length));
                    this.port.postMessage({ type: 'chunk', data: chunk });
                } else {
                    this._buf.length = 0;
                }
            } else if (e.data && e.data.type === 'enableOverlap') {
                this._overlapEnabled = !!e.data.enabled;
                this._overlapBuf = [];
                this._overlapTarget = Math.floor(this._target / 2);
                this._overlapPhase = 0;
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

        // Overlap chunks for fast sections
        if (this._overlapEnabled) {
            for (var i = 0; i < channel.length; i++) {
                this._overlapBuf.push(channel[i]);
            }
            this._overlapPhase += channel.length;
            if (this._overlapPhase >= this._overlapTarget && this._overlapBuf.length >= this._target) {
                var chunk = new Float32Array(this._overlapBuf.splice(0, this._target));
                this.port.postMessage({ type: 'overlap-chunk', data: chunk });
                this._overlapPhase = 0;
            }
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
