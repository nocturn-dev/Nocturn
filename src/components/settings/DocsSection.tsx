import { useLang, MsgKey } from "../../locales";

export function DocsSection() {
  const { t } = useLang();
  const blocks: { title: MsgKey; body: MsgKey }[] = [
    { title: "docs.chat.title", body: "docs.chat.body" },
    { title: "docs.agent.title", body: "docs.agent.body" },
    { title: "docs.terminal.title", body: "docs.terminal.body" },
    { title: "docs.notes.title", body: "docs.notes.body" },
    { title: "docs.customize.title", body: "docs.customize.body" },
    { title: "docs.keys.title", body: "docs.keys.body" },
  ];
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.docs")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("docs.intro")}
      </p>
      <div className="space-y-2.5">
        {blocks.map((b) => (
          <div
            key={b.title}
            className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5"
          >
            <p className="text-xs font-medium text-halo-text">{t(b.title)}</p>
            <p className="mt-1 text-xs leading-relaxed text-halo-muted">
              {t(b.body)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Компактный сегмент-переключатель языка (RU / EN) */
