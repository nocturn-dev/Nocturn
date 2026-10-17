import { ttsSpeak, ttsStop } from "./api";
import { STORAGE_KEYS } from "./storageKeys";

/**
 * Готовит markdown ответа к озвучке: код-блоки вслух — мусор, картинки
 * нечитаемы, ссылки схлопываем в текст, разметку снимаем.
 *
 * Порядок замен важен и зафиксирован тестом: сначала блочные конструкции
 * (код, картинки), затем парные маркеры — от длинных к коротким (** до *,
 * __ до _), иначе короткий съедает открывающую скобку длинного.
 */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    // Эмфазис-пару снимаем только целиком; содержимое оставляем
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    // Подчёркивания — только пара на границе слова: подчёркивание внутри
    // идентификатора (snake_case_name) — часть имени, не разметка
    .replace(/(^|[^\p{L}\p{N}_])__([^_]+?)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_([^_]+?)_(?![\p{L}\p{N}_])/gu, "$1$2")
    // Звёздочка внутри слова в markdown выделяет — срезаем пару без гард
    .replace(/\*(?=\S)([^*\s][^*]*?)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Говорящая сейчас карточка (сброс её индикатора): одновременно говорит
 *  одна — новая озвучка гасит прежнюю, бекенд убивает прежний процесс */
let activeReset: (() => void) | null = null;
// Поколение говорящей сессии: stopSpeaking и новый speak увеличивают его,
// и пока speak ждёт ttsStop, пришедший поверх speak отменяет текущий
let activeGeneration = 0;

/** Остановить озвучку и погасить индикатор говорящей карточки */
export function stopSpeaking(): void {
  activeGeneration++;
  const reset = activeReset;
  activeReset = null;
  reset?.();
  void ttsStop().catch(() => {});
}

/** Ключ устройства вывода речи (localStorage): читается здесь, а не в
 *  вызывающих — селектор в «Основном» пишет его напрямую (паттерн
 *  haloui-mic-device) */
export const AUDIO_OUTPUT_KEY = STORAGE_KEYS.audioOutput;

// Оценка длительности речи для предохранителя: 8 символов/с — нижняя
// граница темпа синтеза (CJK медленнее латиницы), база — латентность запуска
const SPEAK_TIMEOUT_BASE_MS = 20_000;
const SPEAK_TIMEOUT_MS_PER_CHAR = 125;

/** Озвучить текст; включает индикатор карточки через setUi. Промис
 *  tts_speak разрешается по завершении речи (или после ttsStop) —
 *  индикатор гаснет сам, без опроса статуса */
export async function speak(text: string, setUi: (on: boolean) => void): Promise<void> {
  stopSpeaking();
  const generation = activeGeneration;
  // Стоп ждём ДО запуска новой речи: не ждать — бекенд мог отработать
  // в обратном порядке и поздний stop убил бы свежий синтез
  try {
    await ttsStop();
  } catch {
    // прежний процесс мог уже погаснуть — это не мешает начать новую речь
  }
  // Пока ждали стоп, пришёл другой speak/stop — наша речь не начинается
  if (generation !== activeGeneration) return;
  setUi(true);
  const reset = () => setUi(false);
  activeReset = reset;
  const output = (() => {
    try {
      return localStorage.getItem(AUDIO_OUTPUT_KEY) || null;
    } catch {
      return null;
    }
  })();
  // tts_speak может никогда не разрешиться (зависший процесс синтеза):
  // предохранитель гасит индикатор и добивает процесс через ttsStop
  const guard = window.setTimeout(() => {
    if (activeReset === reset) stopSpeaking();
  }, SPEAK_TIMEOUT_BASE_MS + text.length * SPEAK_TIMEOUT_MS_PER_CHAR);
  void ttsSpeak(speakableText(text), output)
    .catch(() => {})
    .finally(() => {
      window.clearTimeout(guard);
      // Индикатор гасим, только если говорящей всё ещё является эта
      // карточка: её мог перебить уже следующий speak
      if (activeReset === reset) {
        activeReset = null;
        reset();
      }
    });
}
