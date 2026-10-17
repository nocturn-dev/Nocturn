/**
 * Платформо-осознанные ветки фронтенда. UA-сниффинг по OS-токенам Tauri
 * WebView (Windows NT / Macintosh / X11|Linux) — достаточно для двух-трёх
 * веток без новой зависимости @tauri-apps/plugin-os.
 */

export type Platform = "windows" | "macos" | "linux";

export function getPlatform(customUa?: string): Platform | null {
  const ua = customUa !== undefined
    ? customUa
    : typeof navigator !== "undefined"
      ? navigator.userAgent
      : null;
  if (!ua || typeof ua !== "string") return null;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  // Исключаем Android, где в строке UA присутствует Linux
  if (/Android/i.test(ua)) return null;
  if (/Linux|X11/i.test(ua)) return "linux";
  return null;
}

export function isWindows(customUa?: string): boolean {
  return getPlatform(customUa) === "windows";
}

/** ФС регистронезависима на Windows (NTFS) и macOS (APFS по умолчанию),
 *  регистрозависима на Linux (ext4) — сверка путей должна это учитывать */
export function fsIsCaseInsensitive(customUa?: string): boolean {
  const p = getPlatform(customUa);
  return p === "windows" || p === "macos";
}
