import { useEffect, useState } from "react";
import { useLang, type MsgKey } from "../../locales";
import { getToolSchemas } from "../../api";
import {
  loadPermRules,
  savePermRules,
  validateRule,
  type PermRules,
} from "../../agent/permRules";
import { MiniTrashIcon } from "./parts";

type RuleKind = "deny" | "always_ask" | "allow";

const KINDS: {
  kind: RuleKind;
  titleKey: MsgKey;
  descKey: MsgKey;
  forAllow: boolean;
}[] = [
  {
    kind: "deny",
    titleKey: "perm.denyTitle",
    descKey: "perm.denyDesc",
    forAllow: false,
  },
  {
    kind: "always_ask",
    titleKey: "perm.alwaysAskTitle",
    descKey: "perm.alwaysAskDesc",
    forAllow: false,
  },
  {
    kind: "allow",
    titleKey: "perm.allowTitle",
    descKey: "perm.allowDesc",
    forAllow: true,
  },
];

/**
 * Раздел «Права» (волна E1): персистентные правила прав агента.
 * deny — серверный блок во всех режимах (perm.rs); always_ask — спрашивать
 * даже в Full; allow — не спрашивать в Ask/Edit. Валидация на добавление —
 * против живого реестра схем; финальная инстанция — perm_set (fail-closed).
 */
export function PermissionsSection() {
  const { t } = useLang();
  const [rules, setRules] = useState<PermRules>(loadPermRules);
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<RuleKind, string>>({
    deny: "",
    always_ask: "",
    allow: "",
  });
  const [error, setError] = useState<Record<RuleKind, string>>({
    deny: "",
    always_ask: "",
    allow: "",
  });
  // Волна GUI-fix: какой список подсказок открыт (кастомный дропдаун)
  const [openKind, setOpenKind] = useState<RuleKind | null>(null);

  useEffect(() => {
    getToolSchemas()
      .then((schemas) => {
        const set = new Set<string>();
        if (Array.isArray(schemas)) {
          for (const s of schemas) {
            const n = (s as { function?: { name?: string } })?.function?.name;
            if (n) set.add(n);
          }
        }
        setKnown(set);
      })
      .catch(() => {});
  }, []);

  const remove = (kind: RuleKind, idx: number) => {
    const next: PermRules = { ...rules, [kind]: rules[kind].filter((_, i) => i !== idx) };
    setRules(next);
    savePermRules(next);
  };

  const add = (kind: RuleKind) => {
    const raw = draft[kind].trim();
    if (!raw) return;
    const err = validateRule(raw, KINDS.find((k) => k.kind === kind)?.forAllow ?? false, known);
    if (err) {
      setError((prev) => ({ ...prev, [kind]: err }));
      return;
    }
    setError((prev) => ({ ...prev, [kind]: "" }));
    // Дубликат — тихо игнорируем (идемпотентность списка)
    if (rules[kind].includes(raw)) {
      setDraft((prev) => ({ ...prev, [kind]: "" }));
      return;
    }
    const next: PermRules = { ...rules, [kind]: [...rules[kind], raw] };
    setRules(next);
    savePermRules(next);
    setDraft((prev) => ({ ...prev, [kind]: "" }));
  };

  return (
    <div className="mt-5 border-t border-halo-line pt-4">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("settings.permissions")}</h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">{t("perm.desc")}</p>

      {/* Волна GUI-fix: кастомный выпадающий список вместо нативного
          datalist — ширина по полю ввода, тема через halo-токены
          (нативный попап ни шире, ни перекрашиваться не умел) */}
      <datalist id="perm-tools-list" className="hidden">
        {[...known].sort().map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="space-y-4">
        {KINDS.map(({ kind, titleKey, descKey, forAllow }) => {
          const query = draft[kind].trim().toLowerCase();
          const suggestions =
            openKind === kind
              ? [...known]
                  .sort()
                  .filter((n) => !query || n.includes(query))
                  .slice(0, 12)
              : [];
          return (
          <div key={kind} className="rounded-lg border border-halo-line bg-halo-surface/40 p-3">
            <div className="mb-1 text-xs font-semibold text-halo-text">{t(titleKey)}</div>
            <div className="mb-2 text-[11px] leading-relaxed text-halo-muted">{t(descKey)}</div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {rules[kind].length === 0 && (
                <span className="text-[11px] text-halo-muted/60">{t("perm.empty")}</span>
              )}
              {rules[kind].map((r, idx) => (
                <span
                  key={`${r}-${idx}`}
                  className="inline-flex items-center gap-1 rounded-md border border-halo-line bg-halo-bg px-2 py-0.5 font-mono text-[11px] text-halo-text"
                >
                  {r}
                  <button
                    onClick={() => remove(kind, idx)}
                    title={t("perm.remove")}
                    className="text-halo-muted transition-colors hover:text-halo-error"
                  >
                    <MiniTrashIcon />
                  </button>
                </span>
              ))}
            </div>
            <div className="relative flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  value={draft[kind]}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, [kind]: e.target.value }));
                    setOpenKind(kind);
                  }}
                  onFocus={() => setOpenKind(kind)}
                  onBlur={() => window.setTimeout(() => setOpenKind((cur) => (cur === kind ? null : cur)), 120)}
                  onKeyDown={(e) => {
                    // IME-подтверждение (китайский/японский ввод) не коммитит
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) add(kind);
                    if (e.key === "Escape") setOpenKind(null);
                  }}
                  list="perm-tools-list"
                  placeholder={t("perm.addPlaceholder")}
                  className="w-full rounded-md border border-halo-line bg-halo-bg px-2.5 py-1.5 font-mono text-[11px] text-halo-text placeholder:text-halo-muted/50 focus:border-halo-accent focus:outline-none"
                />
                {suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-halo-line bg-halo-deep py-1 shadow-lg scroll-slim">
                    {suggestions.map((n) => (
                      <button
                        key={n}
                        // mousedown+preventDefault: input не теряет фокус
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setDraft((prev) => ({ ...prev, [kind]: n }));
                          setOpenKind(null);
                        }}
                        className="block w-full px-2.5 py-1 text-left font-mono text-[11px] text-halo-text transition-colors hover:bg-halo-hover"
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => add(kind)}
                className="shrink-0 rounded-md border border-halo-line px-2.5 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
              >
                + {t("perm.add")}
              </button>
            </div>
            {error[kind] && (
              <div className="mt-1.5 text-[11px] text-halo-error">{error[kind]}</div>
            )}
            {forAllow && (
              <div className="mt-1.5 text-[11px] text-halo-muted/70">{t("perm.allowHint")}</div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
