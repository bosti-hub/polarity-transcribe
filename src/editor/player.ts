// Audio playback for the editor: seeking, speed, looping, the voice-clarity filter and
// choosing which microphone to hear.

export type Listen = "both" | "left" | "right";

export interface PlayerState {
  playing: boolean;
  time: number;
  duration: number;
  rate: number;
  loop: { s: number; e: number } | null;
  clarity: boolean;
  listen: Listen;
  stereo: boolean;
  ready: boolean;
}

type Subscriber = (state: PlayerState) => void;

export class Player {
  audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private nodes: {
    source: MediaElementAudioSourceNode;
    left: GainNode;
    right: GainNode;
    dry: GainNode;
    wet: GainNode;
  } | null = null;
  private subs = new Set<Subscriber>();
  private raf = 0;
  private state: PlayerState = {
    playing: false,
    time: 0,
    duration: 0,
    rate: 1,
    loop: null,
    clarity: false,
    listen: "both",
    stereo: false,
    ready: false,
  };
  /** Called on every animation frame while playing, without going through React. */
  onTick: ((time: number) => void) | null = null;

  private destroyed = false;
  /** Seconds to jump back when resuming after a pause, so the last words are heard again. */
  private rewind = 0;
  private pausedAt: number | null = null;

  constructor(
    private readonly url: string,
    stereo: boolean,
  ) {
    this.state.stereo = stereo;
    this.audio = this.createAudio();
    this.bindMediaKeys();
  }

  /**
   * The keyboard's play/pause key (and headphone buttons, Control Centre) reach the app through
   * the system's media controls. Route them through `toggle`, so they behave like Esc
   * (including the jump back after a pause).
   */
  private bindMediaKeys() {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!session) return;
    const toggle = () => {
      if (!this.destroyed) this.toggle();
    };
    try {
      session.setActionHandler("play", toggle);
      session.setActionHandler("pause", toggle);
    } catch {
      // Not supported by this webview; Esc still works.
    }
  }

  private setMediaState(state: MediaSessionPlaybackState) {
    try {
      if (typeof navigator !== "undefined" && navigator.mediaSession) navigator.mediaSession.playbackState = state;
    } catch {
      // Not supported.
    }
  }

  private createAudio(): HTMLAudioElement {
    const audio = new Audio();
    // Needed so the audio may pass through the Web Audio filters.
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.preservesPitch = true;
    audio.src = this.url;

    audio.addEventListener("loadedmetadata", () => this.set({ duration: audio.duration || 0, ready: true }));
    audio.addEventListener("durationchange", () => this.set({ duration: audio.duration || 0 }));
    audio.addEventListener("play", () => {
      this.set({ playing: true });
      this.setMediaState("playing");
      this.loopFrame();
    });
    audio.addEventListener("pause", () => {
      this.set({ playing: false, time: audio.currentTime });
      this.setMediaState("paused");
    });
    audio.addEventListener("ended", () => this.set({ playing: false }));
    audio.addEventListener("seeked", () => {
      this.set({ time: audio.currentTime });
      this.onTick?.(audio.currentTime);
    });
    // Animation frames stop when the window is hidden; this keeps the clock and the loop going.
    audio.addEventListener("timeupdate", () => {
      if (!audio.paused) this.step();
    });
    return audio;
  }

  /**
   * Make the player usable (again). A component calls this when it mounts and `destroy` when it
   * unmounts; React may mount, unmount and mount again with the same player object.
   */
  attach() {
    if (!this.destroyed) return;
    this.destroyed = false;
    this.nodes = null;
    this.ctx = null;
    this.audio = this.createAudio();
    this.audio.playbackRate = this.state.rate;
    this.state = { ...this.state, playing: false, time: 0, ready: false, clarity: false, listen: "both", loop: null };
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    fn(this.state);
    return () => this.subs.delete(fn);
  }

  get snapshot(): PlayerState {
    return this.state;
  }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((fn) => fn(this.state));
  }

  /** Enforce the loop and publish the clock. */
  private step() {
    const t = this.audio.currentTime;
    const loop = this.state.loop;
    if (loop && (t >= loop.e || t < loop.s - 0.3)) {
      this.audio.currentTime = loop.s;
    }
    this.onTick?.(t);
    // React only needs the clock a few times per second.
    if (Math.abs(t - this.state.time) >= 0.2) this.set({ time: t });
  }

  private loopFrame = () => {
    cancelAnimationFrame(this.raf);
    if (this.audio.paused) return;
    this.step();
    this.raf = requestAnimationFrame(this.loopFrame);
  };

  /** The Web Audio graph is only built when a filter or channel choice needs it. */
  private graph() {
    if (this.nodes) return this.nodes;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const source = ctx.createMediaElementSource(this.audio);

    // Channel choice: each side has a gain and both feed one mono bus heard in both ears.
    const splitter = ctx.createChannelSplitter(2);
    const left = ctx.createGain();
    const right = ctx.createGain();
    const bus = ctx.createGain();
    bus.channelCount = 1;
    bus.channelCountMode = "explicit";
    if (this.state.stereo) {
      source.connect(splitter);
      splitter.connect(left, 0);
      splitter.connect(right, 1);
      left.connect(bus);
      right.connect(bus);
    } else {
      source.connect(bus);
    }

    // Clarity chain: cut rumble, lift the consonant range, even out the level.
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 120;
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2800;
    presence.Q.value = 0.8;
    presence.gain.value = 6;
    const air = ctx.createBiquadFilter();
    air.type = "highshelf";
    air.frequency.value = 5500;
    air.gain.value = 3;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -28;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.8;

    const dry = ctx.createGain();
    const wet = ctx.createGain();
    bus.connect(dry).connect(ctx.destination);
    bus.connect(highpass).connect(presence).connect(air).connect(comp).connect(makeup).connect(wet).connect(ctx.destination);

    this.nodes = { source, left, right, dry, wet };
    this.applyRouting();
    return this.nodes;
  }

  private applyRouting() {
    const n = this.nodes;
    if (!n) return;
    const { listen, clarity } = this.state;
    // "Both" halves each side so the level matches listening to one microphone.
    n.left.gain.value = listen === "right" ? 0 : listen === "left" ? 1 : 0.5;
    n.right.gain.value = listen === "left" ? 0 : listen === "right" ? 1 : 0.5;
    n.dry.gain.value = clarity ? 0 : 1;
    n.wet.gain.value = clarity ? 1 : 0;
  }

  async play() {
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    const loop = this.state.loop;
    if (loop && (this.audio.currentTime < loop.s - 0.05 || this.audio.currentTime >= loop.e)) this.audio.currentTime = loop.s;
    await this.audio.play().catch(() => undefined);
  }

  pause() {
    this.pausedAt = this.audio.currentTime;
    this.audio.pause();
    // WebKit (macOS) can keep repeating its last audio buffer through the filter graph after a
    // pause at a speed other than 1x; stop the graph until playback resumes. (Muting the element
    // instead would make macOS hand the play key to another app, such as Music.)
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  /** Play or pause. Resuming where a pause left off first jumps back a little (see setRewind). */
  toggle() {
    if (this.audio.paused) {
      if (this.rewind > 0 && this.pausedAt !== null && Math.abs(this.audio.currentTime - this.pausedAt) < 0.05) {
        this.seek(this.audio.currentTime - this.rewind);
      }
      this.pausedAt = null;
      void this.play();
    } else this.pause();
  }

  setRewind(seconds: number) {
    this.rewind = Math.max(0, Math.min(10, seconds));
  }

  seek(time: number, andPlay = false) {
    const d = this.audio.duration || this.state.duration || 0;
    this.audio.currentTime = Math.max(0, d > 0 ? Math.min(time, d - 0.05) : time);
    this.set({ time: this.audio.currentTime });
    if (andPlay) void this.play();
  }

  skip(delta: number) {
    this.seek(this.audio.currentTime + delta);
  }

  setRate(rate: number) {
    const r = Math.max(0.5, Math.min(2, Math.round(rate * 20) / 20));
    this.audio.playbackRate = r;
    this.audio.defaultPlaybackRate = r;
    this.set({ rate: r });
  }

  setLoop(loop: { s: number; e: number } | null) {
    this.set({ loop });
    if (loop) this.seek(loop.s, true);
  }

  setClarity(on: boolean) {
    this.set({ clarity: on });
    this.updateGraph();
  }

  setListen(listen: Listen) {
    this.set({ listen });
    this.updateGraph();
  }

  /**
   * Build the Web Audio graph when a filter or channel choice needs it, and drop it again when
   * nothing does. In WebKit (macOS) audio that passes through Web Audio does not follow the
   * playback speed well (it stutters at other speeds), so plain playback must not use it.
   */
  private updateGraph() {
    const needed = this.state.clarity || this.state.listen !== "both";
    if (needed) {
      this.graph();
      this.applyRouting();
      if (!this.audio.paused) void this.ctx?.resume();
    } else if (this.nodes) {
      this.releaseGraph();
    }
  }

  /** A media element cannot be disconnected from Web Audio, so start a fresh one where we were. */
  private releaseGraph() {
    const old = this.audio;
    const time = old.currentTime;
    const playing = !old.paused;
    old.pause();
    old.removeAttribute("src");
    old.load();
    void this.ctx?.close();
    this.ctx = null;
    this.nodes = null;
    const audio = this.createAudio();
    audio.playbackRate = this.state.rate;
    audio.defaultPlaybackRate = this.state.rate;
    audio.addEventListener(
      "loadedmetadata",
      () => {
        audio.currentTime = time;
        if (playing) void this.play();
      },
      { once: true },
    );
    this.audio = audio;
  }

  destroy() {
    this.destroyed = true;
    try {
      navigator.mediaSession?.setActionHandler("play", null);
      navigator.mediaSession?.setActionHandler("pause", null);
    } catch {
      // Not supported.
    }
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    void this.ctx?.close();
    this.subs.clear();
    this.onTick = null;
  }
}
