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
  // Компактные ghost-кнопки (не «хвост» на всю высоту шапки): скругление
  // и цвета из halo-токенов — живут в любой теме; красный только у
  // закрытия (семантика статуса, вне тем по конвенции)
  const btn =
    "flex size-7 items-center justify-center rounded-lg text-halo-muted transition-colors";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => {
          // Сбой сворачивания маловероятен, но молча проглатывать его тоже
          // нельзя: кнопка «не работает» без всякой диагностики
          void win.minimize().catch((e) => console.warn("[nocturn] minimize:", e));
        }}
        title={t("win.min")}
        className={`${btn} hover:bg-halo-hover hover:text-halo-text`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        onClick={() => {
          // Анимированный разворот/восстановление в рабочую область монитора
          // (Rust). Нативный maximize для безрамочного окна ломает циклы
          // maximize↔restore (чёрные полосы, съехавшая картинка) — tao#471,
          // поэтому при сбое нативный toggleMaximize как фолбэк не зовём:
          // он возвращает ровно тот баг, от которого ушли
          void windowToggleMaximize().catch((e) =>
            console.warn("[nocturn] toggle maximize:", e),
          );
        }}
        title={t("win.max")}
        className={`${btn} hover:bg-halo-hover hover:text-halo-text`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
        </svg>
      </button>
      <button
        onClick={() => {
          // «Скрывать в трей»: крестик прячет окно, выход — из меню трея.
          // Если трей недоступен, окно НЕ закрываем: пользователь выбрал
          // «скрыть», а не «выйти», потерять сеанс из-за сбоя трея — потеря данных
          if (localStorage.getItem(STORAGE_KEYS.closeToTray) === "1") {
            void hideToTray().catch((e) =>
              console.warn("[nocturn] hide to tray:", e),
            );
          } else {
            void win.close();
          }
        }}
        title={t("win.close")}
        className={`${btn} hover:bg-red-500/90 hover:text-white`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
