import { useEffect, useState } from "react";
import { useLang, MsgKey } from "../../locales";
import { isWindows } from "../../platform";
import { mediaStatus, type MediaStateDto } from "../../api";
import { ytPlayUrl, ytSetOpen } from "../../yt/ytPlayer";
import type { MediaPrefs } from "../../mediaPrefs";
import { SpotifyIcon, YouTubeIcon } from "../cards/icons";
import { ToggleRow } from "./parts";

/**
 * Вкладка «Интеграции»: сетка карточек по образцу «Отдыха», у каждой
 * будущей интеграции (YouTube, Telegram) будет своя карточка с иконкой.
 * Принцип Local-first соблюдён: управление плеером — системные медиа-
 * контролы ОС; наружу уходит только запрос лирики, и только по тумблеру.
 */

export function IntegrationsSection({
  mediaPrefs,
  onMediaPrefsChange,
}: {
  mediaPrefs: MediaPrefs;
  onMediaPrefsChange: (p: MediaPrefs) => void;
}) {
  const { t } = useLang();
  const unavailable = !isWindows();
  const on = mediaPrefs.bar;
  const ytOn = mediaPrefs.youtube;
  // Поле ссылки YouTube прямо во вкладке: вставил → добавилось в плеер.
  // Окно НАСТРОЕК при этом не открываем (владелец: модалка поверх настроек
  // сбивает) — вместо этого честная инструкция: минибар → Play
  const [ytDraft, setYtDraft] = useState("");
  const [ytDraftError, setYtDraftError] = useState(false);
  const [ytAdded, setYtAdded] = useState(false);
  const submitYtDraft = () => {
    const res = ytPlayUrl(ytDraft);
    if (!res.ok) {
      setYtDraftError(true);
      setYtAdded(false);
      return;
    }
    setYtDraft("");
    setYtDraftError(false);
    setYtAdded(true);
  };

  // Живое состояние плеера прямо на вкладке: юзер сразу видит, что бекенд
  // слышит SMTC (иначе «не работает» невозможно отличить от «не включил»)
  const [live, setLive] = useState<MediaStateDto | null>(null);
  useEffect(() => {
    if (unavailable) return;
    let disposed = false;
    const read = () =>
      mediaStatus()
        .then((st) => {
          if (!disposed) setLive(st);
        })
        .catch(() => {});
    void read();
    const iv = window.setInterval(read, 3000);
    return () => {
      disposed = true;
      window.clearInterval(iv);
    };
  }, [unavailable]);

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.integrations")}
      </h3>
      <p className="mb-3 text-[0.6875rem] leading-relaxed text-halo-muted">
        {t("integrations.desc")}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Карточка Spotify: клик = включить/выключить; РАДИО с YouTube —
            включённой может быть только одна интеграция минибара */}
        <button
          onClick={() => {
            if (unavailable) return;
            if (on) onMediaPrefsChange({ ...mediaPrefs, bar: false });
            else onMediaPrefsChange({ ...mediaPrefs, bar: true, youtube: false });
          }}
          disabled={unavailable}
          title={t("media.cardHint")}
          className={`relative flex h-28 flex-col items-center justify-center gap-2 rounded-xl border transition-[transform,border-color] duration-200 ${
            unavailable
              ? "cursor-not-allowed border-halo-line/40 bg-halo-surface/30 opacity-50"
              : on
                ? "border-halo-accent/40 bg-halo-surface/70 hover:border-halo-accent/60"
                : "border-halo-line bg-halo-surface/50 hover:-translate-y-1 hover:border-halo-accent/40"
          }`}
        >
          <SpotifyIcon />
          <span
            className={`text-sm font-medium ${
              on ? "text-halo-text" : "text-halo-muted"
            }`}
          >
            Spotify
          </span>
          {/* Индикатор состояния: зелёная точка — интеграция включена */}
          <span
            className={`absolute right-2.5 top-2.5 size-1.5 rounded-full ${
              on ? "bg-emerald-400" : "bg-halo-muted/40"
            }`}
          />
        </button>
        {/* Карточка YouTube: официальный embed (youtube-nocookie), без
            ключей; работает на всех платформах — Windows-гейт только у
            SMTC-интеграции Spotify */}
        <button
          onClick={() => {
            if (ytOn) onMediaPrefsChange({ ...mediaPrefs, youtube: false });
            else onMediaPrefsChange({ ...mediaPrefs, youtube: true, bar: false });
          }}
          title={t("media.ytCardHint")}
          className={`relative flex h-28 flex-col items-center justify-center gap-2 rounded-xl border transition-[transform,border-color] duration-200 ${
            ytOn
              ? "border-halo-accent/40 bg-halo-surface/70 hover:border-halo-accent/60"
              : "border-halo-line bg-halo-surface/50 hover:-translate-y-1 hover:border-halo-accent/40"
          }`}
        >
          <YouTubeIcon />
          <span
            className={`text-sm font-medium ${
              ytOn ? "text-halo-text" : "text-halo-muted"
            }`}
          >
            YouTube
          </span>
          <span
            className={`absolute right-2.5 top-2.5 size-1.5 rounded-full ${
              ytOn ? "bg-emerald-400" : "bg-halo-muted/40"
            }`}
          />
        </button>
      </div>

      {unavailable && (
        <p className="mt-2 text-[0.6875rem] text-halo-muted">
          {t("media.unavailable")}
        </p>
      )}
      <p className="mt-2 px-1 text-[0.6875rem] text-halo-muted">
        {t("media.live")}{" "}
        {live?.title ? (
          <span className="text-halo-text">
            {live.playing ? "▶ " : "⏸ "}
            {live.title}
            {live.artist ? ` — ${live.artist}` : ""}
            {live.source ? (
              <span className="text-halo-muted/60"> · {live.source}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-halo-muted/60">{t("media.liveIdle")}</span>
        )}
      </p>

      {/* YouTube: блок включённой интеграции — ПОЛЕ ССЫЛКИ прямо здесь
          (вставил → играет) + радио с Spotify соблюдено на карточках */}
      {ytOn && (
        <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-3 py-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <p className="text-xs font-medium text-halo-text">YouTube</p>
            <button
              onClick={() => ytSetOpen(true)}
              className="text-[0.6875rem] text-halo-muted transition-colors hover:text-halo-text"
              title={t("media.ytOpenPlayer")}
            >
              ↗
            </button>
          </div>
          <div className="flex items-center gap-2 px-2">
            <input
              value={ytDraft}
              onChange={(e) => {
                setYtDraft(e.target.value);
                setYtDraftError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitYtDraft();
              }}
              placeholder={t("media.ytEmpty")}
              className={`h-8 min-w-0 flex-1 rounded-lg border bg-halo-deep px-2.5 text-xs text-halo-text outline-none placeholder:text-halo-muted/50 ${
                ytDraftError
                  ? "border-halo-error/60"
                  : "border-halo-line focus:border-halo-accent/50"
              }`}
            />
            <button
              onClick={submitYtDraft}
              className="h-8 shrink-0 rounded-lg border border-halo-accent/40 bg-halo-accent/10 px-3 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
            >
              {t("media.ytPlay")}
            </button>
          </div>
          {ytDraftError && (
            <p className="px-2 pt-1 text-[0.625rem] text-halo-error">
              {t("media.ytBadUrl")}
            </p>
          )}
          {ytAdded && (
            <p className="px-2 pt-1 text-[0.625rem] text-emerald-400">
              {t("media.ytAdded")}
            </p>
          )}
          {/* Кастомизация плеера: поведение окна и очереди */}
          <div className="mt-2 border-t border-halo-line/60 pt-2">
            <ToggleRow
              label={t("media.ytAutoCollapse")}
              desc={t("media.ytAutoCollapseDesc")}
              on={mediaPrefs.ytAutoCollapse}
              onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, ytAutoCollapse: v })}
            />
            <ToggleRow
              label={t("media.ytLoop")}
              desc={t("media.ytLoopDesc")}
              on={mediaPrefs.ytLoopQueue}
              onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, ytLoopQueue: v })}
            />
            <ToggleRow
              label={t("media.ytDrag")}
              desc={t("media.ytDragDesc")}
              on={mediaPrefs.ytDraggable}
              onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, ytDraggable: v })}
            />
            <ToggleRow
              label={t("media.ytKeepOpen")}
              desc={t("media.ytKeepOpenDesc")}
              on={mediaPrefs.ytKeepOpen}
              onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, ytKeepOpen: v })}
            />
            <div className="mb-1 flex items-center justify-between px-2 py-2">
              <p className="text-sm text-halo-text">{t("media.ytSize")}</p>
              <div className="flex items-center gap-0.5 rounded-lg border border-halo-line p-0.5">
                {(["s", "m", "l"] as const).map((sz) => (
                  <button
                    key={sz}
                    onClick={() => onMediaPrefsChange({ ...mediaPrefs, ytSize: sz })}
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                      mediaPrefs.ytSize === sz
                        ? "bg-halo-accent/20 text-halo-accent"
                        : "text-halo-muted hover:text-halo-text"
                    }`}
                  >
                    {t(`media.ytSize${sz.toUpperCase()}` as MsgKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="px-2 pt-1.5 text-[0.625rem] leading-relaxed text-halo-muted/70">
            {t("media.ytCardHint")}
          </p>
        </div>
      )}

      {on && (
        <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-3 py-2">
          <p className="mb-1 px-1 text-xs font-medium text-halo-text">
            {t("media.blockTitle")}
          </p>
          <ToggleRow
            label={t("media.lyrics")}
            desc={t("media.lyricsDesc")}
            on={mediaPrefs.lyrics}
            onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, lyrics: v })}
          />
          {/* Подсветка лирики: токены темы или собственный цвет —
              полноценные строки со switch (чуточку больше) */}
          {mediaPrefs.lyrics && (
            <>
              <ToggleRow
                big
                label={t("media.lyricsTheme")}
                desc={t("media.lyricsThemeDesc")}
                on={mediaPrefs.lyricColorMode === "theme"}
                onChange={(v) =>
                  onMediaPrefsChange({ ...mediaPrefs, lyricColorMode: v ? "theme" : "custom" })
                }
              />
              <ToggleRow
                big
                label={t("media.lyricsCustom")}
                desc={t("media.lyricsCustomDesc")}
                on={mediaPrefs.lyricColorMode === "custom"}
                onChange={(v) =>
                  onMediaPrefsChange({ ...mediaPrefs, lyricColorMode: v ? "custom" : "theme" })
                }
              />
              {mediaPrefs.lyricColorMode === "custom" && (
                <div className="mb-1 flex items-center gap-2 px-2 pl-6">
                  <input
                    type="color"
                    value={mediaPrefs.lyricColor}
                    onChange={(e) =>
                      onMediaPrefsChange({
                        ...mediaPrefs,
                        lyricColor: e.target.value,
                      })
                    }
                    className="h-7 w-10 cursor-pointer rounded border border-halo-line bg-transparent"
                    title={t("media.lyricsCustom")}
                  />
                  <span className="text-[0.625rem] text-halo-muted/70">
                    {mediaPrefs.lyricColor}
                  </span>
                </div>
              )}
            </>
          )}
          <ToggleRow
            label={t("media.cover")}
            desc={t("media.coverDesc")}
            on={mediaPrefs.cover}
            onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, cover: v })}
          />
          {/* Изолированный шиммер текста минибара: не зависит от глобального
              тумблера «Кастомизации» (html.media-text-shimmer, MediaBar) */}
          <ToggleRow
            label={t("media.textShimmer")}
            desc={t("media.textShimmerDesc")}
            on={mediaPrefs.textShimmer}
            onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, textShimmer: v })}
          />
          {/* Пара цветов переливания: от → к (поток гоняет эти два цвета) */}
          {mediaPrefs.textShimmer && (
            <div className="mb-1 flex items-center gap-2 px-2 pl-6">
              <span className="text-[0.625rem] text-halo-muted/70">
                {t("media.shimFrom")}
              </span>
              <input
                type="color"
                value={mediaPrefs.shimmerFrom}
                onChange={(e) =>
                  onMediaPrefsChange({ ...mediaPrefs, shimmerFrom: e.target.value })
                }
                className="h-7 w-10 cursor-pointer rounded border border-halo-line bg-transparent"
                title={t("media.shimFrom")}
              />
              <span className="text-[0.625rem] text-halo-muted/70">
                {t("media.shimTo")}
              </span>
              <input
                type="color"
                value={mediaPrefs.shimmerTo}
                onChange={(e) =>
                  onMediaPrefsChange({ ...mediaPrefs, shimmerTo: e.target.value })
                }
                className="h-7 w-10 cursor-pointer rounded border border-halo-line bg-transparent"
                title={t("media.shimTo")}
              />
              <span className="text-[0.625rem] tabular-nums text-halo-muted/50">
                {mediaPrefs.shimmerFrom} → {mediaPrefs.shimmerTo}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Единоразовое предупреждение перед содержимым вкладки (вариант владельца
 * «⚠️ Локальный хардкор»): честно объясняет WinAPI-чтение окон, кнопку
 * «Принять» и галочку «не показывать». Отмена возвращает в «Основное».
 */
export function IntegrationWarning({
  onAccept,
  onCancel,
}: {
  onAccept: (dontShowAgain: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const [dontShow, setDontShow] = useState(false);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-5">
        <h3 className="text-sm font-semibold text-amber-300">
          {t("media.warnTitle")}
        </h3>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-halo-text">
          {t("media.warnBody")}
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-halo-muted">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="size-3.5 accent-[var(--halo-accent)]"
          />
          {t("media.warnDontShow")}
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
          >
            {t("media.warnCancel")}
          </button>
          <button
            onClick={() => onAccept(dontShow)}
            className="rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-3 py-1.5 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
          >
            {t("media.warnAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}
