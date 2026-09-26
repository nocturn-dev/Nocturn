import { useEffect, useState } from "react";

/**
 * Префы UI в localStorage: каждая пара «useState с чтением из localStorage +
 * эффект персистентности» из App.tsx заменена одним вызовом. Имена и
 * семантика значений сохранены; ключ — строковая константа в месте вызова.
 */

/** Булев флаг: def=false читается как ==="1", def=true — как !=="0" */
export function useBoolPref(key: string, def: boolean) {
  const [v, setV] = useState(() =>
    def ? localStorage.getItem(key) !== "0" : localStorage.getItem(key) === "1",
  );
  useEffect(() => {
    localStorage.setItem(key, v ? "1" : "0");
  }, [key, v]);
  return [v, setV] as const;
}

/** Строка-преф; дженерик сохраняет литеральный тип (напр. "left" | "right") */
export function useStringPref<T extends string = string>(key: string, def: T) {
  const [v, setV] = useState<T>(
    () => (localStorage.getItem(key) as T | null) ?? def,
  );
  useEffect(() => {
    localStorage.setItem(key, v);
  }, [key, v]);
  return [v, setV] as const;
}

/**
 * Число-преф. validate получает сырой Number(...) (NaN, если ключа нет) —
 * фолбэк/кламп/миграция старых значений целиком на его совести.
 */
export function useNumPref(
  key: string,
  fallback: number,
  validate?: (v: number) => number,
) {
  const [v, setV] = useState(() => {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return validate ? validate(n) : isNaN(n) ? fallback : n;
  });
  useEffect(() => {
    localStorage.setItem(key, String(v));
  }, [key, v]);
  return [v, setV] as const;
}
