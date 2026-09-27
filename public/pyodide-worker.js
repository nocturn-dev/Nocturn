/**
 * Pyodide-воркер: изолированный рантайм Python для инструмента code_run.
 * Classic worker + importScripts — Pyodide грузится из public/pyodide/
 * (та же origin-статика, без CDN). У воркера нет Tauri-IPC и localStorage:
 * модельный код не может тронуть ни приложение, ни диск — это и есть песочница.
 *
 * Протокол: { id, code } → { id, ok, stdout, stderr, error?, result? }
 * Хост гасит зависшие прогоны через terminate + перезапуск воркера.
 */

"use strict";

let pyodide = null;
let loading = null;

function emit(msg) {
  self.postMessage(msg);
}

async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = (async () => {
      importScripts("/pyodide/pyodide.js");
      // stdout/stderr собираем целиком — хост сам режет потолок
      let out = "";
      let err = "";
      pyodide = await self.loadPyodide({
        indexURL: "/pyodide/",
        stdout: (line) => {
          out += line + "\n";
        },
        stderr: (line) => {
          err += line + "\n";
        },
      });
      pyodide._stdoutBuffer = out;
      pyodide._stderrBuffer = err;
      return pyodide;
    })();
    loading.catch(() => {
      // Провал инициализации (нет статики) — позволяем следующему запросу
      // попробовать снова
      loading = null;
    });
  }
  return loading;
}

self.onmessage = async (event) => {
  const { id, code } = event.data;
  let out = "";
  let err = "";
  try {
    const py = await ensurePyodide();
    // Сбрасываем накопители stdout: setStdout batched отдаёт строки построчно
    let result;
    py.setStdout({ batched: (line) => (out += line + "\n") });
    py.setStderr({ batched: (line) => (err += line + "\n") });
    try {
      // eval_async: последний expression попадает в result (репл-семантика)
      result = await py.runPythonAsync(code);
    } finally {
      py.setStdout();
      py.setStderr();
    }
    let serializable = null;
    if (result !== undefined && result !== null) {
      // Pyodide-объекты (PyProxy) не переживают postMessage — приводим к str
      serializable =
        typeof result.toString === "function" ? result.toString() : String(result);
    }
    emit({ id, ok: true, stdout: out, stderr: err, result: serializable });
  } catch (e) {
    // Ошибка python-кода (или рантайма) уходит модели как обычный результат
    // инструмента — она сама её исправит
    emit({ id, ok: false, stdout: out, stderr: err, error: String(e) });
  }
};
