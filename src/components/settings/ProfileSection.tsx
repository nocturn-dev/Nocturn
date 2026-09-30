import { useEffect, useRef, useState } from "react";
import { useLang, type MsgKey } from "../../locales";
import {
  loadProfile,
  saveProfile,
  type AnswersLang,
  type RoleId,
  type Tone,
  type UserProfile,
} from "../../userProfile";

/** Перекрывающиеся ручки: раскрытие при наведении делает блок «живым» */
function ShareToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={label}
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[0.625rem] transition-colors ${
        on
          ? "border-halo-accent/50 bg-halo-accent/10 text-halo-accent"
          : "border-halo-line text-halo-muted/70 hover:text-halo-text"
      }`}
    >
      {on ? `✓ ${label}` : label}
    </button>
  );
}

const ROLES: Exclude<RoleId, "">[] = [
  "software_engineer",
  "product",
  "design",
  "data",
  "student",
  "other",
];

const ROLE_KEYS: Record<Exclude<RoleId, "">, MsgKey> = {
  software_engineer: "profile.roleSE",
  product: "profile.roleProduct",
  design: "profile.roleDesign",
  data: "profile.roleData",
  student: "profile.roleStudent",
  other: "profile.roleOther",
};

const LANGS: Exclude<AnswersLang, "">[] = ["ru", "en", "zh", "ja"];
const TONES: Exclude<Tone, "">[] = ["neutral", "concise", "detailed", "friendly", "formal"];

/** Раздел «Профиль пользователя»: всё опционально, ничего не навязывается.
 *  Каждое личное поле — со своим тумблером «использовать для модели»:
 *  в промт уходит только явно разрешённое. Аватар — чистый UI. */
export function ProfileSection() {
  const { t } = useLang();
  const [p, setP] = useState<UserProfile>(() => loadProfile());
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarErr, setAvatarErr] = useState(false);

  // Сохранение на каждое изменение (localStorage — мгновенно), тумблеры
  // применяются к следующим запросам без кнопки «Сохранить»
  useEffect(() => {
    saveProfile(p);
  }, [p]);

  const set = (patch: Partial<UserProfile>) => setP((prev) => ({ ...prev, ...patch }));

  const pickAvatar = (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    if (f.size > 8 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Даунскейл до 256px: аватар живёт в localStorage, многометровые
        // фото раздули бы хранилище и экспорт настроек
        const side = 256;
        const scale = Math.min(1, side / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        try {
          set({ avatar: canvas.toDataURL("image/jpeg", 0.85) });
          setAvatarErr(false);
        } catch {
          setAvatarErr(true);
        }
      };
      img.onerror = () => setAvatarErr(true);
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  };

  const shareLabel = t("profile.share");

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.profile")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("profile.desc")}
      </p>

      {/* Кто ты */}
      <div className="rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm font-medium text-halo-text">{t("profile.who")}</p>
        <div className="mt-2.5 flex items-center gap-3">
          {p.avatar ? (
            <img
              src={p.avatar}
              alt=""
              className="size-14 shrink-0 cursor-pointer rounded-full border border-halo-line object-cover transition-opacity hover:opacity-80"
              onClick={() => fileRef.current?.click()}
              title={t("profile.avatarChange")}
            />
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              className="flex size-14 shrink-0 items-center justify-center rounded-full border border-dashed border-halo-line text-lg text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
              title={t("profile.avatar")}
            >
              +
            </button>
          )}
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={p.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t("profile.namePh")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              <span className="min-w-0 text-[0.625rem] leading-tight text-halo-muted/60">
                {t("profile.avatarHint")}
              </span>
              <ShareToggle
                on={p.nameShare}
                onChange={(v) => set({ nameShare: v })}
                label={shareLabel}
              />
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              pickAvatar(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {avatarErr && (
          <p className="mt-1.5 text-[0.6875rem] text-red-400">{t("profile.avatarErr")}</p>
        )}
      </div>

      {/* Как агенту с тобой работать */}
      <div className="mt-3 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm font-medium text-halo-text">{t("profile.how")}</p>

        {/* Роль */}
        <div className="mt-2.5 rounded-lg px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-halo-muted">{t("profile.role")}</span>
            <ShareToggle
              on={p.roleShare}
              onChange={(v) => set({ roleShare: v })}
              label={shareLabel}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => set({ role: p.role === r ? "" : r })}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  p.role === r
                    ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {t(ROLE_KEYS[r])}
              </button>
            ))}
          </div>
          {p.role === "other" && (
            <input
              type="text"
              value={p.roleCustom}
              onChange={(e) => set({ roleCustom: e.target.value })}
              placeholder={t("profile.roleCustomPh")}
              className="mt-1.5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          )}
        </div>

        {/* Язык ответов */}
        <div className="mt-1 rounded-lg px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-halo-muted">{t("profile.answersLang")}</span>
            <ShareToggle
              on={p.langShare}
              onChange={(v) => set({ langShare: v })}
              label={shareLabel}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {LANGS.map((l) => (
              <button
                key={l}
                onClick={() => set({ answersLang: p.answersLang === l ? "" : l })}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  p.answersLang === l
                    ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {{ ru: "Русский", en: "English", zh: "中文", ja: "日本語" }[l]}
              </button>
            ))}
          </div>
        </div>

        {/* Тон */}
        <div className="mt-1 rounded-lg px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-halo-muted">{t("profile.tone")}</span>
            <ShareToggle
              on={p.toneShare}
              onChange={(v) => set({ toneShare: v })}
              label={shareLabel}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TONES.map((tone) => (
              <button
                key={tone}
                onClick={() => set({ tone: p.tone === tone ? "" : tone })}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  p.tone === tone
                    ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {t(`profile.tone_${tone}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Стек + фокус */}
        <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-lg px-2 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-halo-muted">{t("profile.stack")}</span>
              <ShareToggle
                on={p.stackShare}
                onChange={(v) => set({ stackShare: v })}
                label={shareLabel}
              />
            </div>
            <input
              type="text"
              value={p.stack}
              onChange={(e) => set({ stack: e.target.value })}
              placeholder={t("profile.stackPh")}
              className="mt-1.5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </div>
          <div className="rounded-lg px-2 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-halo-muted">{t("profile.focus")}</span>
              <ShareToggle
                on={p.focusShare}
                onChange={(v) => set({ focusShare: v })}
                label={shareLabel}
              />
            </div>
            <input
              type="text"
              value={p.focus}
              onChange={(e) => set({ focus: e.target.value })}
              placeholder={t("profile.focusPh")}
              className="mt-1.5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </div>
        </div>

        {/* Свободные инструкции */}
        <div className="mt-1 rounded-lg px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-halo-muted">{t("profile.instructions")}</span>
            <ShareToggle
              on={p.instructionsShare}
              onChange={(v) => set({ instructionsShare: v })}
              label={shareLabel}
            />
          </div>
          <textarea
            value={p.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            placeholder={t("profile.instructionsPh")}
            rows={3}
            className="mt-1.5 w-full resize-y rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        </div>
      </div>

      {/* Прозрачность */}
      <p className="mt-3 text-[0.6875rem] leading-relaxed text-halo-muted/70">
        {t("profile.privacy")}
      </p>
    </div>
  );
}
