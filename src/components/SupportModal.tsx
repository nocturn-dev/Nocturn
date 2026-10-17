/**
 * Окно «Поддержать проект»: два раздела (стейблкоины / нативная крипта),
 * у каждого адреса — QR и копирование в буфер одним кликом. Открывается
 * из настроек (кнопка с сердцем). Всё локально: QR — статика из public/.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLang } from "../locales";
import { copyText } from "../clipboard";
import { useOverlay } from "../hooks/useOverlay";

/** Реквизиты для поддержки проекта. Адреса сверены с QR-кодами кошелька */
const SECTIONS: {
  titleKey: "support.stableTitle" | "support.nativeTitle";
  wallets: {
    name: string;
    note?: "support.gasTron" | "support.gasBnb";
    address: string;
    qr: string;
  }[];
}[] = [
  {
    titleKey: "support.stableTitle",
    wallets: [
      {
        name: "USDT (TRON / TRC-20)",
        note: "support.gasTron",
        address: "TW6EbWXqUWkpW44PaDeAvZDNexyUUBqtYZ",
        qr: "support/qr-tron.png",
      },
      {
        name: "USDT / USDC (BNB Smart Chain / BEP-20)",
        note: "support.gasBnb",
        address: "0x02C547D8cE939F7c538A2fa0B91190e922b13055",
        qr: "support/qr-bnb.png",
      },
    ],
  },
  {
    titleKey: "support.nativeTitle",
    wallets: [
      {
        name: "BTC (Bitcoin Native SegWit)",
        address: "bc1q6kaqr330yd7lf0xasrxhkrrghnnanqvq2qwn24",
        qr: "support/qr-btc.png",
      },
      {
        name: "ETH (Ethereum / ERC-20)",
        address: "0x02C547D8cE939F7c538A2fa0B91190e922b13055",
        qr: "support/qr-eth.png",
      },
    ],
  },
];

/** Ключ кошелька для подсветки «скопировано»: по разделу + имени, не по
 * адресу — ETH и BNB делят один адрес, подсветка загоралась бы у обеих */
const walletKey = (si: number, wi: number) => `${si}:${wi}`;

export default function SupportModal({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  // Обратная связь копирования: ключ кошелька → «скопировано» / сбой на 1.6 с
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Только один активный таймер подсветки: повторный клик гасит предыдущий
  // обещание, а не оставляет конкурирующие setTimeout
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const flash = (key: string, ok: boolean) => {
    window.clearTimeout(flashTimer.current);
    setCopied(ok ? key : null);
    setFailed(ok ? null : key);
    flashTimer.current = window.setTimeout(() => {
      setCopied(null);
      setFailed(null);
    }, 1600);
  };
  const copy = (key: string, address: string) => {
    // copyText — единый путь с фолбэком WebKitGTK (clipboard.ts): прямой
    // navigator.clipboard на движках без clipboard API кидал синхронный
    // TypeError ещё до построения промиса, и .catch его не ловил.
    // Результат проверяем: пустое «скопировано» при провале записи хуже
    // его отсутствия — пользователь не узнает, что адрес не скопирован
    void copyText(address).then((ok) => flash(key, ok));
  };

  // Увеличенный QR: клик по миниатюре открывает просмотр поверх всего —
  // чтобы с телефона было удобно отсканировать
  const [zoom, setZoom] = useState<{ name: string; qr: string } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const overlay = useOverlay({
    open: true,
    onClose,
    containerRef: cardRef,
  });
  // Зум — отдельный слот стека поверх окна: первый Escape закрывает только
  // его, второй — само окно
  const zoomOverlay = useOverlay({
    open: zoom !== null,
    onClose: () => setZoom(null),
    containerRef: zoomRef,
  });

  return (
    <div
      className="anim-fade fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center overflow-y-auto bg-halo-scrim p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        {...overlay}
        aria-label={t("settings.support")}
        className="glass-pane max-h-[86vh] w-full max-w-md overflow-y-auto rounded-2xl border border-halo-line bg-halo-deep p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-halo-text">
            <span className="text-halo-accent">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </span>
            {t("settings.support")}
          </h2>
          <button
            onClick={onClose}
            title={t("common.close")}
            className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-halo-muted">
          {t("support.subtitle")}
        </p>

        {SECTIONS.map((section, si) => (
          <div key={section.titleKey} className="mt-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-halo-muted/70">
              {t(section.titleKey)}
            </p>
            <div className="mt-2 flex flex-col gap-2">
              {section.wallets.map((w, wi) => {
                const key = walletKey(si, wi);
                return (
                  <div
                    key={w.address + w.name}
                    className="flex items-start gap-3 rounded-xl border border-halo-line bg-halo-surface/50 p-2.5"
                  >
                    <img
                      src={w.qr}
                      alt={`QR ${w.name}`}
                      title={t("support.zoomHint")}
                      onClick={() => setZoom({ name: w.name, qr: w.qr })}
                      className="size-20 shrink-0 cursor-zoom-in rounded-lg border border-halo-line/60 bg-white"
                      loading="lazy"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-halo-text">{w.name}</p>
                      {w.note && (
                        <p className="mt-0.5 text-[0.625rem] leading-snug text-halo-muted/80">
                          {t(w.note)}
                        </p>
                      )}
                      <button
                        onClick={() => copy(key, w.address)}
                        title={w.address}
                        className={`mt-1 w-full truncate rounded-md border px-1.5 py-1 text-left font-mono text-[0.625rem] transition-colors ${
                          copied === key
                            ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-400"
                            : failed === key
                              ? "border-red-400/50 bg-red-400/10 text-red-400"
                              : "border-halo-line/70 bg-halo-deep/60 text-halo-muted hover:border-halo-accent/40 hover:text-halo-text"
                        }`}
                      >
                        {copied === key
                          ? t("support.copied")
                          : failed === key
                            ? t("support.copyFail")
                            : w.address}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* Отправка крипты необратима: перевод в сеть, не совпадающую с
            адресом, сжигает токены — предупреждаем до, а не после */}
        <p className="mt-3 text-[0.625rem] leading-snug text-halo-muted/60">
          {t("support.networkWarn")}
        </p>

        {/* Увеличенный QR: клик по миниатюре — просмотр, удобный для скана
            с телефона; клик мимо картинки закрывает. Портал в body: внутри
            карточки backdrop-filter создаёт containing block, и fixed inset-0
            растягивался только на карточку — «зум» был размером с превью */}
        {zoom &&
          createPortal(
            <div
              ref={zoomRef}
              tabIndex={-1}
              {...zoomOverlay}
              aria-label={zoom.name}
              className="anim-fade fixed inset-0 z-[var(--halo-z-modal-top)] flex flex-col items-center justify-center gap-4 bg-black/80 p-6 outline-none backdrop-blur-sm"
              onClick={() => setZoom(null)}
            >
              <img
                src={zoom.qr}
                alt={`QR ${zoom.name}`}
                onClick={(e) => e.stopPropagation()}
                className="w-[min(70vw,min(70vh,560px))] rounded-2xl bg-white shadow-2xl"
              />
              <p className="text-sm font-medium text-white">{zoom.name}</p>
              <p className="text-[0.6875rem] text-white/60">
                {t("support.zoomClose")}
              </p>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
