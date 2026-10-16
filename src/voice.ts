/* Browser speech: recognition (Chrome/Edge) + British-female-preferring synthesis. */
type Rec = {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null;
};

export interface VoiceHandlers {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onChange: () => void;
  onError: (msg: string | null) => void;
}


/** Returns the command after the wake word, or null if the wake word was not said. */
export function stripWake(text: string, name: string): string | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\b${n}\\b`, 'i').test(text)) return null;
  return text.replace(new RegExp(`^.*?\\b${n}\\b[,.!\\s]*`, 'i'), '').trim() || 'I am here';
}

class Voice {
  readonly supported: boolean;
  listening = false;
  speaking = false;
  muted = false;
  wakeWord = false;
  wakeName = 'Rem';

  private rec: Rec | null = null;
  private wanted = false;
  private h: VoiceHandlers = { onFinal() {}, onInterim() {}, onChange() {}, onError() {} };
  private pulse = 0;
  private micLevel = 0;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    const W = window as any;
    const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition;
    this.supported = Boolean(Ctor);
    if (Ctor) {
      const r: Rec = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = 'en-GB';
      r.onresult = e => this.handleResult(e);
      r.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.wanted = false;
          this.setListening(false);
          this.h.onError('Microphone access is blocked. Allow it in the browser address bar and try again.');
        } else if (e.error === 'network') {
          this.h.onError('Speech recognition lost its connection. Chrome and Edge need internet for it.');
        }
      };
      r.onend = () => {
        this.setListening(false);
        if (this.wanted && !this.speaking) setTimeout(() => this.begin(), 250);
      };
      this.rec = r;
    }
    if ('speechSynthesis' in window) {
      const pick = () => (this.voice = this.pickVoice());
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  setHandlers(h: VoiceHandlers) { this.h = h; }

  private pickVoice(): SpeechSynthesisVoice | null {
    const vs = speechSynthesis.getVoices();
    const gb = vs.filter(v => /en[-_]GB/i.test(v.lang));
    const female = /(sonia|libby|maisie|hazel|susan|serena|kate|female)/i;
    return gb.find(v => female.test(v.name)) || gb[0] || vs.find(v => /^en/i.test(v.lang)) || null;
  }

  private handleResult(e: any) {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t: string = r[0].transcript;
      if (r.isFinal) this.finalise(t.trim());
      else interim += t;
    }
    this.h.onInterim(interim);
  }

  private finalise(text: string) {
    if (!text) return;
    if (this.wakeWord) {
      const stripped = stripWake(text, this.wakeName);
      if (stripped === null) return;
      text = stripped;
    }
    this.h.onInterim('');
    this.h.onFinal(text);
  }

  private setListening(v: boolean) {
    if (this.listening !== v) { this.listening = v; this.h.onChange(); }
  }

  private begin() {
    if (!this.rec || this.speaking) return;
    try { this.rec.start(); this.setListening(true); } catch { /* already started */ }
  }

  async start() {
    if (!this.rec) { this.h.onError('This browser has no speech recognition. Use Chrome or Edge, or type instead.'); return; }
    this.h.onError(null);
    this.wanted = true;
    this.begin();
    this.startMeter();
  }

  stop() {
    this.wanted = false;
    this.rec?.abort();
    this.setListening(false);
    this.stopMeter();
  }

  toggle() { this.wanted ? this.stop() : this.start(); }
  get active() { return this.wanted; }

  /** Best-effort mic level for the hologram; silently skipped if denied. */
  private async startMeter() {
    if (this.analyser) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        this.micLevel = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        requestAnimationFrame(tick);
      };
      tick();
    } catch { /* recognition still works without the meter */ }
  }

  private stopMeter() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.analyser = null;
    this.micLevel = 0;
  }

  /** 0..1 amplitude for the hologram: synthetic while speaking, real mic otherwise. */
  level(): number {
    if (this.speaking) {
      this.pulse *= 0.9;
      return Math.min(1, 0.25 + this.pulse * 0.75 + Math.random() * 0.12);
    }
    return this.micLevel;
  }

  async speak(text: string): Promise<void> {
    if (this.muted || !('speechSynthesis' in window)) return;
    const clean = text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, 'the link').trim();
    if (!clean) return;
    speechSynthesis.cancel();
    this.speaking = true;
    this.rec?.abort(); // don't let Jarvis transcribe herself
    this.setListening(false);
    this.h.onChange();

    const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean]; // Chrome cuts off long utterances
    for (const s of sentences) {
      if (!this.speaking) break;
      await new Promise<void>(resolve => {
        const u = new SpeechSynthesisUtterance(s.trim());
        if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-GB';
        u.pitch = 1.0;
        u.rate = 1.02;
        u.onboundary = () => { this.pulse = 1; };
        u.onend = () => resolve();
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
    }
    this.speaking = false;
    this.h.onChange();
    if (this.wanted) this.begin();
  }

  shutUp() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (this.speaking) { this.speaking = false; this.h.onChange(); if (this.wanted) this.begin(); }
  }
}

export const voice = new Voice();
