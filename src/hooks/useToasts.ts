import { useCallback, useState } from "react";
import { uid } from "./useAgentRun";

/**
 * Плавающие уведомления (чекпоинты, «чат сохранён» и пр.) — стек до 4,
 * авто-скрытие 4.2 с. Рендер — components/Toast.tsx.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const addToast = useCallback((text: string) => {
    const id = uid();
    setToasts((prev) => [...prev.slice(-3), { id, text }]);
    window.setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      4200,
    );
  }, []);
  return { toasts, addToast };
}
