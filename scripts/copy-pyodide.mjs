#!/usr/bin/env node
/**
 * Копирует runtime Pyodide из node_modules в public/pyodide — его отдаёт
 * Vite как статику (dist/pyodide), а pyodide-worker.js грузит оттуда же.
 * Запускается автоматически на postinstall; public/pyodide в git не ходит.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const src = join(root, "node_modules", "pyodide");
const dest = join(root, "public", "pyodide");

const FILES = [
  "pyodide.js",
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

if (!existsSync(src)) {
  console.warn("copy-pyodide: node_modules/pyodide not found — run `npm install`");
  process.exit(0); // не роняем install: code_run просто честно скажет «нет рантайма»
}

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const f of FILES) {
  if (existsSync(join(src, f))) {
    copyFileSync(join(src, f), join(dest, f));
    copied += 1;
  }
}
console.log(`copy-pyodide: ${copied}/${FILES.length} файлов → public/pyodide/`);
