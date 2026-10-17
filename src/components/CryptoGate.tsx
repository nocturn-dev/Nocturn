import { useEffect, useMemo, useState } from "react";
import NocturnMark from "./NocturnMark";
import { useLang } from "../locales";
import { XSmallIcon } from "./cards/icons";

/**
 * Полноэкранный гейт мастер-пароля:
 *  - setup=false: ввод пароля для разблокировки хранилища;
 *  - setup=true: первый запуск шифрования — придумать пароль (два поля).
 * Вызывает onSubmit(password); false — неверный пароль, исключение — сбой
 * операции (показывается иначе: перебор паролей при падении бекенда только
 * навредил бы). onCancel показывают крестик + Esc — только когда гейт можно
 * отложить (открыт из тумблера; на старте, где шифрование включено, отмены
 * нет).
 */

/** Оценка силы пароля: 0 — слабый, 1 — средний, 2 — надёжный. Классы
 *  символов + длина; кириллица учитывается классом «прочее» */
const pwStrength = (pw: string): 0 | 1 | 2 => {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^a-zA-Z\d]/.test(pw)) classes++;
  if (pw.length >= 12 && classes >= 3) return 2;
  if (pw.length >= 8 && classes >= 2) return 1;
  return 0;
};

/** Иконка «показать/скрыть пароль» */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M2 2l20 20" />}
    </svg>
  );
}

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
  // wrong — неверный пароль/нестыковка полей; fail — сбой операции
  // (IPC, ограничение попыток): разный текст, разная реакция пользователя
  const [error, setError] = useState<"wrong" | "fail" | null>(null);
  // Локальный гард повторного сабмита: проп busy до прихода ответа не
  // обновляется, и Enter успевал запустить двойное выключение шифрования
  const [submitting, setSubmitting] = useState(false);
  // «Забыли пароль» — разрушающая операция: сначала показываем подтверждение
  // с обязательным вводом RESET, один клик по ссылке больше не стирает ключи
  const [resetArmed, setResetArmed] = useState(false);
  const [resetText, setResetText] = useState("");
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const strength = useMemo(() => (setup && pw ? pwStrength(pw) : null), [setup, pw]);
  const locked = busy || submitting;

  const submit = async () => {
    if (locked) return;
    // Минимум 8 — контракт бекенда (crypto_setup): раньше фронт пускал
    // короче, и создание падало уже на стороне Rust
    if (setup && pw.length < 8) {
      setError("wrong");
      return;
    }
    if (setup && pw !== pw2) {
      setError("wrong");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const ok = await onSubmit(pw);
      if (!ok) setError("wrong");
    } catch {
      // Сбой операции/ограничение попыток — не «неверный пароль»
      setError("fail");
    } finally {
      setSubmitting(false);
    }
  };

  const pwInputCls =
    "w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 pr-9 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-60";
  const eyeBtn = (open: boolean) => (
    <button
      type="button"
      onClick={() => setShowPw((v) => !v)}
      title={open ? t("gate.hidePw") : t("gate.showPw")}
      aria-label={open ? t("gate.hidePw") : t("gate.showPw")}
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
    >
      <EyeIcon open={open} />
    </button>
  );

  return (
    <div className="fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-halo-bg">
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
            <XSmallIcon />
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

        <div className="relative mt-5 w-full">
          <input
            type={showPw ? "text" : "password"}
            value={pw}
            autoFocus
            disabled={locked}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()}
            placeholder={
              setup ? t("gate.createPh") : t("gate.unlockPh")
            }
            className={pwInputCls}
          />
          {eyeBtn(showPw)}
        </div>
        {setup && (
          <>
            <input
              type={showPw ? "text" : "password"}
              value={pw2}
              disabled={locked}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && !e.nativeEvent.isComposing && submit()
              }
              placeholder={t("gate.confirmPh")}
              className={`relative mt-2.5 ${pwInputCls}`}
            />
            {strength !== null && (
              <p
                className={`mt-1.5 self-start text-[0.6875rem] font-medium ${
                  strength === 2
                    ? "text-emerald-400"
                    : strength === 1
                      ? "text-amber-400"
                      : "text-red-400"
                }`}
              >
                {strength === 2
                  ? t("gate.pwStrong")
                  : strength === 1
                    ? t("gate.pwMid")
                    : t("gate.pwWeak")}
              </p>
            )}
            <p className="mt-1.5 text-center text-[0.625rem] leading-relaxed text-amber-400/80">
              {t("gate.noRestore")}
            </p>
          </>
        )}
        {error === "wrong" && (
          <p className="mt-2 text-xs text-red-400">{t("gate.wrong")}</p>
        )}
        {error === "fail" && (
          <p className="mt-2 text-xs text-red-400">{t("gate.fail")}</p>
        )}

        <button
          onClick={submit}
          disabled={locked}
          className="mt-5 w-full rounded-lg bg-halo-accent py-2 text-sm font-medium text-halo-on-accent shadow-sm press hover:bg-halo-accent-deep disabled:opacity-50"
        >
          {setup
            ? t("gate.createBtn")
            : intent === "disable"
              ? t("gate.disableBtn")
              : t("gate.unlockBtn")}
        </button>

        {!setup && onReset && (
          resetArmed ? (
            <div className="mt-4 w-full">
              <p className="text-center text-[0.625rem] leading-relaxed text-red-400">
                {t("gate.resetWarn")}
              </p>
              <input
                value={resetText}
                autoFocus
                onChange={(e) => setResetText(e.target.value)}
                onKeyDown={(e) => {
                  // Гард busy: подтверждение по Enter не должно уйти дважды
                  if (
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing &&
                    resetText === "RESET" &&
                    !locked
                  ) {
                    onReset();
                  }
                }}
                placeholder="RESET"
                className="mt-2 w-full rounded-lg border border-red-400/40 bg-halo-surface px-3 py-1.5 text-center text-xs text-halo-text outline-none focus:border-red-400"
              />
              <div className="mt-1.5 flex gap-2">
                <button
                  disabled={resetText !== "RESET" || locked}
                  onClick={() => {
                    setResetArmed(false);
                    setResetText("");
                    onReset();
                  }}
                  className="flex-1 rounded-lg border border-red-400/50 py-1.5 text-[0.6875rem] text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40"
                >
                  {t("gate.resetConfirm")}
                </button>
                <button
                  onClick={() => {
                    setResetArmed(false);
                    setResetText("");
                  }}
                  className="rounded-lg px-3 py-1.5 text-[0.6875rem] text-halo-muted transition-colors hover:text-halo-text"
                >
                  {t("gate.resetCancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setResetArmed(true)}
              className="mt-4 text-[0.6875rem] text-halo-muted/60 transition-colors hover:text-red-400"
            >
              {t("gate.reset")}
            </button>
          )
        )}
        <p className="mt-4 text-center text-[0.625rem] leading-relaxed text-halo-muted/50">
          {t("gate.note")}
        </p>
      </div>
    </div>
  );
}
