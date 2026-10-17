import { useCallback, useState } from "react";
import { uid } from "./useAgentRun";
import { motionScale } from "../motion";
import type { ToastItem, ToastKind } from "../components/Toast";

/**
 * Плавающие уведомления: короткие события (чекпоинт, сохранение).
 * Выход — двухфазный: сначала leaving-флаг включает exit-анимацию
 * (anim-fade-out), размонтирование — после её длительности. Таймер
 * умножается на --motion-scale: фиксированный таймер рубил бы
 * forwards-анимацию на середине при нестандартной скорости анимаций
 */

const SHOW_MS = 4200;
const EXIT_MS = 120; // = --motion-fast до множителя

export type { ToastItem };

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const addToast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = uid();
    setToasts((prev) => [...prev.slice(-3), { id, text, kind }]);
    window.setTimeout(
      () =>
        setToasts((prev) =>
          prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
        ),
      SHOW_MS,
    );
    window.setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      SHOW_MS + EXIT_MS * motionScale(),
    );
  }, []);
  return { toasts, addToast };
}
