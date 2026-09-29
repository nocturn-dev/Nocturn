import type { WakeModel } from "./wake";

/**
 * Настройки Voice Wake («Jarvis-режим»). Живут в localStorage через
 * useBoolPref/useStringPref/useNumPref в App; сюда прокидываются одним
 * объектом в SettingsModal → MainSection.
 */
export interface VoiceSettings {
  /** Слушатель активационной фразы включён */
  wake: boolean;
  /** Ключ wake-модели (openWakeWord) */
  model: WakeModel;
  /** Порог score срабатывания 0.3–0.9 (выше — строже) */
  threshold: number;
  /** Озвучивать финальный ответ голосовой задачи (локальный SAPI) */
  ttsReply: boolean;
}

export const VOICE_MODEL_LABELS: Record<WakeModel, string> = {
  hey_jarvis: "Hey Jarvis",
  hey_mycroft: "Hey Mycroft",
};
