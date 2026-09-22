import { useEffect, useState } from "react";
import NocturnMark from "./NocturnMark";
import { useLang } from "../locales";

/**
 * Полноэкранный гейт мастер-пароля:
 *  - setup=false: ввод пароля для разблокировки хранилища;
 *  - setup=true: первый запуск шифрования — придумать пароль (два поля).
 * Вызывает onSubmit(password); ошибка (неверный пароль) показывается здесь.
 * onCancel показывают крестик + Esc — только когда гейт можно отложить
 * (открыт из тумблера; на старте, где шифрование включено, отмены нет).
 */
export default function CryptoGate({
  setup,
  intent = "unlock",
  busy,
  onSubmit,
  onReset,
  onCancel,
}: {
  setup: boolean;
  /** unlock — вход при старте; disable — подтверждение выключения шифрования */
  intent?: "unlock" | "disable";
  busy?: boolean;
  onSubmit: (password: string) => Promise<boolean>;
  onReset?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useLang();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async () => {
    if (setup && pw.length < 4) {
      setError(true);
      return;
    }
    if (setup && pw !== pw2) {
      setError(true);
      return;
    }
    setError(false);
    const ok = await onSubmit(pw);
    if (!ok) setError(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-halo-bg">
      {/* Призрачный логотип фоном */}
      <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center opacity-[0.05]">
        <NocturnMark size={420} />
      </div>

      <div className="glass-pane anim-pop relative z-10 flex w-full max-w-sm flex-col items-center rounded-2xl border border-halo-line bg-halo-deep/90 p-8 shadow-2xl">
        {onCancel && (
          <button
            onClick={onCancel}
            title={t("gate.cancel")}
            className="absolute right-3 top-3 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            ✕
          </button>
        )}
        <span className="text-halo-accent">
          <NocturnMark size={44} />
        </span>
        <h2 className="mt-4 text-lg font-medium text-halo-text">
          {setup
            ? t("gate.createTitle")
            : intent === "disable"
              ? t("gate.disableTitle")
              : t("gate.unlockTitle")}
        </h2>
        <p className="mt-1.5 text-center text-xs leading-relaxed text-halo-muted">
          {setup
            ? t("gate.createSub")
            : intent === "disable"
              ? t("gate.disableSub")
              : t("gate.unlockSub")}
        </p>

        <input
          type="password"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={
            setup ? t("gate.createPh") : t("gate.unlockPh")
          }
          className="mt-5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        {setup && (
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t("gate.confirmPh")}
            className="mt-2.5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        )}
        {error && (
          <p className="mt-2 text-xs text-red-400">{t("gate.wrong")}</p>
        )}

        <button
          onClick={submit}
          disabled={busy}
          className="mt-5 w-full rounded-lg bg-halo-accent py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-halo-accent-deep disabled:opacity-50"
        >
          {setup
            ? t("gate.createBtn")
            : intent === "disable"
              ? t("gate.disableBtn")
              : t("gate.unlockBtn")}
        </button>

        {!setup && onReset && (
          <button
            onClick={onReset}
            className="mt-4 text-[11px] text-halo-muted/60 transition-colors hover:text-red-400"
          >
            {t("gate.reset")}
          </button>
        )}
        <p className="mt-4 text-center text-[10px] leading-relaxed text-halo-muted/50">
          {t("gate.note")}
        </p>
      </div>
    </div>
  );
}
