import type React from "react";
import type { PermissionMode, Theme } from "../types";
import type { SubRunState } from "../subagents";
import type { PromptPreset } from "../presets";
import type { Appearance } from "../appearance";
import type { ModelInfo } from "../api";
import { useLang, type MsgKey } from "../locales";
import ProviderIcon, { brandName } from "./ProviderIcon";
import QuickSettings from "./QuickSettings";
import { ContextRing } from "./cards/ContextRing";
import {
  ChevronDownIcon,
  PermModeIcon,
  RobotIcon,
  ShieldIcon,
  SlidersIcon,
  TerminalIcon,
  WrenchIcon,
} from "./cards/icons";

/** Единая анатомия чипов нижней панели композера: одна высота, паддинги
 *  и кегль у всех контролов */
export const COMPOSER_CHIP =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[0.6875rem] transition duration-150 disabled:cursor-not-allowed disabled:opacity-40";
export const COMPOSER_CHIP_ON =
  "border-halo-line/70 bg-halo-hover text-halo-text";
export const COMPOSER_CHIP_OFF =
  "border-transparent text-halo-muted hover:bg-halo-hover hover:text-halo-text";

export interface ComposerToolbarProps {
  compact?: boolean;
  agentMode: boolean;
  onToggleAgent: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (m: PermissionMode) => void;
  permOpen: boolean;
  setPermOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toolsOpen: boolean;
  setToolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toolNames: string[] | null;
  openTools: () => void;
  disabledTools: string[];
  onToggleDisabledTool: (name: string) => void;
  contextUsed?: number;
  contextEstimate: { msgs: number; prompt: number };
  contextLimit: number;
  contextRows: { label: MsgKey; tokens: number; color: string }[];
  subRuns?: Record<string, SubRunState>;
  subOpen: boolean;
  setSubOpen: React.Dispatch<React.SetStateAction<boolean>>;
  model: string;
  models: ModelInfo[];
  onModelChange: (m: string) => void;
  isLocal?: boolean;
  onOpenSettings: () => void;
  quickOpen: boolean;
  setQuickOpen: React.Dispatch<React.SetStateAction<boolean>>;
  effort: "off" | "low" | "high" | "max";
  onEffortChange: (e: "off" | "low" | "high" | "max") => void;
  promptPresets: PromptPreset[];
  customPresets: PromptPreset[];
  onApplyPreset: (prompt: string) => void;
  theme: Theme;
  appearance: Appearance;
  onThemeChange: (t: Theme) => void;
  onAppearanceChange: (a: Appearance) => void;
  glass: boolean;
  onGlassChange: (g: boolean) => void;
}

export function ComposerToolbar({
  compact = false,
  agentMode,
  onToggleAgent,
  terminalOpen,
  onToggleTerminal,
  permissionMode,
  onPermissionModeChange,
  permOpen,
  setPermOpen,
  toolsOpen,
  setToolsOpen,
  toolNames,
  openTools,
  disabledTools,
  onToggleDisabledTool,
  contextUsed,
  contextEstimate,
  contextLimit,
  contextRows,
  subRuns,
  subOpen,
  setSubOpen,
  model,
  models,
  onModelChange,
  isLocal,
  onOpenSettings,
  quickOpen,
  setQuickOpen,
  effort,
  onEffortChange,
  promptPresets,
  customPresets,
  onApplyPreset,
  theme,
  appearance,
  onThemeChange,
  onAppearanceChange,
  glass,
  onGlassChange,
}: ComposerToolbarProps) {
  const { t } = useLang();

  return (
    <div className={`flex items-center gap-1.5 px-1 ${compact ? "mt-1.5" : "mt-1"}`}>
      <button
        onClick={onToggleAgent}
        title={t("agent.toggle")}
        className={`${COMPOSER_CHIP} ${agentMode ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF}`}
      >
        <RobotIcon />
        {t("agent.toggle")}
      </button>
      <button
        onClick={onToggleTerminal}
        title={t("terminal.toggle")}
        className={`${COMPOSER_CHIP} ${terminalOpen ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF}`}
      >
        <TerminalIcon />
        {t("terminal.toggle")}
      </button>
      {/* Режим разрешений агента (plan / ask / edit / full) */}
      <div className="relative">
        <button
          onClick={() => setPermOpen((v) => !v)}
          title={t("perms.title")}
          className={`${COMPOSER_CHIP} ${
            permissionMode !== "ask" ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF
          }`}
        >
          <ShieldIcon />
          <span className="max-w-32 truncate">{t(`perms.${permissionMode}`)}</span>
          <ChevronDownIcon />
        </button>
        {permOpen && (
          <>
            <div
              className="fixed inset-0 z-[var(--halo-z-panel)]"
              onClick={() => setPermOpen(false)}
            />
            <div className="anim-pop absolute bottom-full left-0 z-[var(--halo-z-panel-raised)] mb-2 w-64 rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
              <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                {t("perms.title")}
              </p>
              {(["plan", "ask", "edit", "full"] as PermissionMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    onPermissionModeChange(m);
                    setPermOpen(false);
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    permissionMode === m ? "bg-halo-hover" : "hover:bg-halo-hover"
                  }`}
                >
                  <span
                    className={`mt-0.5 shrink-0 ${
                      permissionMode === m ? "text-halo-text" : "text-halo-muted"
                    }`}
                  >
                    <PermModeIcon mode={m} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-halo-text">
                      {t(`perms.${m}`)}
                    </span>
                    <span className="block text-[0.6875rem] leading-snug text-halo-muted">
                      {t(`perms.${m}Desc`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {/* Инструменты агента: список исключений задачи */}
      <div className="relative">
        <button
          onClick={openTools}
          title={t("tools.title")}
          className={`${COMPOSER_CHIP} ${
            disabledTools.length > 0 ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF
          }`}
        >
          <WrenchIcon />
          {disabledTools.length > 0 && <span className="tabular-nums">{disabledTools.length}</span>}
          <ChevronDownIcon />
        </button>
        {toolsOpen && (
          <>
            <div
              className="fixed inset-0 z-[var(--halo-z-panel)]"
              onClick={() => setToolsOpen(false)}
            />
            <div className="scroll-slim anim-pop absolute bottom-full left-0 z-[var(--halo-z-panel-raised)] mb-2 max-h-80 w-64 overflow-y-auto rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
              <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                {t("tools.title")}
              </p>
              <p className="px-2 pb-1.5 text-[0.6875rem] leading-snug text-halo-muted">
                {t("tools.hint")}
              </p>
              {toolNames === null ? (
                <p className="px-2 py-1.5 text-xs text-halo-muted">…</p>
              ) : toolNames.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-halo-muted">{t("tools.empty")}</p>
              ) : (
                toolNames.map((name) => {
                  const off = disabledTools.includes(name);
                  return (
                    <button
                      key={name}
                      onClick={() => onToggleDisabledTool(name)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                        off
                          ? "bg-halo-hover text-halo-text"
                          : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                      }`}
                    >
                      <span
                        className={`flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                          off ? "border-halo-text/60 bg-halo-text/60" : "border-halo-muted/50"
                        }`}
                      >
                        {off && (
                          <svg
                            viewBox="0 0 10 10"
                            className="size-2.5 text-halo-on-accent"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M1.5 5.5l2.5 2.5 4.5-5" />
                          </svg>
                        )}
                      </span>
                      <span className="truncate font-mono">{name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
      <span className="flex-1" />
      <span className="flex h-7 items-center">
        <ContextRing
          used={contextUsed || contextEstimate.msgs + contextEstimate.prompt}
          limit={contextLimit}
          rows={contextRows}
          isEstimate={!contextUsed}
        />
      </span>
      {/* Монитор субагентов: отображается при наличии прогонов */}
      {Object.keys(subRuns ?? {}).length > 0 && (
        <div className="relative">
          <button
            onClick={() => setSubOpen((v) => !v)}
            title={t("sub.monitor")}
            className={`${COMPOSER_CHIP} ${
              subOpen || Object.values(subRuns ?? {}).some((r) => r.report === null)
                ? COMPOSER_CHIP_ON
                : COMPOSER_CHIP_OFF
            }`}
          >
            <RobotIcon />
            <span className="tabular-nums">
              {Object.values(subRuns ?? {}).filter((r) => r.report === null).length ||
                Object.keys(subRuns ?? {}).length}
            </span>
          </button>
          {subOpen && (
            <>
              <div
                className="fixed inset-0 z-[var(--halo-z-panel)]"
                onClick={() => setSubOpen(false)}
              />
              <div className="anim-pop absolute bottom-full right-0 z-[var(--halo-z-panel-raised)] mb-2 w-80 rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                  {t("sub.monitor")}
                </p>
                {Object.entries(subRuns ?? {}).map(([id, r]) => (
                  <div key={id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        r.report === null ? "animate-pulse bg-halo-accent" : "bg-emerald-400"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-halo-text">{r.roleName}</p>
                      {r.task && (
                        <p className="truncate text-[0.6875rem] text-halo-muted/70">{r.task}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {/* Модель — в правом кластере */}
      <button
        onClick={onOpenSettings}
        title={model ? model : t("chat.modelHint")}
        className={`${COMPOSER_CHIP} ${COMPOSER_CHIP_OFF}`}
      >
        <ProviderIcon modelId={model} size={12} />
        <span className="max-w-32 truncate">{model ? brandName(model) : t("chat.modelNotSet")}</span>
        {isLocal && (
          <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-400">
            {t("chat.modelLocal")}
          </span>
        )}
        <ChevronDownIcon />
      </button>
      <div className="relative">
        <button
          onClick={() => setQuickOpen((v) => !v)}
          title={t("qs.title")}
          className={`${COMPOSER_CHIP} ${quickOpen ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF}`}
        >
          <SlidersIcon />
        </button>
        {quickOpen && (
          <div className="absolute bottom-full right-0">
            <QuickSettings
              model={model}
              models={models}
              onModel={onModelChange}
              effort={effort}
              onEffortChange={onEffortChange}
              promptPresets={promptPresets}
              customPresets={customPresets}
              onApplyPreset={onApplyPreset}
              theme={theme}
              appearance={appearance}
              onThemeChange={onThemeChange}
              onAppearanceChange={onAppearanceChange}
              glass={glass}
              onGlassChange={onGlassChange}
              onClose={() => setQuickOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
