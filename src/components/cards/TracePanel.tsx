/**
 * След прогона: построчная расшифровка шагов агента внутри объединённой
 * карточки — длительность, токены и инструменты каждого шага с машинными
 * статусами (denied/error). Данные уже есть в сообщениях — отдельного
 * состояния и запросов к бэкенду не требуется.
 */

import { useLang } from "../../locales";
import { type Message } from "../../types";

export function TracePanel({
  steps,
  toolMsgs,
}: {
  steps: Message[];
  toolMsgs: Message[];
}) {
  const { t } = useLang();
  return (
    <div className="anim-fade-up rounded-xl border border-halo-line/70 bg-halo-deep/40 px-3.5 py-2.5 text-xs">
      {steps.map((st, i) => {
        const tools = st.toolCalls ?? [];
        return (
          <div
            key={st.id}
            className={i > 0 ? "mt-2 border-t border-halo-line/50 pt-2" : ""}
          >
            <p className="font-medium text-halo-text">
              {t("trace.step", { n: i + 1 })}
              {st.workedMs != null && (
                <span className="ml-1.5 font-normal text-halo-muted">
                  · {(st.workedMs / 1000).toFixed(1)} с
                </span>
              )}
              {st.usage && (
                <span className="ml-1.5 font-normal text-halo-muted">
                  · ↑{st.usage.prompt.toLocaleString("ru-RU")} ↓
                  {st.usage.completion.toLocaleString("ru-RU")}
                </span>
              )}
            </p>
            {st.thought && (
              <p className="mt-0.5 line-clamp-2 text-halo-muted/70">
                {st.thought}
              </p>
            )}
            {tools.map((tc) => {
              const res = toolMsgs.find((m) => m.toolCallId === tc.id);
              const bad = res?.status === "denied" || res?.status === "error";
              return (
                <p
                  key={tc.id}
                  className="mt-1 flex items-center gap-1.5 text-halo-muted"
                >
                  <span className={bad ? "text-red-400" : "text-emerald-400"}>
                    {bad ? "✗" : "✓"}
                  </span>
                  <span className="font-mono">{tc.name}</span>
                  {res?.status === "denied" && (
                    <span className="text-red-400/80">· {t("agent.denied")}</span>
                  )}
                  {res?.status === "error" && (
                    <span className="text-red-400/80">
                      · {t("agent.errorResult")}
                    </span>
                  )}
                </p>
              );
            })}
            {tools.length === 0 && (
              <p className="mt-1 text-halo-muted/60">{t("trace.noTools")}</p>
            )}
            {st.error && (
              <p className="mt-1 text-red-400/80">⚠ {st.error.title}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
