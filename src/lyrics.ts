export interface LyricLine {
  t: number;
  text: string;
}

/** LRC "[mm:ss.xx] строка" → отсортированные строки (плейн — t = -1).
 *  Вынесено из MediaBar (№52 аудита v5): чистый парсер внешних данных
 *  lrclib обязан иметь золотые векторы */
export function parseLyrics(synced: string | null, plain: string | null): LyricLine[] {
  if (synced) {
    const out: LyricLine[] = [];
    for (const row of synced.split("\n")) {
      const m = /^\s*\[(\d+):(\d+)(?:[.:](\d+))?\]\s*(.*)$/.exec(row);
      if (!m) continue;
      const mi = m[1];
      const se = m[2];
      const fr = m[3];
      const text = (m[4] ?? "").trim();
      if (!mi || !se || !text) continue;
      const t = Number(mi) * 60 + Number(se) + (fr ? Number(`0.${fr}`) : 0);
      out.push({ t, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  if (plain) {
    return plain
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => text)
      .map((text) => ({ t: -1, text }));
  }
  return [];
}
