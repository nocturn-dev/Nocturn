import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import {
  type LspConfig,
  type LspServerEntry,
  lspGetConfig,
  lspSetConfig,
  invalidateToolSchemas,
} from "../../api";
import { ToggleRow } from "./parts";
import { CheckIcon } from "../cards/icons";

/**
 * Встроенные семейства серверов — ЗЕРКАЛО FAMILIES в src-tauri/src/lsp.rs:
 * расширения и дефолтные команды должны совпадать (при расхождении UI
 * показывает одно, а резолвит бекенд другое).
 */
const FAMILIES: {
  id: string;
  label: string;
  exts: string[];
  args: string[];
  def: string;
}[] = [
  {
    id: "ts",
    label: "TS / JS",
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    args: ["--stdio"],
    def: "typescript-language-server",
  },
  { id: "rs", label: "Rust", exts: [".rs"], args: [], def: "rust-analyzer" },
  { id: "py", label: "Python", exts: [".py"], args: ["--stdio"], def: "pyright-langserver" },
  { id: "go", label: "Go", exts: [".go"], args: [], def: "gopls" },
  {
    id: "c",
    label: "C / C++",
    exts: [".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cxx"],
    args: [],
    def: "clangd",
  },
];

/** Раздел «LSP-диагностики»: инструмент diagnostics для агента */
export function LspSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<LspConfig>({
    enabled: false,
    autoFeedback: true,
    servers: [],
  });
  // Команды по семействам; пустое поле = встроенный дефолт
  const [commands, setCommands] = useState<Record<string, string>>(() =>
    Object.fromEntries(FAMILIES.map((f) => [f.id, ""])),
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    lspGetConfig().then((loaded) => {
      setCfg(loaded);
      // Серверы на диске перекрывают дефолты: поле показывает фактическую
      // команду; семейства без записи остаются на дефолте (пустое поле).
      // Резолв по ЛЮБОМУ расширению записи — бекенд lsp.rs резолвит так же:
      // матч по головому ext молча терял запись с неканоничной головой
      // (["\.tsx",".ts"], hand-правка) и любой тоггл её затирал (A5-10)
      const byAnyExt = new Map<string, LspServerEntry>();
      for (const s of loaded.servers) {
        for (const e of s.extensions) byAnyExt.set(e.toLowerCase(), s);
      }
      setCommands(
        Object.fromEntries(
          FAMILIES.map((f) => {
            const hit = f.exts
              .map((e) => byAnyExt.get(e.toLowerCase()))
              .find(Boolean);
            return [f.id, hit?.command ?? ""];
          }),
        ),
      );
    }).catch(() => {});
  }, []);

  const markSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const apply = async (next: LspConfig) => {
    const prev = cfg;
    setCfg(next);
    try {
      await lspSetConfig(next);
      invalidateToolSchemas(); // тул diagnostics появляется/исчезает сразу
      markSaved();
    } catch {
      // Запись не удалась — снапшот в Rust не обновлялся, откатываем UI
      setCfg(prev);
    }
  };

  // Непустой пользовательский список ЗАМЕНЯЕТ дефолты целиком (семантика
  // бекенда), поэтому при любом переопределении материализуем ВСЕ семейства:
  // переопределён только rust-analyzer — TS не должен молча остаться без
  // сервера. Пустое поле = встроенный дефолт той же строки.
  // Hand-записи lsp.json вне встроенных семейств доезжают до сохранения
  // как есть — buildServers раньше стирал их на любом applyToggle (A5-10)
  const buildServers = (cmds: Record<string, string>): LspServerEntry[] => {
    const familyExts = new Set(
      FAMILIES.flatMap((f) => f.exts.map((e) => e.toLowerCase())),
    );
    const hand = cfg.servers.filter(
      (s) => !s.extensions.some((e) => familyExts.has(e.toLowerCase())),
    );
    const anyCustom = FAMILIES.some((f) => {
      const v = (cmds[f.id] ?? "").trim();
      return v !== "" && v !== f.def;
    });
    if (!anyCustom) return hand;
    return [
      ...FAMILIES.map((f) => ({
        extensions: f.exts,
        command: (cmds[f.id] ?? "").trim() || f.def,
        args: [...f.args],
      })),
      ...hand,
    ];
  };

  const applyToggle = (patch: Partial<LspConfig>) => {
    void apply({ ...cfg, ...patch, servers: buildServers(commands) });
  };

  // Ввод — только локальное состояние; сохранение по blur: lsp_set_config
  // перезапускает живые серверы, на каждый символ это убило бы их наповал
  const onCommandInput = (id: string, value: string) => {
    setCommands((prev) => ({ ...prev, [id]: value }));
  };

  const onCommandBlur = () => {
    void apply({ ...cfg, servers: buildServers(commands) });
  };

  return (
    <div className="mt-5 border-t border-halo-line pt-4">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.lsp")}
      </h3>
      <p className="mb-2 text-xs leading-relaxed text-halo-muted">
        {t("lsp.desc")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("lsp.enabled")}
          desc={t("lsp.enabledDesc")}
          on={cfg.enabled}
          onChange={(v) => applyToggle({ enabled: v })}
        />
        {cfg.enabled && (
          <>
            <ToggleRow
              label={t("lsp.autoFeedback")}
              desc={t("lsp.autoFeedbackDesc")}
              on={cfg.autoFeedback}
              onChange={(v) => applyToggle({ autoFeedback: v })}
            />
            <div className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("lsp.servers")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("lsp.serversDesc")}
              </p>
              <div className="space-y-1.5">
                {FAMILIES.map((f) => (
                  <div key={f.id} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[0.6875rem] text-halo-muted">
                      {f.label}
                    </span>
                    <input
                      type="text"
                      value={commands[f.id]}
                      onChange={(e) => onCommandInput(f.id, e.target.value)}
                      onBlur={onCommandBlur}
                      placeholder={f.def}
                      spellCheck={false}
                      className="w-full min-w-0 rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 rounded-lg border border-halo-line/60 bg-halo-surface/40 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-halo-muted/80">
                {t("lsp.hint")}
                {saved ? <CheckIcon /> : null}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
