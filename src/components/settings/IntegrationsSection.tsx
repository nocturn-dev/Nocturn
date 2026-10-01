import { useEffect, useState } from "react";
import { useLang, type MsgKey } from "../../locales";
import { isWindows } from "../../platform";
import { mediaStatus, type MediaStateDto } from "../../api";
import { type MediaPrefs, type MediaTrackMode } from "../../mediaPrefs";
import { SpotifyIcon } from "../cards/icons";
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
  const on = mediaPrefs.mode !== "off";

  // Два взаимоисключающих режима (radio): клик по выбранному = выключить
  const MODES: { id: MediaTrackMode; label: MsgKey; desc: MsgKey }[] = [
    { id: "desktop", label: "media.modeDesktop", desc: "media.modeDesktopDesc" },
    { id: "browser", label: "media.modeBrowser", desc: "media.modeBrowserDesc" },
  ];
  const setMode = (m: MediaTrackMode) =>
    onMediaPrefsChange({ ...mediaPrefs, mode: mediaPrefs.mode === m ? "off" : m });

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
        {/* Карточка-иконка: клик = включить (Desktop-режим) / выключить */}
        <button
          onClick={() => {
            if (!unavailable)
              onMediaPrefsChange({ ...mediaPrefs, mode: on ? "off" : "desktop" });
          }}
          disabled={unavailable}
          title={t("media.cardHint")}
          className={`relative flex h-24 flex-col items-center justify-center gap-2 rounded-xl border transition-[transform,border-color] duration-200 ${
            unavailable
              ? "cursor-not-allowed border-halo-line/40 bg-halo-surface/30 opacity-50"
              : on
                ? "border-halo-accent/40 bg-halo-surface/70 hover:border-halo-accent/60"
                : "border-halo-line bg-halo-surface/50 hover:-translate-y-1 hover:border-halo-accent/40"
          }`}
        >
          <SpotifyIcon />
          {/* Индикатор состояния: зелёная точка — интеграция включена */}
          <span
            className={`absolute right-2.5 top-2.5 size-1.5 rounded-full ${
              on ? "bg-emerald-400" : "bg-halo-muted/40"
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

      {on && (
        <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-3 py-2">
          <p className="mb-1 px-1 text-xs font-medium text-halo-text">
            {t("media.blockTitle")}
          </p>
          {/* Radio-режимы: включение одного выключает второй */}
          {MODES.map((m) => {
            const selected = mediaPrefs.mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-halo-hover"
              >
                <span
                  className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    selected
                      ? "border-halo-accent"
                      : "border-halo-muted/50"
                  }`}
                >
                  {selected && (
                    <span className="size-1.5 rounded-full bg-halo-accent" />
                  )}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-xs font-medium ${
                      selected ? "text-halo-text" : "text-halo-muted"
                    }`}
                  >
                    {t(m.label)}
                  </span>
                  <span className="block text-[0.6875rem] leading-snug text-halo-muted/70">
                    {t(m.desc)}
                  </span>
                </span>
              </button>
            );
          })}
          <ToggleRow
            label={t("media.lyrics")}
            desc={t("media.lyricsDesc")}
            on={mediaPrefs.lyrics}
            onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, lyrics: v })}
          />
          <ToggleRow
            label={t("media.cover")}
            desc={t("media.coverDesc")}
            on={mediaPrefs.cover}
            onChange={(v) => onMediaPrefsChange({ ...mediaPrefs, cover: v })}
          />
        </div>
      )}
    </div>
  );
}
