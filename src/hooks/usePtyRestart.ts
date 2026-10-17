import { useCallback, useEffect, useRef } from "react";
import { ptyKill } from "../api";

/**
 * Общий жизненный цикл PTY для терминалов (консоль панели и Hard-Mode):
 * одноразовое создание, рестарт после выхода шелла и глушение при
 * размонтировании. Логика раньше жила копией в каждом терминале и
 * расходилась: в окне рестарта ввод уходил в уже убитый канал, а cleanup
 * размонтирования мог отработать раньше, чем create вернётся.
 */

export function usePtyRestart(id: string) {
  const createdRef = useRef(false);
  // Блокиратор ввода: между kill и resolve create канал мёртв — печать
  // в него теряется, поэтому onData/keydown обязаны ждать успеха
  const restartingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (createdRef.current) void ptyKill(id).catch(() => {});
    };
  }, [id]);

  /** Первичное создание: no-op, пока шелл жив. false — поднять не вышло */
  const ensureCreated = useCallback(
    async (create: () => Promise<void>): Promise<boolean> => {
      if (createdRef.current) return true;
      if (restartingRef.current) return false;
      restartingRef.current = true;
      try {
        await create();
        createdRef.current = true;
        // create разрешился после размонтирования — глушим сами: cleanup
        // уже отработал с createdRef=false и шелл остался бы без хозяина
        if (!mountedRef.current) void ptyKill(id).catch(() => {});
        return true;
      } catch {
        return false;
      } finally {
        restartingRef.current = false;
      }
    },
    [id],
  );

  /**
   * Рестарт после выхода шелла: kill старого → create нового; createdRef
   * переводится в true только после успеха, иначе cleanup убил бы канал,
   * которого ещё нет, а ввод ушёл бы в несуществующий.
   */
  const restart = useCallback(
    async (create: () => Promise<void>): Promise<boolean> => {
      if (restartingRef.current) return false;
      restartingRef.current = true;
      try {
        if (createdRef.current) {
          await ptyKill(id).catch(() => {});
          createdRef.current = false;
        }
        await create();
        createdRef.current = true;
        if (!mountedRef.current) void ptyKill(id).catch(() => {});
        return true;
      } catch {
        createdRef.current = false;
        return false;
      } finally {
        restartingRef.current = false;
      }
    },
    [id],
  );

  return { createdRef, restartingRef, ensureCreated, restart };
}
