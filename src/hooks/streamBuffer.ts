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

  /** Выдать накопленное и очистить буфер */
  drain(): {
    main: Array<[string, DeltaAppend]>;
    subThoughts: Array<[string, string]>;
  } {
    const main = Array.from(this.main.entries());
    const subThoughts = Array.from(this.subThoughts.entries());
    this.main.clear();
    this.subThoughts.clear();
    return { main, subThoughts };
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
 * Гэп в порядковых номерах событий потока (ZCode-паттерн, блок 12): seq
 * проставляет бекенд, пропуск означает потерянное событие между каналами
 * или от другого источника (будущие фоновые прогоны). seq до первого
 * события неизвестен — не гэп.
 */
export function isSeqGap(last: number, next: number): boolean {
  return last >= 0 && next > last + 1;
}
