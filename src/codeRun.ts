/**
 * Клиент Pyodide-воркера для инструмента code_run.
 *
 * Песочница: классический Worker без доступа к Tauri-IPC (IPC живёт только
 * в window-контексте) и localStorage — модельный Python не может тронуть ни
 * приложение, ни диск. Рантайм — стatica public/pyodide/ (та же origin,
 * без CDN), раскладывается скриптом scripts/copy-pyodide.mjs на postinstall.
 *
 * Зависший код (while true) гасится watchdog-таймаутом: воркер terminate'ится
 * и пересоздаётся при следующем запросе — состояние между прогонами кода
 * теряется сознательно, вечное зависание хуже.
 */

const CODE_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 64 * 1024;

export interface CodeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  result?: string;
}

let worker: Worker | null = null;
let seq = 0;

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…(output truncated)` : s;
}

/** Ошибка рантайма — единый формат с ошибкой кода (модель сама исправится) */
function runtimeError(detail: string): CodeRunResult {
  return {
    ok: false,
    stdout: "",
    stderr: "",
    error: `pyodide runtime: ${detail} — run \`npm run pyodide:copy\` (or npm install) to install the local Python runtime`,
  };
}

export async function runPython(
  code: string,
  timeoutMs = CODE_TIMEOUT_MS,
): Promise<CodeRunResult> {
  if (typeof Worker === "undefined") {
    return runtimeError("Web Worker unavailable");
  }
  if (!worker) worker = new Worker("/pyodide-worker.js");
  const w = worker;
  const id = ++seq;
  return new Promise<CodeRunResult>((resolve) => {
    let settled = false;
    const finish = (r: CodeRunResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      resolve(r);
    };
    // Воркер сам не завёлся (404 статики / CSP): 404 словит onerror мгновенно
    w.onerror = () => finish(runtimeError("worker failed to start"));
    const timer = window.setTimeout(() => {
      // Единственный способ прервать WASM-цикл — terminate
      w.terminate();
      worker = null;
      finish({
        ok: false,
        stdout: "",
        stderr: "",
        error: `code_run timed out after ${Math.round(timeoutMs / 1000)}s — sandbox worker restarted`,
      });
    }, timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      const m = ev.data as {
        id?: number;
        ok?: boolean;
        stdout?: string;
        stderr?: string;
        error?: string;
        result?: string;
      };
      if (m?.id !== id) return;
      finish({
        ok: m.ok === true,
        stdout: cap(m.stdout ?? ""),
        stderr: cap(m.stderr ?? ""),
        error: m.error ? cap(String(m.error)) : undefined,
        result: m.result,
      });
    };
    w.addEventListener("message", onMessage);
    w.postMessage({ id, code });
  });
}

/** Схема инструмента для модели: единый формат с бекенд-схемами (OpenAI).
 *  code_run — вычисления в песочнице: математика, парсинг, трансформация
 *  данных, генерация HTML для Artifacts. ФС/сеть/процессы недоступны
 *  by design — потому инструмент не мутирующий и живёт мимо perm-слоя */
export const CODE_RUN_SCHEMA = {
  type: "function",
  function: {
    name: "code_run",
    description:
      "Run Python 3 code in a local sandboxed interpreter (Pyodide/WASM). " +
      "Standard library available (json, math, statistics, datetime, re, itertools, ...). " +
      "No filesystem, no network, no subprocess — pure computation only. " +
      "Use print() to emit output; the value of the last expression is returned as `result`. " +
      "Great for math, data parsing and transforming, quick calculations, " +
      "and generating HTML documents for artifacts.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python 3 source code to execute. Use print() for output.",
        },
      },
      required: ["code"],
    },
  },
} as const;
