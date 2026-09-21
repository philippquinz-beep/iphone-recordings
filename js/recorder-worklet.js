/* Mikrofon-Abgriff als rohes PCM.
   Sammelt Frames zu Blöcken und schickt sie an den Hauptthread. */

const BLOCK = 2048;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(BLOCK);
    this.fill = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== 'recording') return;
      if (m.value) {
        this.fill = 0;
        this.on = true;
      } else {
        this.on = false;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  flush() {
    if (this.fill === 0) return;
    const out = this.buf.slice(0, this.fill);
    this.fill = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    if (this.on) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) {
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.fill++] = ch[i];
          if (this.fill === BLOCK) this.flush();
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
