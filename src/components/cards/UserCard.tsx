import { useLang } from "../../locales";
import { type Attachment } from "../../types";
import { CollapseButton } from "./CollapseButton";
import { PlusIcon, QuoteIcon, ReuseImgIcon } from "./icons";
import { memo, useState } from "react";
import { getUserAvatar } from "../../userProfile";

function UserCardBase({
  mid,
  content,
  attachments,
  quote,
  correction,
  glassEffect,
  onEdit,
  onReuseAttachment,
}: {
  mid: string;
  content: string;
  attachments?: Attachment[];
  quote?: string;
  /** Поправка агенту на ходу: мягкая amber-подсветка слева */
  correction?: boolean;
  glassEffect?: boolean;
  /** Карандаш: сохранить → переспросить с места правки.
   * Сигнатура (mid, text) — колбэк стабилен для memo (mid уже пропс) */
  onEdit?: (mid: string, newText: string) => void;
  /** Вернуть изображение из сообщения в композер (pendingImages) */
  onReuseAttachment: (a: Attachment) => void;
}) {
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const preview =
    content.replace(/\s+/g, " ").slice(0, 70) ||
    (attachments?.length
      ? `${t("card.imageOf")}: ${attachments[0]?.name ?? ""}`
      : "");

  if (collapsed) {
    return (
      <button
        data-mid={mid}
        onClick={() => setCollapsed(false)}
        title={t("card.expand")}
        className="anim-fade-up ml-auto flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-halo-line/70 bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition duration-150 hover:border-halo-line hover:text-halo-text"
      >
        <PlusIcon />
        <span className="truncate">{preview}</span>
      </button>
    );
  }

  // Аватар из локального профиля — чистый UI, в промт не попадает никогда
  const avatar = getUserAvatar();

  return (
    <div
      data-mid={mid}
      className="anim-fade-up group relative ml-auto flex w-fit max-w-[85%] items-end gap-2 shadow-sm"
    >
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className="mb-1 size-7 shrink-0 select-none rounded-full border border-halo-line/60 object-cover"
        />
      ) : null}
      <div
        className={`min-w-0 w-fit rounded-2xl rounded-br-md px-4 py-3 ${
          correction ? "border-l-2 border-amber-400/50 " : ""
        }${glassEffect ? "glass-pane msg-glass bg-halo-surface/40" : "bg-halo-raised"}`}
      >
      <CollapseButton onClick={() => setCollapsed(true)} />
      {/* Карандаш: редактирование отправленного сообщения */}
      {!editing && onEdit && (
        <button
          onClick={() => {
            setDraft(content);
            setEditing(true);
          }}
          title={t("card.edit")}
          className="absolute -left-7 top-2 rounded-md p-1 text-halo-muted opacity-0 transition hover:bg-halo-hover hover:text-halo-text group-hover:opacity-100"
        >
          ✎
        </button>
      )}
      {editing ? (
        <div className="w-72 sm:w-96">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: энтер подтверждения IME не должен отправлять
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const text = draft.trim();
                if (!text) return;
                setEditing(false);
                onEdit?.(mid, text);
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            rows={Math.min(10, draft.split("\n").length + 1)}
            className="scroll-slim w-full resize-none rounded-lg border border-halo-accent/50 bg-halo-deep/60 px-2.5 py-2 text-sm leading-relaxed text-halo-text outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-halo-muted/60">
              Enter — {t("card.editSend")} · Esc — {t("card.editCancel")}
            </span>
            <div className="flex gap-1.5">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-halo-line px-2 py-1 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("card.editCancel")}
              </button>
              <button
                onClick={() => {
                  const text = draft.trim();
                  if (!text) return;
                  setEditing(false);
                  onEdit?.(mid, text);
                }}
                className="rounded-md bg-halo-accent px-2.5 py-1 text-[10px] font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep"
              >
                {t("card.editSend")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Цитата-реплай: фрагмент, по которому задан вопрос */}
      {quote && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-halo-accent bg-halo-deep/50 px-2.5 py-1.5">
          <span className="mt-0.5 shrink-0 text-halo-accent"><QuoteIcon /></span>
          <p className="line-clamp-3 min-w-0 text-[11px] leading-relaxed text-halo-muted">
            {quote}
          </p>
        </div>
      )}
      {attachments && attachments.length > 0 && (
        <div
          className={`flex flex-wrap gap-2 ${content ? "mb-2" : ""}`}
        >
          {attachments.map((a, i) => (
            // D17: ключ по имени+индексу — base64 data-URL в сотни КБ–МБ
            // сравнивался строково на каждой сверке списка
            <div key={`${a.name}-${i}`} className="group/img relative">
              {a.dataUrl ? (
              <img
                src={a.dataUrl}
                alt={a.name}
                className="max-h-44 rounded-lg border border-halo-line/60 object-cover"
              />
              ) : (
              <div
                title={a.name}
                className="flex max-w-52 items-center gap-1.5 rounded-lg border border-halo-line/60 bg-halo-surface/60 px-2.5 py-2 text-left"
              >
                <span className="shrink-0 text-halo-muted">📄</span>
                <span className="min-w-0 truncate text-xs text-halo-text">{a.name}</span>
              </div>
              )}
              {/* Вернуть изображение в композер: оверлей при наведении,
                  клик не стартует выделение (см. data-reuse-img-btn выше) */}
              <button
                data-reuse-img-btn
                onClick={(e) => {
                  e.stopPropagation();
                  onReuseAttachment(a);
                }}
                title={t("chat.reuseImage")}
                className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md border border-halo-line bg-halo-surface text-halo-muted opacity-0 shadow-sm transition hover:text-halo-text group-hover/img:opacity-100"
              >
                <ReuseImgIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {content && (
        <p className="break-words whitespace-pre-wrap text-sm leading-relaxed text-halo-text">
          {content}
        </p>
      )}
        </>
      )}
      </div>
    </div>
  );
}

export const UserCard = memo(UserCardBase);
