/**
 * Pyodide-воркер: рантайм Python для инструмента code_run.
 * Classic worker + importScripts — Pyodide грузится из public/pyodide/
 * (та же origin-статика, без CDN). У воркера нет Tauri-IPC и localStorage;
 * сетевые и storage-глобалы вырезаются сразу после загрузки рантайма —
 * модельный код через js-модуль не получает ни сеть, ни хранилища, а ФС
 * Pyodide — виртуальная in-memory, реального диска не видно. Граница —
 * гигиена, а не защита от злонамеренного кода: рантайм живёт в том же
 * процессе, изоляции процессов тут нет.
 *
 * Протокол: { id, code } → { id, ok, stdout, stderr, error?, result? }
 * Прогоны сериализуются цепочкой промисов: setStdout/setStderr — глобальные
 * накопители общего инстанса, параллельные прогоны путали бы вывод.
 * Хост гасит зависшие прогоны через terminate + перезапуск воркера.
 */

"use strict";

let pyodide = null;
let loading = null;
// Очередь прогонов: следующий код стартует только после завершения
// предыдущего, иначе сброс setStdout одного прогона режет чужой вывод
let runChain = Promise.resolve();

function emit(msg) {
  self.postMessage(msg);
}

// Сетевые и storage-поверхности, добираемые из Python через js-модуль.
// importScripts и Worker тоже здесь: первый — путь к динамическому коду,
// второй — вложенные воркеры в обход вырезания глобалов
const BLOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "indexedDB",
  "caches",
  "importScripts",
  "Worker",
];

function blockNetworkAndStorage() {
  for (const name of BLOCKED_GLOBALS) {
    try {
      // Часть свойств живёт на прототипе скоупа, delete их не снимает —
      // поэтому после delete ещё затираем собственным теневым значением
      delete self[name];
      Object.defineProperty(self, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      // Неконфигурируемый глобал — переживаем: основная поверхность срезана
    }
  }
}

async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = (async () => {
      importScripts("/pyodide/pyodide.js");
      pyodide = await self.loadPyodide({
        indexURL: "/pyodide/",
      });
      blockNetworkAndStorage();
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

async function runOne(id, code) {
  let out = "";
  let err = "";
  try {
    const py = await ensurePyodide();
    // Накопители stdout/stderr — на каждый прогон свои, хост сам режет потолок
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
      try {
        // Pyodide-объекты (PyProxy) не переживают postMessage — приводим к str
        serializable = String(result);
      } catch {
        // str(result) упал — не роняем успешный прогон, отдаём заглушку
        serializable = "<unrepresentable result>";
      } finally {
        // PyProxy держит память WASM-кучи: без destroy она утекает на прогон
        if (typeof result.destroy === "function") {
          try {
            result.destroy();
          } catch {
            // Уже уничтожен — не важно
          }
        }
      }
    }
    emit({ id, ok: true, stdout: out, stderr: err, result: serializable });
  } catch (e) {
    // Ошибка python-кода (или рантайма) уходит модели как обычный результат
    // инструмента — она сама её исправит
    emit({ id, ok: false, stdout: out, stderr: err, error: String(e) });
  }
}

self.onmessage = (event) => {
  const { id, code } = event.data;
  runChain = runChain.then(() => runOne(id, code));
};
