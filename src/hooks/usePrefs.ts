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
    try {
      localStorage.setItem(key, encode(value));
    } catch (e) {
      console.warn(`[usePrefs] failed to write localStorage key "${key}":`, e);
    }
    // encode — чистая функция над value, в deps не нужна
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);
  return setDirty;
}

/** Булев флаг: def=false читается как ==="1", def=true — как !=="0" */
export function useBoolPref(key: string, def: boolean) {
  const read = useCallback(
    () => (def ? localStorage.getItem(key) !== "0" : localStorage.getItem(key) === "1"),
    [key, def],
  );
  const [v, setV] = useState(read);
  const markDirty = useWriteOnChange(key, v, (x) => (x ? "1" : "0"));
  const update = useCallback(
    (action: SetStateAction<boolean>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        setV(def ? e.newValue !== "0" : e.newValue === "1");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, def]);
  return [v, update] as const;
}

/** Строка-преф; дженерик сохраняет литеральный тип (напр. "left" | "right").
 *  validate: проверка допустимости прочитанного из хранилища значения */
export function useStringPref<T extends string = string>(
  key: string,
  def: T,
  validate?: (val: string) => val is T,
) {
  const read = useCallback((): T => {
    const raw = localStorage.getItem(key);
    if (raw === null) return def;
    if (validate && !validate(raw)) return def;
    return raw as T;
  }, [key, def, validate]);
  const [v, setV] = useState<T>(read);
  const markDirty = useWriteOnChange(key, v, (x) => x);
  const update = useCallback(
    (action: SetStateAction<T>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        if (!validate || validate(e.newValue)) {
          setV(e.newValue as T);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, validate]);
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
  const read = useCallback(() => {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return validate ? validate(n) : isNaN(n) ? fallback : n;
  }, [key, fallback, validate]);
  const [v, setV] = useState(read);
  const markDirty = useWriteOnChange(key, v, (x) => String(x));
  const update = useCallback(
    (action: SetStateAction<number>) => {
      markDirty();
      setV(action);
    },
    [markDirty],
  );
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        const n = Number(e.newValue);
        setV(validate ? validate(n) : isNaN(n) ? fallback : n);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, fallback, validate]);
  return [v, update] as const;
}
