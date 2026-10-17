import { useCallback, useState } from "react";

/** Проверка, что фокус находится в поле ввода: предотвращает перехват клавиш игр при печати текста */
export function isGameInputTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    target.contentEditable === "true" ||
    target.getAttribute("contenteditable") === "true"
  );
}

/** Безопасное чтение числового рекорда из localStorage */
export function readBest(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Единый хук управления рекордом игры: чтение, валидация и запись без побочных эффектов в рендере */
export function useBest(key: string) {
  const [best, setBestState] = useState<number | null>(() => readBest(key));

  const updateBest = useCallback(
    (value: number, mode: "max" | "min" = "max"): boolean => {
      if (!Number.isFinite(value)) return false;
      const current = readBest(key);
      const isRecord =
        current === null ||
        (mode === "max" ? value > current : value < current);

      if (isRecord) {
        setBestState(value);
        try {
          localStorage.setItem(key, String(value));
        } catch {
          // Игнорируем ошибки квоты хранилища в приватном режиме
        }
        return true;
      }
      return false;
    },
    [key],
  );

  return [best, updateBest] as const;
}
