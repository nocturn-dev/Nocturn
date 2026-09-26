/**
 * Платформо-осознанные ветки фронтенда. UA-сниффинг по OS-токенам Tauri
 * WebView (Windows NT / Macintosh / X11|Linux) — достаточно для двух-трёх
 * веток без новой зависимости @tauri-apps/plugin-os.
 */

export type Platform = "windows" | "macos" | "linux";

export function getPlatform(): Platform | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return null;
}

export function isWindows(): boolean {
  return getPlatform() === "windows";
}

/** ФС регистронезависима на Windows (NTFS) и macOS (APFS по умолчанию),
 *  регистрозависима на Linux (ext4) — сверка путей должна это учитывать */
export function fsIsCaseInsensitive(): boolean {
  const p = getPlatform();
  return p === "windows" || p === "macos";
}
