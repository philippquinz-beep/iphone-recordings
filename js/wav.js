/* WAV-Export (16 Bit, Mono) – zum Sichern oder Weitergeben. */

function putAscii(dv, offset, text) {
  for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(samples, length, sampleRate) {
  const dataBytes = length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);

  putAscii(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  putAscii(dv, 8, 'WAVE');

  putAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);        // Länge des fmt-Blocks
  dv.setUint16(20, 1, true);         // PCM
  dv.setUint16(22, 1, true);         // Mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);         // Blockausrichtung
  dv.setUint16(34, 16, true);        // Bit pro Sample

  putAscii(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);

  new Int16Array(buf, 44, length).set(samples.subarray(0, length));
  return new Blob([buf], { type: 'audio/wav' });
}

export function safeFileName(name) {
  const base = (name || 'Diktat').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Diktat';
  return base.slice(0, 80) + '.wav';
}

/** Teilen-Dialog, sonst normaler Download. */
export async function exportWav(blob, fileName) {
  const file = new File([blob], fileName, { type: 'audio/wav' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      // Nur die Datei teilen: ein zusätzlicher title wäre für iOS ein eigenes
      // Element und würde beim Sichern als Textdatei danebenliegen.
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}
