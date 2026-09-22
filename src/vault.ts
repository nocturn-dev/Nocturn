/**
 * Утилиты vault'а заметок (M-N1) и графа (M-N2, будущее).
 * Философия Obsidian: узлы — заметки, рёбра — [[вики-ссылки]] в тексте.
 */

export interface NoteMeta {
  file: string;
  title: string;
  updated: number;
}

export interface Note extends NoteMeta {
  content: string;
}

/** Извлекает все [[ссылки]] из markdown-текста (уникальные, по порядку) */
export function extractLinks(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\[\]\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const target = m[1].trim();
    if (target && !out.some((x) => x.toLowerCase() === target.toLowerCase())) {
      out.push(target);
    }
  }
  return out;
}

/**
 * Обратные ссылки: карта «заметка → кто на неё ссылается».
 * Сопоставление по заголовку, регистронезависимо.
 */
export function buildBacklinks(notes: Note[]): Map<string, NoteMeta[]> {
  const byTitle = new Map<string, NoteMeta>();
  for (const n of notes) {
    byTitle.set(n.title.toLowerCase(), n);
  }
  const map = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    for (const link of extractLinks(n.content)) {
      const target = byTitle.get(link.toLowerCase());
      if (!target || target.file === n.file) continue;
      const list = map.get(target.file) ?? [];
      if (!list.some((x) => x.file === n.file)) {
        list.push({ file: n.file, title: n.title, updated: n.updated });
      }
      map.set(target.file, list);
    }
  }
  return map;
}

/** Все ссылки заметки, разрешённые в существующие заметки */
export function resolveLinks(
  note: Note,
  notes: Note[],
): { resolved: NoteMeta[]; dangling: string[] } {
  const byTitle = new Map<string, NoteMeta>();
  for (const n of notes) {
    byTitle.set(n.title.toLowerCase(), n);
  }
  const resolved: NoteMeta[] = [];
  const dangling: string[] = [];
  for (const link of extractLinks(note.content)) {
    const target = byTitle.get(link.toLowerCase());
    if (target && target.file !== note.file) {
      if (!resolved.some((x) => x.file === target.file)) resolved.push(target);
    } else if (!target) {
      dangling.push(link);
    }
  }
  return { resolved, dangling };
}

/**
 * Разбор заметки-шага цепочки (M-N3): frontmatter в начале файла.
 * ---
 * agent: true
 * ---
 * Все заметки считаются шагами; agent — запускать шаг с инструментами.
 */
export function parseNotePrompt(content: string): { prompt: string; agent: boolean } {
  let text = content;
  let agent = false;
  const m = /^---\r?\n([[\s\S]]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    agent = /^\s*agent\s*:\s*true\s*$/m.test(m[1]);
    text = text.slice(m[0].length);
  }
  return { prompt: text.trim(), agent };
}

/** План цепочки: обход по [[ссылкам]] в порядке появления, без циклов */
export function buildChainPlan(
  notes: Note[],
  startFile: string,
  maxSteps = 12,
): Note[] {
  const byFile = new Map(notes.map((n) => [n.file, n]));
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
  const plan: Note[] = [];
  const visited = new Set<string>();

  const walk = (file: string) => {
    if (visited.has(file) || plan.length >= maxSteps) return;
    const note = byFile.get(file);
    if (!note) return;
    visited.add(file);
    plan.push(note);
    for (const link of extractLinks(note.content)) {
      const next = byTitle.get(link.toLowerCase());
      if (next) walk(next.file);
    }
  };
  walk(startFile);
  return plan;
}
