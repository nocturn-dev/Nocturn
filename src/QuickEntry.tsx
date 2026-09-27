import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useLang } from "./locales";
import { loadSettings, quickentrySubmit } from "./api";
import { applyAppearance, loadAppearance } from "./appearance";
import { ArrowUpIcon, PaperclipIcon } from "./components/cards/icons";
import ProviderIcon, { shortModelName } from "./components/ProviderIcon";

/** Внешние поля окна: место для тени панели (тень окна выключена —
 *  DWM рисовал рамку вокруг прозрачного окна, «обводку по бокам») */
const PAD = 10;
/** Ширина окна: фикс, синхронна с tauri.conf.json */
const WIN_W = 540;

/** Кастомизация из localStorage → палитра html. Вызывается на старте и на
 *  каждом показе: окно живёт скрытым с момента запуска приложения, и тема,
 *  акцент или радиусы, сменённые в главном окне, иначе подтянулись бы только
 *  после рестарта */
function applyTheme() {
  try {
    const a = loadAppearance();
    applyAppearance(a);
    document.documentElement.classList.toggle(
      "light",
      localStorage.getItem("haloui-theme") === "light" && !a.official,
    );
  } catch {
    // нет сохранённой кастомизации — дефолтная палитра из index.css
  }
}

/**
 * Окно быстрого ввода (Quick Entry): второе frameless-окно поверх всех
 * приложений, внешность — как композер главного окна. Enter — задача уходит
 * в главное окно, окно прячется; Esc или потеря фокуса — спрятать.
 */
export function QuickEntry() {
  const { t } = useLang();
  const ref = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  // Модель для чипа внизу: текущее подключение из настроек (ключ может быть
  // зашифрован — для показа имени модели он не нужен)
  const [model, setModel] = useState("");

  useEffect(() => {
    applyTheme();
    // Прозрачное окно: фон body из index.css окрасил бы весь прямоугольник
    document.body.style.background = "transparent";
    ref.current?.focus();

    const win = getCurrentWindow();
    // Показ окна (глобальное комбо) → фокус в поле + перечитать тему
    let disposed = false;
    let un: (() => void) | undefined;
    void win
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        applyTheme();
        ref.current?.focus();
      })
      .then((u) => {
        if (disposed) u();
        else un = u;
      });

    // Высота окна — по контенту: масштаб шрифта/радиусы/переносы не должны
    // обрезаться фиксированной высотой из конфига
    const el = panelRef.current;
    let unro: (() => void) | undefined;
    let lastH = 0;
    if (el) {
      const fit = () => {
        const h = Math.ceil(el.getBoundingClientRect().height);
        if (Math.abs(h - lastH) < 1) return;
        lastH = h;
        void win.setSize(new LogicalSize(WIN_W, h + PAD * 2)).catch(() => {});
      };
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      unro = () => ro.disconnect();
      fit();
    }

    return () => {
      disposed = true;
      un?.();
      unro?.();
    };
  }, []);

  useEffect(() => {
    loadSettings()
      .then((s) => setModel(s.model))
      .catch(() => {});
  }, []);

  const hide = () => {
    // onBlur после hide() — повторный вызов безвреден
    getCurrentWindow().hide().catch(() => {});
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void quickentrySubmit(text).then(hide).catch(hide);
  };

  return (
    <div className="flex h-screen items-center justify-center p-2.5">
      {/* Облик композера главного окна. Без focus-within-обводки: поле здесь
          всегда в фокусе, акцентная рамка выглядела бы постоянной — в композере
          её видят только при фокусе */}
      <div
        ref={panelRef}
        className="glass-pane w-full rounded-2xl border border-halo-line bg-halo-surface p-2 shadow-lg"
      >
        <div className="flex items-center gap-1.5">
          <span className="flex size-9 shrink-0 items-center justify-center text-halo-muted">
            <PaperclipIcon />
          </span>
          <input
            ref={ref}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: энтер подтверждения IME не должен отправлять
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
              else if (e.key === "Escape") hide();
            }}
            onBlur={hide}
            placeholder={t("composer.placeholder")}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-halo-text outline-none placeholder:text-halo-muted"
          />
          <button
            onClick={submit}
            // preventDefault на mousedown: клик по кнопке иначе гасит фокус
            // поля, срабатывает onBlur и окно прячется до отправки
            onMouseDown={(e) => e.preventDefault()}
            disabled={!draft.trim()}
            title={t("composer.send")}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-halo-accent text-halo-on-accent shadow-sm transition duration-150 hover:bg-halo-accent-deep active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUpIcon />
          </button>
        </div>
        {/* Нижний ряд: подсказка слева, текущая модель справа — как в композере */}
        <div className="flex items-center gap-2 px-1 pt-1">
          <span className="text-[11px] text-halo-muted/70">{t("quickentry.hint")}</span>
          {model && (
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-halo-muted">
              <ProviderIcon modelId={model} size={14} />
              <span className="max-w-44 truncate font-medium text-halo-text/80">
                {shortModelName(model)}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
