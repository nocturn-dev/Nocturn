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
import {
  telegramNotify as notifyInvoke,
  type TgButton,
  type TelegramNotifyKind,
} from "./api";

/** Неудачные отправки с момента старта: диагностика «уведомления не
 *  доходят» (сбитый токен, недоступный бот) без раскопок консоли */
let failures = 0;
export function telegramNotifyFailures(): number {
  return failures;
}

export function telegramNotify(
  kind: TelegramNotifyKind,
  text: string,
  buttons: TgButton[] = [],
): void {
  void notifyInvoke(kind, text, buttons).catch((e) => {
    // Чат от сбоя не зависит, но полная тишина прятала сам факт, что
    // уведомления не уходят
    failures++;
    console.warn(`telegram notify (${kind}) failed:`, e);
  });
}
