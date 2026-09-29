/**
 * Voice Wake («Jarvis-режим»): всегда слушающий микрофон с локальным
 * детектором активационной фразы. Инференс — openWakeWord (ONNX) в
 * onnxruntime-web: WASM из public/ort, инлайн-модели из app_data/voice
 * (voice_read_model), ноль сети в рантайме. Аудио не покидает процесс:
 * кольцевой pre-roll живёт в памяти, на диск ничего не пишется.
 *
 * Пайплайн openWakeWord на чанк 1280 сэмплов (80 мс, 16 кГц):
 *   raw → melspectrogram (8 кадров × 32) → embedding (1 × 96) →
 *   wake-модель (окно 16 embedding-кадров) → score 0..1.
 * После срабатывания — дослушивание фразы до паузы (энергетический VAD
 * с адаптивным полом шума) и отдача base64(int16 PCM) наружу; транскрипция
 * и отправка — существующая диктовка (whisper) и агентный цикл App.
 */

export type WakeModel = "hey_jarvis" | "hey_mycroft";

export type WakeState = "loading" | "listening" | "capturing" | "suspended";

export interface WakeHandle {
  suspend(): void;
  resume(): void;
  stop(): void;
}

export interface WakeOptions {
  model: WakeModel;
  /** Порог score 0.3–0.9 (выше — меньше ложных) */
  threshold: number;
  onWake: (utteranceBase64: string) => void;
  onError: (message: string) => void;
  onState?: (state: WakeState) => void;
}

const SAMPLE_RATE = 16000;
/** Чанк openWakeWord: 1280 сэмплов = 80 мс */
const OWW_CHUNK = 1280;
const MEL_DIMS = 32;
const EMB_DIMS = 96;
const EMB_WINDOW = 16; // глубина окна wake-модели (1.28 с)
/** pre-roll до срабатывания: сама фраза «hey jarvis» целиком */
const PRE_ROLL_SAMPLES = SAMPLE_RATE * 2;
const MAX_CAPTURE_SAMPLES = SAMPLE_RATE * 12;
const MIN_UTTERANCE_SAMPLES = SAMPLE_RATE * 0.4;
const SILENCE_HANGOVER_MS = 700;
const COOLDOWN_MS = 1200;

type F32 = Float32Array;

interface Sess {
  run(input: F32, dims: number[]): Promise<F32>;
}

async function makeSess(
  ort: typeof import("onnxruntime-web"),
  bytes: ArrayBuffer,
): Promise<Sess> {
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
  });
  const inputName = session.inputNames[0] ?? "input";
  const outputName = session.outputNames[0] ?? "output";
  return {
    async run(input: F32, dims: number[]): Promise<F32> {
      const tensor = new ort.Tensor("float32", input, dims);
      const res = await session.run({ [inputName]: tensor });
      const out = res[outputName];
      if (!out) throw new Error("wake model produced no output");
      return out.data as F32;
    },
  };
}

/** Включён ли микрофон другими частями приложения (диктовка): слушатель
 *  честно освобождает устройство, чтобы не конкурировать за него */
function micBusy(): boolean {
  try {
    return window.__nocturnMicBusy === true;
  } catch {
    return false;
  }
}

export class VoiceWake {
  private opts: WakeOptions;
  private state: WakeState = "loading";
  private stopped = false;
  private suspended = false;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;

  private mel!: Sess;
  private emb!: Sess;
  private wake!: Sess;

  // Хвост неполного чанка (аудиопроцессор отдаёт 4096, модели хотят 1280)
  private pend: F32 = new Float32Array(0);
  // История embedding-кадров для окна wake-модели
  private embHist: F32[] = [];
  // Кольцевой pre-roll: последние ~2 с сырого аудио
  private ring = new Float32Array(PRE_ROLL_SAMPLES);
  private ringAt = 0;
  private ringFilled = 0;

  private capturing = false;
  private capture: F32[] = [];
  private captureSamples = 0;
  private speechSeen = false;
  private silenceMs = 0;
  private cooldownUntil = 0;
  // Адаптивный пол шума (EMA RMS в режиме слушания)
  private noiseFloor = 0.01;
  private noiseSeen = false;

  constructor(opts: WakeOptions) {
    this.opts = opts;
  }

  private setState(s: WakeState) {
    if (this.stopped || this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  async start(): Promise<void> {
    try {
      const ort = await import("onnxruntime-web");
      ort.env.wasm.wasmPaths = "/ort/";
      ort.env.wasm.numThreads = 1; // COOP/COEP нет — однопоточный WASM
      const b64ToBuf = async (name: string) => {
        const { voiceReadModel } = await import("../api");
        const b64 = await voiceReadModel(name);
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
      };
      this.mel = await makeSess(ort, await b64ToBuf("melspectrogram.onnx"));
      this.emb = await makeSess(ort, await b64ToBuf("embedding_model.onnx"));
      const wakeFile =
        this.opts.model === "hey_jarvis"
          ? "hey_jarvis_v0.1.onnx"
          : "hey_mycroft_v0.1.onnx";
      this.wake = await makeSess(ort, await b64ToBuf(wakeFile));
    } catch (e) {
      this.opts.onError(String(e));
      return;
    }
    if (this.stopped) return;
    document.addEventListener("nocturn-voice-busy", this.onBusyEvent);
    await this.openMic();
  }

  private onBusyEvent = () => {
    // Диктовка включила/выключила запись — арбитраж устройства
    if (micBusy() && this.state !== "suspended") this.suspend();
    else if (!micBusy() && this.state === "suspended") void this.resume();
  };

  private async openMic(): Promise<void> {
    if (this.stopped) return;
    try {
      const micId = localStorage.getItem("haloui-mic-device") ?? "";
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(micId ? { deviceId: { exact: micId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      }
      if (this.stopped || this.suspended) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      this.ctx = ctx;
      this.stream = stream;
      this.node = node;
      this.setState("listening");
    } catch {
      this.opts.onError("mic denied");
    }
  }

  private closeMic(): void {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  suspend(): void {
    if (this.stopped || this.state === "suspended") return;
    this.suspended = true;
    this.closeMic();
    this.setState("suspended");
  }

  resume(): void {
    if (this.stopped || !this.suspended) return;
    this.suspended = false;
    void this.openMic();
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("nocturn-voice-busy", this.onBusyEvent);
    this.closeMic();
    this.setState("suspended");
  }

  private onAudio(chunk: F32): void {
    if (this.stopped || this.state === "suspended" || micBusy()) return;

    // Pre-roll копится всегда
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.ringAt] = chunk[i] ?? 0;
      this.ringAt = (this.ringAt + 1) % this.ring.length;
      this.ringFilled = Math.min(this.ringFilled + 1, this.ring.length);
    }

    // Режим захвата фразы: копим до паузы, модели не считаем
    if (this.capturing) {
      this.capture.push(chunk);
      this.captureSamples += chunk.length;
      const rms = rmsOf(chunk);
      if (rms > Math.max(this.noiseFloor * 3, 0.01)) {
        this.speechSeen = true;
        this.silenceMs = 0;
      } else {
        this.silenceMs += (chunk.length / SAMPLE_RATE) * 1000;
      }
      const enoughSilence = this.speechSeen && this.silenceMs >= SILENCE_HANGOVER_MS;
      const tooLong = this.captureSamples >= MAX_CAPTURE_SAMPLES;
      if (enoughSilence || tooLong) this.finishCapture();
      return;
    }

    // Слушание: обновляем пол шума и прогоняем чанк через модели
    const rms = rmsOf(chunk);
    if (!this.noiseSeen && rms > 0) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.noiseSeen = true;
    }

    this.pend = concat(this.pend, chunk);
    while (this.pend.length >= OWW_CHUNK) {
      const piece = this.pend.subarray(0, OWW_CHUNK);
      this.pend = this.pend.slice(OWW_CHUNK);
      void this.scoreChunk(new Float32Array(piece));
    }
  }

  private async scoreChunk(chunk: F32): Promise<void> {
    if (this.stopped || this.capturing || this.state === "suspended") return;
    try {
      const mel = await this.mel.run(chunk, [1, chunk.length]);
      const emb = await this.emb.run(mel, [1, mel.length / MEL_DIMS, MEL_DIMS]);
      this.embHist.push(emb);
      if (this.embHist.length > EMB_WINDOW) this.embHist.shift();
      if (this.embHist.length < EMB_WINDOW) return;
      const window = new Float32Array(EMB_WINDOW * EMB_DIMS);
      this.embHist.forEach((frame, i) => window.set(frame, i * EMB_DIMS));
      const score = (await this.wake.run(window, [1, EMB_WINDOW, EMB_DIMS]))[0] ?? 0;
      if (score >= this.opts.threshold && Date.now() >= this.cooldownUntil) {
        this.beginCapture();
      }
    } catch (e) {
      // Ошибка инференса не должна уронить цикл: гасим слушателя, сообщаем
      this.stop();
      this.opts.onError(String(e));
    }
  }

  private beginCapture(): void {
    this.capturing = true;
    this.capture = [];
    this.captureSamples = 0;
    this.speechSeen = false;
    this.silenceMs = 0;
    // pre-roll разворачиваем в хронологический порядок: с места записи
    const pre = new Float32Array(this.ringFilled);
    const head = this.ring.subarray(this.ringAt, this.ring.length);
    const tail = this.ring.subarray(0, this.ringAt);
    pre.set(head, 0);
    pre.set(tail, head.length);
    this.capture.push(pre);
    this.captureSamples += pre.length;
    this.setState("capturing");
  }

  private finishCapture(): void {
    this.capturing = false;
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    this.setState("listening");
    if (this.captureSamples < MIN_UTTERANCE_SAMPLES) return;
    // pre-roll (~2 с) уже включает саму фразу активации — шлём всё
    this.opts.onWake(floatChunksToBase64(this.capture));
  }
}

function rmsOf(chunk: F32): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += (chunk[i] ?? 0) * (chunk[i] ?? 0);
  return Math.sqrt(sum / Math.max(1, chunk.length));
}

function concat(a: F32, b: F32): F32 {
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Срезать активационную фразу с начала транскрипта («Hey Jarvis, …» → «…»).
 *  Whisper выдаёт вариации: "Hey, Jarvis!", "Эй Джарвис", "Ok Jarvis"…
 *  \b не используем: в JS он ASCII-only и не срабатывает после кириллицы —
 *  вместо него lookahead на разделитель или конец строки */
export function stripWakeWord(text: string, model: WakeModel): string {
  const name = model === "hey_jarvis" ? "jarvis|джарвис|джарвиз" : "mycroft|мойкрофт";
  const re = new RegExp(
    `^\\s*(hey|hi|ok|okay|yo|эй|окей|ок)[\\s,._!?\-]*(?:${name})(?=[\\s,.!:;?\u2014\u2013-]|$)[\\s,.!:;?\u2014\u2013-]*`,
    "iu",
  );
  return text.replace(re, "").trim();
}

/** Экспорт для тестов: собрать base64 PCM из float-чанков так же, как это
 *  делает finishCapture (дублирование конвертера — сознательное: ChatArea
 *  держит свой инлайн-конвертер для диктовки) */
export function floatChunksToBase64(chunks: F32[]): string {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i] ?? 0));
      pcm[off++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
