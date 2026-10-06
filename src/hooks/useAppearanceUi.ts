import { STORAGE_KEYS } from "../storageKeys";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Theme } from "../types";
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from "../appearance";
import { loadThemeProfiles, saveThemeProfiles, type ThemeProfile } from "../themeProfiles";
import { setTrayVariant } from "../api";

/**
 * Домен «Оформление»: тема (dark/light), стекло, кастомизация (акцент, стиль,
 * масштаб…) и профили внешнего вида. Каждый слой применяется мгновенно и
 * запоминается; иконка трея следует за знаком приложения.
 */
export function useAppearanceUi() {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(STORAGE_KEYS.theme) === "light" ? "light" : "dark",
  );
  const [glass, setGlass] = useState(
    () => localStorage.getItem("haloui-glass") === "1",
  );
  // Кастомизация оформления (акцент, стиль тёмной, масштаб, шрифт терминала)
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  // Профили внешнего вида: именованные пресеты (Theme + Appearance)
  const [themeProfiles, setThemeProfiles] = useState<ThemeProfile[]>(loadThemeProfiles);

  // Тема применяется мгновенно и запоминается.
  // Official и Full Claude всегда тёмные: светлая не применяется, пока
  // включена любая из них
  useEffect(() => {
    const forceDark = appearance.official || appearance.fullClaude;
    document.documentElement.classList.toggle("light", theme === "light" && !forceDark);
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme, appearance.official, appearance.fullClaude]);

  // Авто-тема: opt-in. off — тема только ручная; system — следуем ОС;
  // schedule — светлый интервал дня (может переходить через полночь).
  // Ручной выбор при включённом режиме перекрывается на следующей проверке —
  // это ожидаемое поведение режима, подсказка в UI об этом говорит.
  useEffect(() => {
    const mode = appearance.themeAuto ?? "off";
    if (mode === "off") return;
    const apply = () => {
      if (mode === "system") {
        if (typeof window.matchMedia !== "function") return;
        setTheme(
          window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
        );
        return;
      }
      const parse = (s: string) => {
        const [h, m] = s.split(":").map(Number);
        return (Number.isFinite(h) ? (h as number) : 8) * 60 + (Number.isFinite(m) ? (m as number) : 0);
      };
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const dayStart = parse(appearance.autoDay ?? "08:00");
      const nightStart = parse(appearance.autoNight ?? "20:00");
      const isDay =
        dayStart <= nightStart
          ? cur >= dayStart && cur < nightStart
          : cur >= dayStart || cur < nightStart;
      setTheme(isDay ? "light" : "dark");
    };
    apply();
    if (mode === "system") {
      if (typeof window.matchMedia !== "function") return;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    const iv = window.setInterval(apply, 60_000);
    return () => window.clearInterval(iv);
  }, [appearance.themeAuto, appearance.autoDay, appearance.autoNight, setTheme]);

  // Эффект стекла — независимый слой поверх любой темы. Full Claude
  // вне этого каскада: глобальный тумблер в теме не действует, вместо него —
  // свой (fullClaudeGlass), с теми же CSS-правилами html.glass
  useEffect(() => {
    const glassOn =
      (glass && !appearance.fullClaude) ||
      (appearance.fullClaude && (appearance.fullClaudeGlass ?? false));
    document.documentElement.classList.toggle("glass", glassOn);
    localStorage.setItem("haloui-glass", glass ? "1" : "0");
  }, [glass, appearance.fullClaude, appearance.fullClaudeGlass]);

  // Кастомизация: DOM-переменные применяются мгновенно (drag слайдера —
  // живой превью), а побочные эффекты — хвостом с дебаунсом. Без него тик
  // драга (~60/с) тянул бы синхронный localStorage.setItem и IPC в трей,
  // где set_tray_variant ре-декодит PNG иконки, хотя markStyle за весь
  // драг мог не измениться ни разу
  useEffect(() => {
    applyAppearance(appearance);
    const timer = window.setTimeout(() => saveAppearance(appearance), 250);
    return () => window.clearTimeout(timer);
  }, [appearance]);

  // Иконка трея — только при реальной смене знака; на старте реф пустой,
  // поэтому первая установка (как раньше — на монтировании) проходит
  const trayMark = useRef<string | null>(null);
  useEffect(() => {
    if (trayMark.current === appearance.markStyle) return;
    trayMark.current = appearance.markStyle;
    void setTrayVariant(appearance.markStyle).catch(() => {});
  }, [appearance.markStyle]);

  // Профили внешнего вида: персистентность
  useEffect(() => {
    saveThemeProfiles(themeProfiles);
  }, [themeProfiles]);

  // Применение профиля одним кликом: подмена темы и оформления целиком
  // (glass — отдельный тумблер, в профиль не входит и не трогается)
  const applyThemeProfile = useCallback((p: ThemeProfile) => {
    setTheme(p.theme);
    setAppearance(p.appearance);
  }, []);

  return {
    theme,
    setTheme,
    glass,
    setGlass,
    appearance,
    setAppearance,
    themeProfiles,
    setThemeProfiles,
    applyThemeProfile,
  };
}
