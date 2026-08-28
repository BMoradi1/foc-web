// Plays the map's own imported MP3s: hero voice lines on cast, generic SFX on impact.
export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.master = null;
    this.volume = 0.55;
    this.enabled = true;
    this.missing = new Set();      // paths the archives did not supply
    this.playing = new Set();      // NODUPLICATES: what must not start twice
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }
  async load(file) {
    if (!this.ctx) return null;
    if (this.buffers.has(file)) return this.buffers.get(file);
    const url = file.includes('/') ? `/assets/${file}` : `/assets/sounds/${file}`;
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.arrayBuffer(); })
      .then((b) => this.ctx.decodeAudioData(b))
      .catch(() => { this.missing.add(file); return null; });
    this.buffers.set(file, p);
    return p;
  }
  async play(file, gain = 1, rate = 1) {
    if (!this.enabled || !file) return;
    this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = await this.load(file);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    src.start();
    return src;
  }
  /**
   * Play a sound the map's script started, attenuated by distance from the
   * listener the way Warcraft III's 3D sounds are.
   */
  playWorld(path, x, y, vol = 1, pitch = 1, listener = null, dist = null) {
    if (!path || this.missing.has(path)) return;
    let gain = Math.max(0, Math.min(1, vol));
    if (listener && typeof x === 'number' && typeof y === 'number') {
      const d = Math.hypot(x - listener.x, y - listener.y);
      // Warcraft III gives every sound its own falloff: full volume out to
      // MinDistance, fading to MaxDistance, and DistanceCutoff past which it is
      // not worth mixing at all. A footstep carries 2000, a building collapsing
      // 10000, which is what keeps a crowded fight from becoming one noise.
      // Without a table the old fixed pair stands, so the script's own sounds
      // are unaffected.
      const FULL = dist?.min || 1200;
      const FADE = Math.max(FULL + 1, dist?.max || 4500);
      const CUTOFF = dist?.cutoff || FADE;
      if (d > CUTOFF) return;
      if (d > FULL) gain *= Math.max(0, 1 - (d - FULL) / (FADE - FULL));
    }
    if (gain <= 0.01) return;
    this.play(path, gain, pitch);
  }
  /**
   * A sound with no place on the map: the advisor in your ear.
   *
   * Warcraft III's warnings -- "Our hero has fallen!" -- are not 3D. They play
   * at their own volume wherever the hero died, because the voice is yours and
   * not the battlefield's, so this deliberately skips the distance falloff
   * playWorld applies.
   */
  playUI(path, vol = 1, flags = null) {
    if (!path || this.missing.has(path)) return;
    const gain = Math.max(0, Math.min(1, vol));
    if (gain <= 0.01) return;
    // NODUPLICATES, straight off the row: Warcraft III will not start one of
    // these while it is already playing. Every warning in the table carries it,
    // and in a map where heroes die constantly it is the difference between a
    // warning and a pile-up. CHANNELFULLPREEMPT is deliberately not honoured --
    // it decides what to evict when a mixer channel is full, and there is no
    // channel model here to be full.
    const solo = Array.isArray(flags) && flags.includes('NODUPLICATES');
    if (solo) {
      if (this.playing.has(path)) return;
      this.playing.add(path);
      this.play(path, gain, 1)
        .then((src) => {
          if (src) src.onended = () => this.playing.delete(path);
          else this.playing.delete(path);
        })
        .catch(() => this.playing.delete(path));
      return;
    }
    this.play(path, gain, 1);
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
}
