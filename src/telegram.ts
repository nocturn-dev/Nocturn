/**
 * Уведомления Telegram (фаза 1): тонкая обёртка над бекендом. Кэш конфига
 * здесь — ТОЛЬКО оптимизация IPC: Rust перепроверяет enabled/тумблер события/
 * привязку на каждом вызове, поэтому локальная стале-копия не может ничего
 * лишнего отправить. Вне Tauri и на любом отказе — тихий no-op: чат не
 * должен зависеть от доступности Telegram.
 */
import { telegramGetConfig, telegramNotify as notifyInvoke, type TelegramConfig } from "./api";

let cached: TelegramConfig | null = null;

/** Читает конфиг с бекенда (вызывается один раз при старте App) */
export function refreshTelegramConfig(): void {
  void telegramGetConfig()
    .then((c) => {
      cached = c;
    })
    .catch(() => {
      cached = null;
    });
}

/** Секция «Интеграций» обновляет кэш сразу после сохранения конфига */
export function telegramConfigCacheUpdated(c: TelegramConfig): void {
  cached = c;
}

export type TelegramNotifyKind = "start" | "finish" | "error" | "confirm";

/** Fire-and-forget: вне Tauri / выключено / не привязано — тихий no-op */
export function telegramNotify(kind: TelegramNotifyKind, text: string): void {
  const c = cached;
  if (!c?.enabled || !c.chatId) return;
  const on =
    kind === "start"
      ? c.notifyStart
      : kind === "finish"
        ? c.notifyFinish
        : kind === "error"
          ? c.notifyError
          : c.notifyConfirm;
  if (!on) return;
  void notifyInvoke(kind, text).catch(() => {});
}
