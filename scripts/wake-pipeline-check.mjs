/**
 * Проверка пайплайна voice-wake вне приложения (onnxruntime-node).
 * Реплицирует src/voice/wake.ts 1:1 и сверяется с эталоном openwakeword
 * (python, utils.py): вход мела в int16-масштабе, трансформ x/10 + 2,
 * размогрев кадров единицами, окно мела 1792/шаг 1280 → 8 кадров →
 * embedding 76×32 → окно wake 16.
 *
 * Запуск (нужен `npm i -D onnxruntime-node` и модели в .audit-tmp/oww):
 *   node scripts/wake-pipeline-check.mjs hey.wav [anti.wav]
 * Модели: https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/
 * (melspectrogram.onnx, embedding_model.onnx, hey_jarvis_v0.1.onnx)
 */
import ort from "onnxruntime-node";
import { readFileSync, existsSync } from "node:fs";

const dir = process.env.OWW_MODELS ?? ".audit-tmp/oww/";
if (!existsSync(`${dir}melspectrogram.onnx`)) {
  console.error(`Модели не найдены в ${dir} — скачай с openWakeWord releases v0.5.1`);
  process.exit(1);
}

const mel = await ort.InferenceSession.create(readFileSync(`${dir}melspectrogram.onnx`));
const emb = await ort.InferenceSession.create(readFileSync(`${dir}embedding_model.onnx`));
const wakeName = process.env.OWW_WAKE ?? "hey_jarvis_v0.1.onnx";
const wake = await ort.InferenceSession.create(readFileSync(`${dir}${wakeName}`));
const run = async (s, data, dims) => {
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
  const out = res[s.outputNames[0]];
  return { data: out.data, dims: out.dims };
};

const MELS = 32, MEL_WINDOW = 76, EMB_DIMS = 96, EMB_WIN = 16, CHUNK = 1280, MEL_WIN = 1792;

async function scoreWav(pcm) {
  // int16-масштаб: float32 от int16 без нормализации (модель обучена на нём)
  const pcm16 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  }
  // Размогрев кадров — единицы (np.ones((76,32)) в openwakeword);
  // значения кадров хранятся ПОСЛЕ трансформа x/10 + 2
  const frames = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MELS).fill(1));
  const embHist = [];
  const scores = [];
  for (let pos = 0; pos + MEL_WIN <= pcm16.length; pos += CHUNK) {
    const m = await run(mel, pcm16.subarray(pos, pos + MEL_WIN), [1, MEL_WIN]);
    for (let f = 0; f < 8; f++) {
      const fr = new Float32Array(MELS);
      for (let k = 0; k < MELS; k++) fr[k] = m.data[f * MELS + k] / 10 + 2;
      frames.push(fr);
    }
    if (frames.length > MEL_WINDOW) frames.splice(0, frames.length - MEL_WINDOW);
    const win = new Float32Array(MEL_WINDOW * MELS);
    frames.forEach((fr, i) => win.set(fr, i * MELS));
    const e = await run(emb, win, [1, MEL_WINDOW, MELS, 1]);
    embHist.push(Float32Array.from(e.data.slice(0, EMB_DIMS)));
    if (embHist.length > EMB_WIN) embHist.splice(0, embHist.length - EMB_WIN);
    const w = new Float32Array(EMB_WIN * EMB_DIMS);
    const pad = EMB_WIN - embHist.length;
    embHist.forEach((v, i) => w.set(v, (pad + i) * EMB_DIMS));
    const s = await run(wake, w, [1, EMB_WIN, EMB_DIMS]);
    scores.push(s.data[0]);
  }
  return scores;
}

function wavToPcm(path) {
  const buf = readFileSync(path);
  let pos = 12, dataOff = 44;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") { dataOff = pos + 8; break; }
    pos += 8 + size + (size % 2);
  }
  const n = Math.floor((buf.length - dataOff) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return out;
}

for (const f of process.argv.slice(2)) {
  if (!existsSync(f)) { console.log(`${f}: нет файла`); continue; }
  const scores = await scoreWav(wavToPcm(f));
  const max = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const top = [...scores].sort((a, b) => b - a).slice(0, 3).map((v) => v.toFixed(3));
  console.log(`${f}: blocks=${scores.length} max=${max.toFixed(4)} mean=${mean.toFixed(5)} top3=[${top}]`);
}
