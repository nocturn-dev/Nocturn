import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "./storageKeys";

/**
 * Гард-механическое зеркало реестра storageKeys (аудит A5-5, паттерн
 * toolFilter.test): ключ из STORAGE_KEYS не имеет права встречаться сырым
 * литералом вне самого модуля — иначе вторая точка правды возрождается
 * молча. Одномодульные ключи (literally на месте) тест не трогает.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = walk(join(process.cwd(), "src")).filter(
  (f) => !f.endsWith("storageKeys.ts") && !f.includes(".test."),
);

describe("storageKeys — реестр мульти-модульных ключей", () => {
  it("значения в реестре уникальны и носят префикс haloui-", () => {
    const values = Object.values(STORAGE_KEYS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v.startsWith("haloui-")).toBe(true);
  });

  it("ключи реестра не встречаются сырыми литералами вне storageKeys.ts", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const key of Object.values(STORAGE_KEYS)) {
        if (text.includes(`"${key}"`)) offenders.push(`${file}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
