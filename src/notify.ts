/**
 * Уведомления о завершении задачи: тост Windows (tauri-plugin-notification)
 * + звук (WebAudio, без файлов). Срабатывает, только когда окно не в фокусе —
 * пользователь занят другим приложением.
 */

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { MsgKey } from "./locales";

export type NotifySound = "chime" | "ping" | "soft" | "custom";

// labelKey типизирован словарём: протухший ключ = ошибка компиляции,
// а не пустая кнопка в настройках
export const NOTIFY_SOUNDS: { id: NotifySound; labelKey: MsgKey }[] = [
  { id: "chime", labelKey: "notify.soundChime" },
  { id: "ping", labelKey: "notify.soundPing" },
  { id: "soft", labelKey: "notify.soundSoft" },
  { id: "custom", labelKey: "notify.soundCustom" },
];

export interface NotifyPrefs {
  enabled: boolean;
  sound: NotifySound;
  /** Имя импортированного файла — только для отображения в настройках */
  customName?: string;
}

const LS_KEY = "haloui-notify";

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { enabled: false, sound: "chime" };
    const p = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      enabled: p.enabled ?? false,
      sound:
        p.sound === "ping" || p.sound === "soft" || p.sound === "custom"
          ? p.sound
          : "chime",
      customName: p.customName,
    };
  } catch {
    return { enabled: false, sound: "chime" };
  }
}

export function saveNotifyPrefs(p: NotifyPrefs) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

/** Своя мелодия: data URL кешируется; грузится лениво из appdata */
let customAudioUrl: string | null = null;

/** Загрузить/обновить кеш своей мелодии; вернуть URL или null */
export async function refreshCustomSound(): Promise<string | null> {
  try {
    const { soundData } = await import("./api");
    customAudioUrl = await soundData();
  } catch {
    customAudioUrl = null;
  }
  return customAudioUrl;
}

/** Проиграть свою мелодию (если кеш пуст — подгрузить и сыграть) */
async function playCustom(): Promise<void> {
  const url = customAudioUrl ?? (await refreshCustomSound());
  if (!url) return; // не импортирована — тихо
  const el = new Audio(url);
  await el.play().catch(() => {});
}

/** Три коротких мелодии на осцилляторах — без аудиофайлов */
export function playSound(kind: NotifySound) {
  if (kind === "custom") {
    void playCustom();
    return;
  }
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const tone = (freq: number, at: number, dur: number, gain = 0.12, type: OscillatorType = "sine") => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, now + at);
      g.gain.linearRampToValueAtTime(gain, now + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.05);
    };
    if (kind === "chime") {
      // Классический «дзынь»: мажорная терция вниз
      tone(880, 0, 0.35);
      tone(1108.7, 0.12, 0.4);
    } else if (kind === "ping") {
      // Двойной пинг, как в мессенджерах
      tone(1174.7, 0, 0.12, 0.1, "triangle");
      tone(1174.7, 0.18, 0.16, 0.1, "triangle");
    } else {
      // Мягкий низкий «буль» — не раздражает
      tone(523.3, 0, 0.28, 0.09);
      tone(392, 0.1, 0.3, 0.07);
    }
    // Контекст закрывается сам после последнего тона
    setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // без звука — не критично
  }
}

/**
 * Уведомить о завершении: только если окно не в фокусе и тумблер включён.
 * title — локализованный заголовок («Задача завершена»), line2 —
 * «проект · модель», line3 — название задачи.
 */
export async function notifyTaskDone(
  prefs: NotifyPrefs,
  title: string,
  meta: string,
  task: string,
) {
  if (!prefs.enabled) return;
  // В фокусе — пользователь и так смотрит, не дёргаем
  if (document.hasFocus()) return;
  playSound(prefs.sound);
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) {
      await sendNotification({ title, body: [meta, task].filter((x) => x).join("\n") });
    }
  } catch {
    // нет разрешения/плагина — звук уже прозвучал
  }
}
