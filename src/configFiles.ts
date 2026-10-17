import { hooksLoad, mcpListServers, type Hook, type McpServerCfg } from "./api";

/**
 * Сериализованные чтение-изменение-запись для исполняемых конфигов
 * (hooks.json, mcp.json). Их правят два независимых места — секции настроек
 * (хранят снапшот в стейте и пишут его целиком) и установка плагинов
 * (читает свежий файл, мерджит, пишет). Запись устаревшего снапшота
 * поверх свежего файла стирала параллельные правки, поэтому:
 *  1) все пары «прочитал → изменил → записал» идут через одну цепочку
 *     промисов на файл — такие пары не перемешиваются;
 *  2) секции настроек при записи сливают свой список со свежим файлом,
 *     сохраняя записи с незнакомыми им id (добавленные плагином, пока
 *     снапшот висел открытым) — см. mergeFreshIds в секциях.
 */

// Цепочки на тип файла: отказ одной операции не рвёт очередь (в цепочку
// идёт «проглоченный» вариант промиса, наружу возвращается исходный)
let hooksChain = Promise.resolve();
let mcpChain = Promise.resolve();

/** Атомарная правка hooks.json: mutate получает свежий список хуков и сам
 *  вызывает hooksSave внутри очереди. Возврат — результат mutate. */
export function withHooksFile<T>(
  mutate: (hooks: Hook[]) => Promise<T> | T,
): Promise<T> {
  const result = hooksChain.then(async () =>
    mutate((await hooksLoad()).hooks ?? []),
  );
  // В очередь идёт «проглоченный» вариант: отказ одной операции не рвёт её
  hooksChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Атомарная правка mcp.json: mutate получает свежий список серверов и сам
 *  вызывает mcpSaveServers внутри очереди. Возврат — результат mutate. */
export function withMcpServers<T>(
  mutate: (servers: McpServerCfg[]) => Promise<T> | T,
): Promise<T> {
  const result = mcpChain.then(async () => mutate(await mcpListServers()));
  mcpChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Слияние локального списка со свежим файлом: записи с id, которых нет в
 *  известном нам множестве (добавлены параллельным редактором, пока мы
 *  держали снапшот), сохраняются поверх нашей версии. knownIds — что было
 *  в снапшоте на момент его чтения с диска. */
export function mergeFreshIds<T>(
  ours: T[],
  fresh: T[],
  idOf: (item: T) => string,
  knownIds: Set<string>,
): T[] {
  const ourIds = new Set(ours.map(idOf));
  return [...ours, ...fresh.filter((x) => !knownIds.has(idOf(x)) && !ourIds.has(idOf(x)))];
}
