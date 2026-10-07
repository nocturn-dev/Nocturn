/**
 * Живой поиск по белому списку GitHub-репозиториев (замена файл/URL-импорта).
 *
 * Приватность по ТЗ владельца: ТЕКСТ ЗАПРОСА НЕ ПОКИДАЕТ МАШИНУ — в сеть
 * уходят только GET'ы за файлами проверенных репо (из персонального —
 * максимум IP соединения). Скачанное парсится локально (jbImport-машиной)
 * и фильтруется локально. Произвольные репо не поддерживаются: список
 * зашит и курируется — экосистема полна клонов со стилерами под видом
 * джейлбрейков (см. ANALYSIS.md).
 *
 * Годы — честные диапазоны из git-истории (даты коммитов файлов):
 * пофайловые даты через API стоили бы запрос на файл, поэтому для
 * растянутых по времени репо — диапазон, для репо-2026 — год создания.
 */

import type { JbImportDraft } from "./jbImport";

export interface JbSource {
  id: string;
  /** Подпись в UI */
  label: string;
  repo: string;
  branch: string;
  /** Год-диапазон происхождения (см. шапку модуля) */
  year: string;
  /** Какие файлы репо брать (путь относительно корня) */
  fileFilter: (path: string) => boolean;
  /** Парсер файла → черновики записей */
  parse: (path: string, text: string) => JbImportDraft[];
}

/** Модель провайдера из имени файла L1B3RT4S ("ANTHROPIC.mkd" → "ANTHROPIC") */
function l1bProvider(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.mkd$/i, "").replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
}

export const JB_SOURCES: JbSource[] = [
  {
    id: "l1b3rt4s",
    label: "L1B3RT4S (Pliny)",
    repo: "elder-plinius/L1B3RT4S",
    branch: "main",
    year: "2024-2026",
    fileFilter: (p) => p.toLowerCase().endsWith(".mkd") && !p.toLowerCase().includes("readme"),
    parse: (path, text) => {
      const drafts: JbImportDraft[] = [];
      const model = l1bProvider(path);
      const sections = text.split(/^#\s+/m);
      for (const s of sections.slice(1)) {
        const lines = s.split("\n");
        const name = (lines[0] ?? "").trim();
        const body = lines.slice(1).join("\n").split("\n## ")[0]?.trim() ?? "";
        if (body.length < 40 || !name || /^(license|readme)/i.test(name)) continue;
        drafts.push({ name, model, text: body, year: "2024-2026" });
      }
      return drafts;
    },
  },
  {
    id: "jb-archives",
    label: "jailbreak-archives",
    repo: "e2sy/jailbreak-archives",
    branch: "main",
    year: "2026",
    fileFilter: (p) =>
      p.includes("/") &&
      !p.startsWith(".") &&
      !p.startsWith("assets/") &&
      !/\.(md|yml|yaml|cff|svg|json|png|txt)$/i.test(p),
    parse: (path, text) => {
      const body = text.trim();
      if (body.length < 60) return [];
      // путь "Claude/sonnet4.6max.txt" → модель с версией из имени файла
      const [dir, file] = [path.split("/")[0] ?? "", path.split("/").pop() ?? ""];
      const model = /sonnet|4\.6|max|low|1st|2nd|3rd|patched|working/i.test(file)
        ? `${dir} ${file.replace(/\.[a-z0-9]+$/i, "")}`.trim()
        : dir;
      return [{ name: path, model, text: body, year: "2026" }];
    },
  },
  {
    id: "llm-corpus",
    label: "llm-jailbreak-corpus",
    repo: "Ryokudev1/llm-jailbreak-corpus",
    branch: "main",
    year: "2026",
    fileFilter: (p) => p.startsWith("specimens/") && p.toLowerCase().endsWith(".txt"),
    parse: (path, text) => {
      const body = text.trim();
      if (body.length < 40) return [];
      const base = (path.split("/").pop() ?? path).replace(/\.txt$/i, "");
      const family = path.split("/")[1] ?? "";
      const mm = /-(glm|opus|sonnet|gemini|grok|kimi|qwen|claude|gpt)(?:-(ru|en))?$/i.exec(base);
      const model = mm
        ? `${(mm[1] ?? "").toUpperCase()}${mm[2] ? `-${mm[2].toUpperCase()}` : ""}`
        : "см. файл";
      return [{ name: base, model: `${family}/${model}`, text: body, year: "2026" }];
    },
  },
  {
    id: "ai-jb-archive",
    label: "ai-jailbreak-archive",
    repo: "Mak-P90/ai-jailbreak-archive",
    branch: "main",
    year: "2026",
    fileFilter: (p) => p.toLowerCase() === "readme.md",
    parse: (_path, text) => {
      const drafts: JbImportDraft[] = [];
      const skip = ["disclaimer", "what this repository", "available prompts", "contents"];
      const sections = text.split(/^##\s+/m).slice(1);
      for (const s of sections) {
        const lines = s.split("\n");
        const title = (lines[0] ?? "").trim();
        if (skip.some((k) => title.toLowerCase().includes(k))) continue;
        const body = lines.slice(1).join("\n");
        const chunks: { name: string; body: string }[] = [];
        const subs = body.split(/^###\s+/m);
        if (subs.length > 1) {
          for (const sub of subs.slice(1)) {
            const sl = sub.split("\n");
            chunks.push({ name: (sl[0] ?? "").trim() || title, body: sl.slice(1).join("\n") });
          }
        } else {
          chunks.push({ name: title, body });
        }
        for (const c of chunks) {
          const clean = c.body.trim();
          if (clean.length < 120) continue;
          drafts.push({ name: c.name, model: "mixed", text: clean, year: "2026" });
        }
      }
      return drafts;
    },
  },
  {
    id: "arth",
    label: "Arth-шаблоны",
    repo: "Arth-Singh/Arth-Jailbreak-Templates",
    branch: "main",
    year: "2024-2025",
    fileFilter: (p) => p.startsWith("templates/") && !p.toLowerCase().includes("readme"),
    parse: (path, text) => {
      const mname = /^name:\s*(.+)$/m.exec(text);
      const mval = /^value:\s*>?-?\s*$/m.exec(text);
      const body = (mval ? text.slice(mval.index + mval[0].length) : text).trim();
      if (body.length < 40) return [];
      const name = (mname?.[1] ?? path.split("/").pop() ?? path).trim();
      return [{
        name,
        model: "шаблон",
        text: body,
        year: "2024-2025",
        tags: "template:yes",
      }];
    },
  },
];

/** URL списка файлов репо (GitHub trees API, 1 запрос на источник).
 * Никаких пользовательских данных в URL — только владелец/репо/ветка. */
export function sourceTreeUrl(s: JbSource): string {
  return `https://api.github.com/repos/${s.repo}/git/trees/${s.branch}?recursive=1`;
}

/** URL сырого файла репо. Тоже без чего-либо личного — путь в репо. */
export function sourceRawUrl(s: JbSource, path: string): string {
  return `https://raw.githubusercontent.com/${s.repo}/${s.branch}/${path}`;
}

export interface JbRemoteEntry extends JbImportDraft {
  sourceId: string;
  sourceLabel: string;
  path: string;
}

/** Кэш разбора в памяти сессии: один клик «Найти» качает источники,
 * последующие поиски по тому же кэшу — ноль сети до «Обновить» */
const cache = new Map<string, JbRemoteEntry[]>();

export function cachedEntries(): JbRemoteEntry[] {
  return [...cache.values()].flat();
}

/** Разобрать один файл источника в кэш-записи */
function stash(s: JbSource, path: string, text: string): void {
  const list = cache.get(s.id) ?? [];
  for (const d of s.parse(path, text)) {
    list.push({ ...d, sourceId: s.id, sourceLabel: s.label, path });
  }
  cache.set(s.id, list);
}

export interface JbFetchProgress {
  done: number;
  total: number;
  current: string;
}

/** Скачать и разобрать все источники. onProgress — для строки статуса.
 * Ошибки одного источника (лимит API/переезд) не роняют остальные —
 * источник пропускается, ошибки возвращаются списком. */
export async function fetchAllSources(
  fetchText: (url: string) => Promise<string>,
  onProgress?: (p: JbFetchProgress) => void,
): Promise<string[]> {
  const errors: string[] = [];
  cache.clear();
  for (let i = 0; i < JB_SOURCES.length; i++) {
    const s = JB_SOURCES[i]!;
    onProgress?.({ done: i, total: JB_SOURCES.length, current: s.label });
    try {
      const tree = JSON.parse(await fetchText(sourceTreeUrl(s))) as {
        tree?: { path?: string; type?: string }[];
      };
      const files = (tree.tree ?? [])
        .filter((x) => x.type === "blob" && typeof x.path === "string" && s.fileFilter(x.path))
        .map((x) => x.path as string);
      const texts = await Promise.all(
        files.map(async (p) => ({ p, t: await fetchText(sourceRawUrl(s, p)).catch(() => "") })),
      );
      for (const { p, t } of texts) {
        if (t) stash(s, p, t);
      }
    } catch (e) {
      errors.push(`${s.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  onProgress?.({ done: JB_SOURCES.length, total: JB_SOURCES.length, current: "" });
  return errors;
}
