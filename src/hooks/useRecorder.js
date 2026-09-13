// Mic capture + voice activity detection:
//   mic -> AudioWorklet -> chunks at the context's ACTUAL rate -> resampled
//   to 16 kHz -> RMS VAD -> complete utterances (with ~0.4 s pre-roll) sent
//   to onUtterance as Float32Array PCM.
//
// The AudioContext requests sampleRate: 16000, but some devices/drivers make
// it fall back to their native rate (e.g. 32 kHz). The recorder reads the
// actual rate and normalizes to 16 kHz — otherwise the audio arrives
// pitch-shifted and too fast for whisper to transcribe at all.
import { useCallback, useRef, useState } from 'react';

const TARGET_RATE = 16000;
const PRE_ROLL_MS = 400; // kept before speech starts
const END_SILENCE_MS = 800;
const MIN_SPEECH_MS = 400;
const MAX_UTTERANCE_MS = 15000;

function rms(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}

function concatFrames(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/**
 * Streaming linear resampler to 16 kHz. Handles any actual input rate
 * (up- or down-sampling), carrying fractional read state across chunks.
 * Identity when the rate already matches.
 */
function makeResampler(rate) {
  if (!rate || rate === TARGET_RATE) return (chunk) => chunk;
  const step = rate / TARGET_RATE; // source samples per output sample
  let t = 0; // read position within the current chunk (starts negative on carries)
  let lastOfPrev = 0;
  return (chunk) => {
    const out = [];
    while (t < chunk.length - 1) {
      const i0 = Math.floor(t);
      const frac = t - i0;
      const a = i0 < 0 ? lastOfPrev : chunk[i0];
      const b = chunk[Math.min(i0 + 1, chunk.length - 1)];
      out.push(a + (b - a) * frac);
      t += step;
    }
    lastOfPrev = chunk[chunk.length - 1];
    t -= chunk.length;
    return new Float32Array(out);
  };
}

export function useRecorder({ onUtterance }) {
  const [status, setStatus] = useState('idle'); // idle | starting | recording | error
  const [error, setError] = useState(null);
  const st = useRef(null);

  const stop = useCallback(() => {
    const s = st.current;
    if (!s) return;
    st.current = null;
    if (s.vad.speaking) finishUtterance(s, true);
    try {
      s.node.port.onmessage = null;
      s.node.disconnect();
      s.src.disconnect();
    } catch {}
    s.stream.getTracks().forEach((t) => t.stop());
    s.ctx.close().catch(() => {});
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (st.current) return;
    setError(null);
    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext({ sampleRate: TARGET_RATE });
      // Some devices make the context fall back to their native rate — read
      // the ACTUAL rate and normalize everything to 16 kHz from here on.
      const resample = makeResampler(ctx.sampleRate);
      if (ctx.sampleRate !== TARGET_RATE) {
        console.warn(`[recorder] AudioContext fell back to ${ctx.sampleRate} Hz — resampling to ${TARGET_RATE} Hz`);
      }
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-chunker');
      src.connect(node);

      const s = {
        stream,
        ctx,
        src,
        node,
        vad: {
          speaking: false,
          noiseFloor: 0.003,
          frames: [],
          preRoll: [],
          preRollMs: 0,
          silenceMs: 0,
          speechMs: 0,
          totalMs: 0,
        },
      };
      node.port.onmessage = (e) => feedFrame(s, resample(e.data));
      st.current = s;
      setStatus('recording');
    } catch (e) {
      setStatus('error');
      setError(e.name === 'NotAllowedError' ? 'Microphone permission denied.' : `Mic error: ${e.message}`);
    }
  }, []);

  function feedFrame(s, chunk) {
    if (!chunk.length) return;
    const vad = s.vad;
    const ms = (chunk.length / TARGET_RATE) * 1000; // chunk duration at 16 kHz
    const r = rms(chunk);
    if (!vad.speaking) {
      // slow-adapting noise floor from the silent parts
      vad.noiseFloor = Math.min(0.02, Math.max(0.0005, vad.noiseFloor * 0.95 + r * 0.05));
    }
    const onThresh = Math.max(vad.noiseFloor * 3.5, 0.005);
    const offThresh = onThresh * 0.6;

    if (!vad.speaking && r > onThresh) {
      vad.speaking = true;
      vad.frames = vad.preRoll.splice(0);
      vad.preRollMs = 0;
      vad.silenceMs = 0;
      vad.speechMs = 0;
      vad.totalMs = 0;
    }
    if (vad.speaking) {
      vad.frames.push(chunk);
      vad.totalMs += ms;
      if (r > offThresh) {
        vad.speechMs += ms;
        vad.silenceMs = 0;
      } else {
        vad.silenceMs += ms;
      }
      const ended = vad.silenceMs >= END_SILENCE_MS && vad.speechMs >= MIN_SPEECH_MS;
      if (ended || vad.totalMs >= MAX_UTTERANCE_MS) finishUtterance(s, false);
    } else {
      vad.preRoll.push(chunk);
      vad.preRollMs += ms;
      while (vad.preRollMs > PRE_ROLL_MS && vad.preRoll.length > 1) {
        vad.preRollMs -= (vad.preRoll[0].length / TARGET_RATE) * 1000;
        vad.preRoll.shift();
      }
    }
  }

  function finishUtterance(s, flush) {
    const vad = s.vad;
    const frames = vad.frames;
    const { speechMs, totalMs } = vad;
    vad.frames = [];
    vad.speaking = false;
    vad.silenceMs = 0;
    vad.speechMs = 0;
    vad.totalMs = 0;
    if (!frames.length) return;
    if (!flush && speechMs < MIN_SPEECH_MS && totalMs < 1000) return;
    const samples = concatFrames(frames);
    // when this utterance began — the transcript shows it even if
    // transcription lags behind live speech
    const spokenAt = Date.now() - Math.round(totalMs);
    if (samples.length >= 8000) onUtterance(samples, spokenAt); // >= 0.5 s
  }

  return { status, error, start, stop };
}