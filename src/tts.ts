import { ttsSpeak, ttsStop } from "./api";

/** Готовит markdown ответа к озвучке: код-блоки вслух — мусор, картинки
 *  нечитаемы, ссылки схлопываем в текст, разметку снимаем */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Говорящая сейчас карточка (сброс её индикатора): одновременно говорит
 *  одна — новая озвучка гасит прежнюю, бекенд убивает прежний процесс */
let activeReset: (() => void) | null = null;

/** Остановить озвучку и погасить индикатор говорящей карточки */
export function stopSpeaking(): void {
  const reset = activeReset;
  activeReset = null;
  reset?.();
  void ttsStop().catch(() => {});
}

/** Озвучить текст; включает индикатор карточки через setUi. Промис
 *  tts_speak разрешается по завершении речи (или после ttsStop) —
 *  индикатор гаснет сам, без опроса статуса */
export function speak(text: string, setUi: (on: boolean) => void): void {
  stopSpeaking();
  setUi(true);
  const reset = () => setUi(false);
  activeReset = reset;
  void ttsSpeak(speakableText(text))
    .catch(() => {})
    .finally(() => {
      // Индикатор гасим, только если говорящей всё ещё является эта
      // карточка: её мог перебить уже следующий speak
      if (activeReset === reset) {
        activeReset = null;
        reset();
      }
    });
}
