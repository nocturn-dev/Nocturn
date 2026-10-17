/**
 * Батчинг дельт потокового стриминга.
 * Каждая SSE-дельта приходит отдельным Tauri-событием, а React между
 * событиями не батчит: setSessions/setSubRuns на каждую дельту ре-рендерил
 * всё дерево до сотни раз в секунду. Дельты копятся здесь и сбрасываются
 * одним обновлением раз на кадр (rAF-цикл в useAgentRun).
 */

export interface DeltaAppend {
  content: string;
  thought: string;
}

interface MessageLike {
  id: string;
  content: string;
  thought?: string;
}

export class StreamDeltaBuffer {
  private main = new Map<string, DeltaAppend>();
  private subThoughts = new Map<string, string>();

  get isEmpty(): boolean {
    return this.main.size === 0 && this.subThoughts.size === 0;
  }

  /** Дельта основного сообщения ассистента */
  append(assistantId: string, delta: string, thought: string): void {
    const cur = this.main.get(assistantId) ?? { content: "", thought: "" };
    cur.content += delta;
    cur.thought += thought;
    this.main.set(assistantId, cur);
  }

  /** Thought-дельта субагента (патчится в subRuns[callId].thought) */
  appendSubThought(callId: string, text: string): void {
    this.subThoughts.set(callId, (this.subThoughts.get(callId) ?? "") + text);
  }

  /**
   * Применить накопленное и только после успешного применения очистить
   * буфер: сбой в колбэке (упавший setSessions и т.п.) оставляет дельты
   * внутри — следующий флаш повторит попытку, а не потеряет их безвозвратно.
   * Колбэку отдаются копии: мутировать отданное он не может испортить
   * то, что осталось в буфере при сбое.
   */
  drain(
    apply: (data: {
      main: Array<[string, DeltaAppend]>;
      subThoughts: Array<[string, string]>;
    }) => void,
  ): void {
    if (this.isEmpty) return;
    const data = {
      main: Array.from(
        this.main,
        ([id, d]): [string, DeltaAppend] => [id, { content: d.content, thought: d.thought }],
      ),
      subThoughts: Array.from(this.subThoughts.entries()),
    };
    apply(data);
    this.main.clear();
    this.subThoughts.clear();
  }
}

/**
 * Чисто применить дельты к массиву сообщений сессии: один проход, клонируются
 * только затронутые сообщения. Возвращает тот же массив, если дельт нет.
 */
export function applyMainDeltas<M extends MessageLike>(
  messages: M[],
  main: Array<[string, DeltaAppend]>,
): M[] {
  if (main.length === 0) return messages;
  const byId = new Map(main);
  return messages.map((m) => {
    const d = byId.get(m.id);
    if (!d) return m;
    return {
      ...m,
      content: m.content + d.content,
      thought: d.thought !== "" ? (m.thought ?? "") + d.thought : m.thought,
    };
  });
}

/**
 * Гэп в порядковых номерах событий потока (паттерн-референс, блок 12): seq
 * проставляет бекенд, пропуск означает потерянное событие между каналами
 * или от другого источника (будущие фоновые прогоны). seq до первого
 * события неизвестен — не гэп.
 */
export function isSeqGap(last: number, next: number): boolean {
  return last >= 0 && next > last + 1;
}
