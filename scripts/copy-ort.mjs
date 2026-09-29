#!/usr/bin/env node
/**
 * Копирует WASM-рантайм onnxruntime-web в public/ort — его отдаёт Vite как
 * статику (dist/ort), ort.env.wasm.wasmPaths указывает туда же. Нужно для
 * voice-wake (openWakeWord): инференс wake-модели идёт локально в вебвью,
 * никакой сети. Запускается автоматически на postinstall; public/ort в git
 * не ходит (как public/pyodide).
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dest = join(root, "public", "ort");

// Только CPU-файлы: jsep-вариант (WebGPU) не нужен — wake-модели крошечные
const FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

if (!existsSync(src)) {
  console.warn("copy-ort: node_modules/onnxruntime-web not found — run `npm install`");
  process.exit(0); // не роняем install: voice-wake честно скажет «нет рантайма»
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const f of FILES) {
  if (existsSync(join(src, f))) {
    copyFileSync(join(src, f), join(dest, f));
    copied += 1;
  }
}
console.log(`copy-ort: ${copied}/${FILES.length} файлов → public/ort/`);
