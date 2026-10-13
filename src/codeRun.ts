/**
 * Клиент Pyodide-воркера для инструмента code_run.
 *
 * Песочница: классический Worker без доступа к Tauri-IPC (IPC живёт только
 * в window-контексте) и localStorage; воркер сам вырезает сетевые и
 * storage-глобалы до первого прогона, ФС Pyodide — виртуальная in-memory.
 * Рантайм — статика public/pyodide/ (та же origin, без CDN), раскладывается
 * скриптом scripts/copy-pyodide.mjs на postinstall (npm install).
 *
 * Зависший код (while true) гасится watchdog-таймаутом: воркер terminate'ится
 * и пересоздаётся при следующем запросе — состояние между прогонами кода
 * теряется сознательно, вечное зависание хуже. terminate убивает и чужие
 * параллельные прогоны, поэтому все ожидающие получают ошибку сразу.
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

interface Pending {
  resolve: (r: CodeRunResult) => void;
  timer: number;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
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
    error: `pyodide runtime: ${detail} — run \`npm install\` to install the local Python runtime`,
  };
}

function dropWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker("/pyodide-worker.js");
  // Обработчики живут на воркере, а не на конкретном запросе: ответ
  // маршрутизируется по id, ошибка воркера не теряется при параллельных
  // запросах и не перезаписывается каждым новым вызовом
  w.onmessage = (ev: MessageEvent) => {
    const m = ev.data as {
      id?: number;
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
      result?: string;
    };
    const p = pending.get(m?.id ?? NaN);
    if (!p) return;
    pending.delete(m.id!);
    window.clearTimeout(p.timer);
    p.resolve({
      ok: m.ok === true,
      stdout: cap(m.stdout ?? ""),
      stderr: cap(m.stderr ?? ""),
      error: m.error ? cap(String(m.error)) : undefined,
      // Результат идёт модели в контекст — держим тот же потолок, что и
      // для stdout/stderr, иначе большой return обходит кап
      result: m.result != null ? cap(m.result) : undefined,
    });
  };
  w.onerror = () => {
    // Воркер умер (404 статики / CSP): гасим всех ожидающих и позволяем
    // следующему запросу создать воркер заново
    dropWorker();
    const dead = [...pending.values()];
    pending.clear();
    for (const p of dead) {
      window.clearTimeout(p.timer);
      p.resolve(runtimeError("worker failed to start"));
    }
  };
  worker = w;
  return w;
}

export async function runPython(
  code: string,
  timeoutMs = CODE_TIMEOUT_MS,
): Promise<CodeRunResult> {
  if (typeof Worker === "undefined") {
    return runtimeError("Web Worker unavailable");
  }
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<CodeRunResult>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      // Единственный способ прервать WASM-цикл — terminate; пересоздание
      // воркера при следующем запросе
      dropWorker();
      // terminate гасит и чужие параллельные прогоны — сообщаем и им
      const orphaned = [...pending.values()];
      pending.clear();
      for (const p of orphaned) {
        window.clearTimeout(p.timer);
        p.resolve(runtimeError("worker restarted after a timed-out run"));
      }
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        error: `code_run timed out after ${Math.round(timeoutMs / 1000)}s — sandbox worker restarted`,
      });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    w.postMessage({ id, code });
  });
}

/** Схема инструмента для модели: единый формат с бекенд-схемами (OpenAI).
 *  code_run — вычисления в песочнице: математика, парсинг, трансформация
 *  данных, генерация HTML для Artifacts. Сеть и storage воркер вырезает,
 *  ФС — виртуальная in-memory, процессов нет — потому инструмент не
 *  мутирующий и живёт мимо perm-слоя */
export const CODE_RUN_SCHEMA = {
  type: "function",
  function: {
    name: "code_run",
    description:
      "Run Python 3 code in a local sandboxed interpreter (Pyodide/WASM). " +
      "Standard library available (json, math, statistics, datetime, re, itertools, ...). " +
      "Network access and browser storage are blocked; the filesystem is an " +
      "in-memory virtual FS (no real disk access); no subprocess. " +
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
