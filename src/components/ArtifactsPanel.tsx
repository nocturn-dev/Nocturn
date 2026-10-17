import { useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../motion";
import { useLang } from "../locales";
import { XSmallIcon } from "./cards/icons";
import { useOverlay } from "../hooks/useOverlay";

/**
 * Правая панель Artifacts: живой предпросмотр HTML из ответов модели.
 * Рендер в sandbox-iframe без allow-same-origin: скрипты артефакта работают,
 * но у фрейма непрозрачный origin — localStorage/IPC/сеть наружу недоступны
 * (CSP-гейт тоже накрыт: connect-src 'self' непрозрачному origin не матчится).
 * Данные локальны по определению — HTML генерится моделью и рендерится тут же.
 */

export interface ArtifactView {
  /** HTML-код артефакта (полный текст ```html-блока) */
  html: string;
  /** Заголовок из первого <h1>/<title> или «Artifact» */
  title: string;
}

export function ArtifactsPanel({
  open,
  artifact,
  veil = false,
  onClose,
}: {
  open: boolean;
  artifact: ArtifactView | null;
  /** Живой артефакт ещё стримится: шиммер-вуаль поверх iframe */
  veil?: boolean;
  onClose: () => void;
}) {
  const { t } = useLang();
  const show = useDelayedUnmount(open, 200);
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay({
    open,
    onClose,
    containerRef: panelRef,
    // Панель, не модалка: фокус уходит из поля ввода при каждом открытии
    // только чтобы поймать Escape — ставим на сам контейнер, не на кнопку
    focusMode: "container",
  });

  // srcDoc меняется только по завершении стрима: обновление на каждый токен
  // перезагружало iframe целиком, скрипты артефакта перезапускались,
  // состояние и скролл сбрасывались. До конца стрима показываем предыдущую
  // зафиксированную версию (пустую — до первой)
  const [committed, setCommitted] = useState<ArtifactView | null>(artifact);
  useEffect(() => {
    if (!veil) setCommitted(artifact);
  }, [artifact, veil]);

  if (!show) return null;
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label={t("artifacts.title")}
      className={`fixed inset-y-0 right-0 z-[var(--halo-z-panel-top)] flex w-[560px] max-w-[92vw] flex-col border-l border-halo-line bg-halo-deep shadow-2xl outline-none ${open ? "anim-slide-left" : "anim-slide-left-out"}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-halo-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-halo-text">{t("artifacts.title")}</p>
          <p className="mt-0.5 truncate text-[0.6875rem] text-halo-muted">
            {artifact?.title ?? t("artifacts.empty")}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <XSmallIcon />
        </button>
      </div>
      {committed ? (
        <div className="relative min-h-0 flex-1">
          {/* sandbox без allow-same-origin: scripts работают, API браузера
              (storage/IPC/cookie) — нет; srcdoc изолирован от приложения.
              Живой артефакт стримится в ЭТОТ же фрейм — изоляция та же */}
          <iframe
            title={committed.title}
            srcDoc={committed.html}
            sandbox="allow-scripts allow-modals"
            className="h-full w-full border-0 bg-white"
          />
          {veil && <div className="shimmer absolute inset-0 bg-halo-deep/70" />}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-halo-muted/60">
          {veil ? t("artifacts.streaming") : t("artifacts.empty")}
        </p>
      )}
    </div>
  );
}
