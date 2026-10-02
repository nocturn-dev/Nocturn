/**
 * Уведомления Telegram: тонкая fire-and-forget обёртка над бекендом.
 *
 * ВАЖНО (урок «ноль уведомлений»): здесь НЕТ локальных гейтов. Первая
 * версия кэшировала конфиг и молча отбрасывала вызовы, если в кэше не было
 * chat_id — а привязка (/start) происходила уже после кэширования, и кэш
 * навсегда оставался пустым. Решение: решение о отправке принимает ТОЛЬКО
 * бекенд (enabled + привязка + тумблер события перепроверяются в
 * telegram_notify на каждый вызов); лишний IPC дешевле потерянных
 * уведомлений. Отказы тихие: чат не зависит от доступности Telegram.
 */
import { telegramNotify as notifyInvoke, type TgButton } from "./api";

export type TelegramNotifyKind =
  | "start"
  | "finish"
  | "error"
  | "confirm"
  | "ask";

export function telegramNotify(
  kind: TelegramNotifyKind,
  text: string,
  buttons: TgButton[] = [],
): void {
  void notifyInvoke(kind, text, buttons).catch(() => {});
}
