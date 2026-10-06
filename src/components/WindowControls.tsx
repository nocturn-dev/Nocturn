import { STORAGE_KEYS } from "../storageKeys";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hideToTray, windowToggleMaximize } from "../api";
import { useLang } from "../locales";

/**
 * Кнопки окна (свернуть / развернуть / закрыть) для безрамочного режима:
 * нативный титлбар убран (decorations: false), управление перенесено в
 * шапку приложения. Кнопки — в правом верхнем углу.
 *
 * Осознанно ЕДИНЫЕ Windows-стиль кнопки на всех ОС (в т.ч. macOS):
 * нативный светофор потребовал бы titleBarStyle/hiddenTitle и отдельной
 * раскладки шапки под инсеты слева, а продукт декларирует Windows-first
 * (README). Drag-зоны и double-click-maximize платформонезависимы.
 */
export default function WindowControls() {
  const { t } = useLang();
  // В браузерном превью (без Tauri) кнопки не работают — прячем
  const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  // Кнопка fullscreen (⤢) убрана: путалась с maximize, а переход
  // fullscreen↔оконный у безрамочных окон дёргает DWM на любом железе.
  // Полноэкранный режим остался назначаемым действием в «Горячих клавишах»
  // (toggle_fullscreen), тумблер «всегда в полный экран» — опция на будущее
  if (!tauri) {
    return null;
  }
  const win = getCurrentWindow();
  const btn =
    "flex h-full w-11 items-center justify-center text-halo-muted transition-colors";

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        onClick={() => void win.minimize()}
        title={t("win.min")}
        className={`${btn} hover:bg-halo-hover hover:text-halo-text`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        onClick={() => {
          // Анимированный разворот/восстановление в рабочую область монитора
          // (Rust). Нативный maximize для безрамочного окна ломает циклы
          // maximize↔restore (чёрные полосы, съехавшая картинка) — tao#471
          void windowToggleMaximize().catch(() => void win.toggleMaximize());
        }}
        title={t("win.max")}
        className={`${btn} hover:bg-halo-hover hover:text-halo-text`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
        </svg>
      </button>
      <button
        onClick={() => {
          // «Скрывать в трей»: крестик прячет окно, выход — из меню трея
          if (localStorage.getItem(STORAGE_KEYS.closeToTray) === "1") {
            void hideToTray().catch(() => win.close());
          } else {
            void win.close();
          }
        }}
        title={t("win.close")}
        className={`${btn} hover:bg-red-500/90 hover:text-white`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
