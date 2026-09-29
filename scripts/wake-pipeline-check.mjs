/**
 * Эталонная реализация стрим-пайплайна openWakeWord (совпадает с wake.ts):
 * блоки по 1280 сэмплов, инференс мела на окне 1792 (n_fft 512, hop 160,
 * center=false) → 8 кадров по 10 мс на блок → embedding последнего окна
 * 76 кадров → 96-вектор → окно 16 векторов (в размогреве — нули спереди)
 * → score. Запуск: node .audit-tmp/inspect-oww.mjs
 */
import ort from "onnxruntime-node";
import { readFileSync, existsSync } from "node:fs";

const dir = new URL("./oww/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const mel = await ort.InferenceSession.create(readFileSync(`${dir}melspectrogram.onnx`));
const emb = await ort.InferenceSession.create(readFileSync(`${dir}embedding_model.onnx`));
const wake = await ort.InferenceSession.create(readFileSync(`${dir}hey_jarvis_v0.1.onnx`));
const run = async (s, data, dims) => {
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
  const out = res[s.outputNames[0]];
  return { data: out.data, dims: out.dims };
};

const MELS = 32, WINDOW = 76, EMB_DIMS = 96, EMB_WIN = 16, CHUNK = 1280, MEL_WIN = 1792;

async function scoreWav(pcm) {
  const frames = []; // последние ≤76 кадров (Float32Array(32))
  const embHist = [];
  let scores = [];
  for (let pos = 0; pos + MEL_WIN <= pcm.length; pos += CHUNK) {
    const m = await run(mel, pcm.subarray(pos, pos + MEL_WIN), [1, MEL_WIN]);
    for (let f = 0; f < 8; f++) frames.push(Float32Array.from(m.data.slice(f * MELS, (f + 1) * MELS)));
    if (frames.length > WINDOW) frames.splice(0, frames.length - WINDOW);
    if (frames.length < WINDOW) continue;
    const win = new Float32Array(WINDOW * MELS);
    frames.forEach((fr, i) => win.set(fr, i * MELS));
    const e = await run(emb, win, [1, WINDOW, MELS, 1]);
    embHist.push(Float32Array.from(e.data.slice(0, EMB_DIMS)));
    if (embHist.length > EMB_WIN) embHist.splice(0, embHist.length - EMB_WIN);
    const w = new Float32Array(EMB_WIN * EMB_DIMS);
    // В размогреве — нули СПЕРЕДИ (как np.pad в openwakeword)
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

for (const [label, file] of [
  ["Hey Jarvis (wake)", "hey-jarvis.wav"],
  ["Проверка связи (анти-тест)", "control.wav"],
]) {
  const p = new URL(`./oww/${file}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  if (!existsSync(p)) continue;
  const scores = await scoreWav(wavToPcm(p));
  const max = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  console.log(`${label}: blocks=${scores.length} max=${max.toFixed(4)} mean=${mean.toFixed(4)}`);
}
