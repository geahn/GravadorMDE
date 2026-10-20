// Mixes the microphone (and optionally the computer's audio) into one track
// and exposes a level meter for the UI.

export class AudioMixer {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.dest = this.ctx.createMediaStreamDestination();

    this.micGain = this.ctx.createGain();
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micGain.connect(this.micAnalyser);
    this.micGain.connect(this.dest);

    this.sysGain = this.ctx.createGain();
    this.sysGain.connect(this.dest);

    // The same two sources also kept apart (saved as separate files while
    // recording with the computer audio), to balance them in the editor.
    this.micDest = this.ctx.createMediaStreamDestination();
    this.sysDest = this.ctx.createMediaStreamDestination();
    this.micGain.connect(this.micDest);
    this.sysGain.connect(this.sysDest);

    this.buf = new Float32Array(this.micAnalyser.fftSize);
    this.micSource = null;
    this.sysSource = null;
    this.smoothed = 0;
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setMic(stream) {
    if (this.micSource) this.micSource.disconnect();
    this.micSource = stream ? this.ctx.createMediaStreamSource(stream) : null;
    if (this.micSource) this.micSource.connect(this.micGain);
    this.resume();
  }

  setSystem(stream) {
    if (this.sysSource) this.sysSource.disconnect();
    this.sysSource = stream ? this.ctx.createMediaStreamSource(stream) : null;
    if (this.sysSource) this.sysSource.connect(this.sysGain);
    this.resume();
  }

  setSysGain(value) {
    this.sysGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  get micTrack() {
    return this.micDest.stream.getAudioTracks()[0];
  }

  get sysTrack() {
    return this.sysDest.stream.getAudioTracks()[0];
  }

  setMicGain(value) {
    this.micGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  get hasInput() {
    return !!(this.micSource || this.sysSource);
  }

  get track() {
    return this.dest.stream.getAudioTracks()[0];
  }

  // 0..1, roughly -60 dBFS..0 dBFS, with a fast attack and slow release.
  level() {
    if (!this.micSource) {
      this.smoothed *= 0.8;
      return this.smoothed;
    }
    this.micAnalyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(Math.max(rms, peak * 0.5, 1e-6));
    const lvl = Math.min(1, Math.max(0, (db + 60) / 60));
    this.smoothed = lvl > this.smoothed ? lvl : this.smoothed * 0.86 + lvl * 0.14;
    this.peak = peak;
    return this.smoothed;
  }
}
