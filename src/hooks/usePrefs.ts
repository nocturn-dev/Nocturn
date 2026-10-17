import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

/**
 * Префы UI в localStorage: каждая пара «useState с чтением из localStorage +
 * эффект персистентности» из App.tsx заменена одним вызовом. Имена и
 * семантика значений сохранены; ключ — строковая константа в месте вызова.
 *
 * Запись идёт только после реального изменения сеттером, не при монтировании:
 * непризнанное сохранённое значение (например, "true" при def=false) иначе
 * молча перезаписывалось бы дефолтным кодированием при каждом старте без
 * возможности отката, а неинициализированный ключ — заполнялся бы дефолтом.
 */

/** Общий механизм «пишем в localStorage только после set-вызова»:
 *  реф-флаг переживает ре-рендеры и не срабатывает на повторном
 *  монтировании в StrictMode (эффект там выполняется дважды) */
function useWriteOnChange<T>(key: string, value: T, encode: (v: T) => string) {
  const dirty = useRef(false);
  const setDirty = useCallback(() => {
    dirty.current = true;
  }, []);
  useEffect(() => {
    if (!dirty.current) return;
    localStorage.setItem(key, encode(value));
    // encode — чистая функция над value, в deps не нужна
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);
  return setDirty;
}

/** Булев флаг: def=false читается как ==="1", def=true — как !=="0" */
export function useBoolPref(key: string, def: boolean) {
  const [v, setV] = useState(() =>
    def ? localStorage.getItem(key) !== "0" : localStorage.getItem(key) === "1",
  );
  const markDirty = useWriteOnChange(key, v, (x) => (x ? "1" : "0"));
  const update = useCallback(
    (action: SetStateAction<boolean>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  return [v, update] as const;
}

/** Строка-преф; дженерик сохраняет литеральный тип (напр. "left" | "right") */
export function useStringPref<T extends string = string>(key: string, def: T) {
  const [v, setV] = useState<T>(
    () => (localStorage.getItem(key) as T | null) ?? def,
  );
  const markDirty = useWriteOnChange(key, v, (x) => x);
  const update = useCallback(
    (action: SetStateAction<T>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  return [v, update] as const;
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
  const markDirty = useWriteOnChange(key, v, (x) => String(x));
  const update = useCallback(
    (action: SetStateAction<number>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  return [v, update] as const;
}
