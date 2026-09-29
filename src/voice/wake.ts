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
/** Шаг блока инференса: 1280 сэмплов = 80 мс аудио */
const HOP = 1280;
/** Окно инференса мела: 1792 = hop + 512 (n_fft), даёт ровно 8 кадров
 *  по 10 мс с непрерывной фреймингой (модель без центр-паддинга:
 *  frames(len) = floor((len-512)/160)+1 — проверено на инспекции моделей) */
const MEL_WIN = 1792;
const MELS = 32;
/** Окно embedding-модели: 76 кадров = 0.76 с, вход (1, 76, 32, 1) */
const MEL_WINDOW = 76;
const EMB_DIMS = 96;
const EMB_WINDOW = 16; // глубина окна wake-модели, вход (1, 16, 96)
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
  /** Фактическая частота сэмплирования контекста (может отличаться от 16 к) */
  private ctxRate = SAMPLE_RATE;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;

  private mel!: Sess;
  private emb!: Sess;
  private wake!: Sess;

  // Стрим-буфер инференса: непотреблённые сэмплы между блоками.
  // Блок = окно 1792, потребляем 1280 → 512 «хвоста» переиспользуются.
  // Значения — в int16-масштабе (±32767): модель обучена на float32 от
  // int16 PCM, нормализация [-1;1] занижала скоры в ~10 раз
  private melStream: F32[] = [];
  private melStreamLen = 0;
  // Последние ≤76 mel-кадров (каждый — Float32Array(32), кадр-мажор).
  // Размогрев — единицы (np.ones((76,32)) в openwakeword); значения
  // хранятся ПОСЛЕ трансформа x/10 + 2
  private frames: F32[] = Array.from({ length: MEL_WINDOW }, () =>
    new Float32Array(MELS).fill(1),
  );
  // Последние ≤16 embedding-векторов (Float32Array(96))
  private embHist: F32[] = [];
  // Последние 5 скоров — медианное сглаживание против одиночных пиков
  private scoreHist: number[] = [];
  // Сериализация инференса: чанки приходят чаще, чем выполняется WASM,
  // и без очереди состояния (frames/embHist) интерливились бы
  private chain: Promise<void> = Promise.resolve();
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
      // Модели не загрузились: не оставляем полумёртвый слушатель —
      // тумблер честно гасится, пользователь включает заново после фикса
      this.stop();
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
      // Запрошенные 16 кГц драйвер/устройство могут подменить (48 к и пр.) —
      // фиксируем фактическую частоту и ресемпллируем чанки вручную
      this.ctxRate = ctx.sampleRate;
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) =>
        this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
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
      // Микрофон недоступен: гасим слушателя — тумблер выключается честно
      this.stop();
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

  private onAudio(rawChunk: F32): void {
    // Фактическая частота контекста может не совпасть с 16 кГц — приводим
    const chunk =
      this.ctxRate === SAMPLE_RATE ? rawChunk : resampleTo16k(rawChunk, this.ctxRate);
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

    // Слушание: обновляем пол шума и копим стрим до полного окна инференса
    const rms = rmsOf(chunk);
    if (!this.noiseSeen && rms > 0) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.noiseSeen = true;
    }

    this.melStream.push(chunk);
    this.melStreamLen += chunk.length;
    // Дренируем ВСЕ полные окна, а не одно на чанк: аудиопроцессор отдаёт
    // 4096 сэмплов раз в 256 мс, блок потребляет 1280 — одиночная обработка
    // копила отставание без предела (детектор «молчал» и запаздывал минутами)
    while (this.melStreamLen >= MEL_WIN) {
      // Склейка буфера: берём первое окно 1792, остаток (включая 512-хвост
      // перекрытия — контекст следующего блока, мел без центр-паддинга:
      // n_fft 512, hop 160) ждёт следующего захода.
      // В инференс уходит int16-масштаб: [-1;1] → ±32767
      const all = new Float32Array(this.melStreamLen);
      let off = 0;
      for (const piece of this.melStream) {
        all.set(piece, off);
        off += piece.length;
      }
      const win = new Float32Array(MEL_WIN);
      for (let i = 0; i < MEL_WIN; i++) {
        win[i] = (all[i] ?? 0) * 32767;
      }
      const rest = all.subarray(HOP);
      this.melStream = [Float32Array.from(rest)];
      this.melStreamLen = rest.length;
      // Сериализация: чанки приходят чаще, чем выполняется WASM
      this.chain = this.chain
        .then(() => this.processBlock(win))
        .catch(() => {});
    }
  }

  private async processBlock(win: F32): Promise<void> {
    if (this.stopped || this.capturing || this.state === "suspended") return;
    try {
      const mel = await this.mel.run(win, [1, MEL_WIN]);
      // Выход (1, 1, 8, 32), кадр-мажор: кадр f = данные [f*32 .. f*32+32).
      // ОБЯЗАТЕЛЬНЫЙ трансформ openwakeword: mel/10 + 2 — без него
      // эмбеддинги вне распределения обучения и скоры ≈ 0.03 вместо 0.3+
      for (let f = 0; f < 8; f++) {
        const fr = new Float32Array(MELS);
        for (let k = 0; k < MELS; k++) fr[k] = (mel[f * MELS + k] ?? 0) / 10 + 2;
        this.frames.push(fr);
      }
      if (this.frames.length > MEL_WINDOW) {
        this.frames.splice(0, this.frames.length - MEL_WINDOW);
      }
      if (this.frames.length < MEL_WINDOW) return;
      // Embedding: окно (1, 76, 32, 1) → вектор 96 (имя входа — "input_1",
      // резолвится динамически через inputNames)
      const win76 = new Float32Array(MEL_WINDOW * MELS);
      this.frames.forEach((fr, i) => win76.set(fr, i * MELS));
      const emb = await this.emb.run(win76, [1, MEL_WINDOW, MELS, 1]);
      this.embHist.push(Float32Array.from(emb.slice(0, EMB_DIMS)));
      if (this.embHist.length > EMB_WINDOW) this.embHist.shift();
      // Wake: окно (1, 16, 96); в размогреве — нули СПЕРЕДИ (как np.pad
      // в openwakeword), чтобы скор считался с первых секунд
      const w = new Float32Array(EMB_WINDOW * EMB_DIMS);
      const pad = EMB_WINDOW - this.embHist.length;
      this.embHist.forEach((v, i) => w.set(v, (pad + i) * EMB_DIMS));
      const score = (await this.wake.run(w, [1, EMB_WINDOW, EMB_DIMS]))[0] ?? 0;
      // Медиана последних 5: одиночный всплеск помехи не триггерит
      this.scoreHist.push(score);
      if (this.scoreHist.length > 5) this.scoreHist.shift();
      const sorted = [...this.scoreHist].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      if (median >= this.opts.threshold && Date.now() >= this.cooldownUntil) {
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
    // Стрим-хвост протухнет за время захвата — размогрев после него чище
    this.melStream = [];
    this.melStreamLen = 0;
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

/** Линейный ресемпл чанка к 16 кГц: на случай, если AudioContext открылся
 *  на иной частоте (драйвер/устройство) — модели обучены строго на 16 кГц */
function resampleTo16k(input: F32, from: number): F32 {
  const outLen = Math.max(1, Math.round((input.length * SAMPLE_RATE) / from));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = (i * from) / SAMPLE_RATE;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
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
