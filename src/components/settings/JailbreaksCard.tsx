import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLang } from "../../locales";
import {
  builtinJailbreaksFor,
  jbModelFacets,
  jbYearFacets,
  jbWarnSuppressed,
  suppressJbWarn,
  JB_REASONING_LABEL_KEYS,
  JB_REASONING_LEVELS,
  searchJailbreaks,
  type JbReasoning,
  type JailbreakEntry,
} from "../../jailbreaks";
import { Dropdown, MiniPencilIcon, MiniTrashIcon } from "./parts";
import { JailbreaksLiveSearch } from "./JailbreaksLiveSearch";
import JbWarnModal from "../JbWarnModal";

/** Чип мета-данных записи (модель / год / уровень мышления) */
function JbChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] leading-4 text-halo-muted">
      {children}
    </span>
  );
}

const PAGE = 100;

/** Карточка «Джейлбрейки» в разделе «Промпты»: свои записи (название /
 * модель / текст / уровень мышления / год) + встроенные пресеты-образцы.
 * Умный поиск — по словам, модели и году: библиотека рассчитана на сотни
 * и тысячи записей после импорта датасетов. Применение — только явной
 * кнопкой: запись ДОБАВЛЯЕТСЯ к системному промту задачи. */
export function JailbreaksCard({
  entries,
  onChange,
  onApply,
}: {
  entries: JailbreakEntry[];
  onChange: (list: JailbreakEntry[]) => void;
  /** Возвращает, куда встал промт: инлайн-статус в карточке — тост из
   * настроек не виден (z-toast ниже z-modal) */
  onApply: (entry: JailbreakEntry) => "task" | "new";
}) {
  const { t, lang } = useLang();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [reasoning, setReasoning] = useState<JbReasoning>("any");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editYear, setEditYear] = useState("");
  const [editReasoning, setEditReasoning] = useState<JbReasoning>("any");
  const [editText, setEditText] = useState("");

  // Поиск: ввод мгновенный, фильтр — с дебаунсом 120 мс (тысячи записей)
  const [queryRaw, setQueryRaw] = useState("");
  const [query, setQuery] = useState("");
  const [modelF, setModelF] = useState("");
  const [yearF, setYearF] = useState("");
  const [sort, setSort] = useState<"relevance" | "newest" | "name">("relevance");
  const [visible, setVisible] = useState(PAGE);
  // Предупреждение при применении (решение владельца): гейт перед onApply
  const [warnEntry, setWarnEntry] = useState<JailbreakEntry | null>(null);
  // Инлайн-результат применения: тост из настроек не виден — дублируем тут
  const [appliedMsg, setAppliedMsg] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQuery(queryRaw.trim()), 120);
    return () => clearTimeout(id);
  }, [queryRaw]);
  useEffect(() => setVisible(PAGE), [query, modelF, yearF, sort]);

  const modelFacets = useMemo(() => jbModelFacets(entries), [entries]);
  const yearFacets = useMemo(() => jbYearFacets(entries), [entries]);
  const reasoningOptions = JB_REASONING_LEVELS.map((lvl) => ({
    value: lvl,
    label: t(JB_REASONING_LABEL_KEYS[lvl]),
  }));

  // Фасет "any" (пустая/«*» модель) — препроходим пул сами: внутри
  // searchJailbreaks пустой фильтр модели означает «без фильтра»
  const results = useMemo(() => {
    const pool =
      modelF === "any" ? entries.filter((e) => !e.model || e.model === "*") : entries;
    return searchJailbreaks(pool, {
      query,
      model: modelF === "any" ? "" : modelF,
      year: yearF,
      sort,
    });
  }, [entries, query, modelF, yearF, sort]);
  const shown = results.slice(0, visible);

  const modelChip = (m: string) => (m && m !== "*" ? m : t("jb.modelAny"));

  const add = () => {
    if (!name.trim() || !text.trim()) return;
    const now = Date.now();
    onChange([
      ...entries,
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        model: model.trim(),
        text: text.trim(),
        reasoning,
        year: year.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    setName("");
    setModel("");
    setYear("");
    setReasoning("any");
    setText("");
  };

  const startEdit = (e: JailbreakEntry) => {
    setEditingId(e.id);
    setEditName(e.name);
    setEditModel(e.model);
    setEditYear(e.year ?? "");
    setEditReasoning(e.reasoning);
    setEditText(e.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const n = editName.trim();
    const tx = editText.trim();
    if (!n || !tx) return;
    onChange(
      entries.map((e) =>
        e.id === editingId
          ? {
              ...e,
              name: n,
              model: editModel.trim(),
              text: tx,
              reasoning: editReasoning,
              year: editYear.trim() || undefined,
              updatedAt: Date.now(),
            }
          : e,
      ),
    );
    setEditingId(null);
  };

  const builtins = builtinJailbreaksFor(lang);

  const copyBuiltin = (b: JailbreakEntry) => {
    const now = Date.now();
    onChange([
      ...entries,
      {
        ...b,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    ]);
  };

  const draftFields = (
    nameV: string,
    setNameV: (v: string) => void,
    modelV: string,
    setModelV: (v: string) => void,
    yearV: string,
    setYearV: (v: string) => void,
    reasonV: JbReasoning,
    setReasonV: (v: JbReasoning) => void,
    namePh: string,
  ) => (
    <>
      <div className="flex gap-2">
        <input
          type="text"
          value={nameV}
          onChange={(e) => setNameV(e.target.value)}
          placeholder={namePh}
          className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <input
          type="text"
          value={modelV}
          onChange={(e) => setModelV(e.target.value)}
          placeholder={t("jb.modelPh")}
          className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={yearV}
          onChange={(e) => setYearV(e.target.value)}
          placeholder={t("jb.yearPh")}
          className="w-28 shrink-0 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <Dropdown
          className="min-w-0 flex-1"
          value={reasonV}
          options={reasoningOptions}
          onSelect={(v) => setReasonV(v as JbReasoning)}
        />
      </div>
    </>
  );

  const entryRow = (e: JailbreakEntry, builtin: boolean) =>
    editingId === e.id ? (
      <div
        key={e.id}
        className="space-y-2 rounded-lg border border-halo-accent/50 bg-halo-surface/50 p-2.5"
      >
        {draftFields(
          editName, setEditName,
          editModel, setEditModel,
          editYear, setEditYear,
          editReasoning, setEditReasoning,
          t("jb.namePh"),
        )}
        <textarea
          value={editText}
          onChange={(ev) => setEditText(ev.target.value)}
          rows={6}
          placeholder={t("jb.textPh")}
          className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm leading-relaxed text-halo-text outline-none transition-colors focus:border-halo-accent/60"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={commitEdit}
            disabled={!editName.trim() || !editText.trim()}
            className="rounded-lg bg-halo-accent px-3 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("prompts.save")}
          </button>
          <button
            onClick={() => setEditingId(null)}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-sm text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("prompts.cancel")}
          </button>
        </div>
      </div>
    ) : (
      <div
        key={e.id}
        className="group flex items-start gap-2.5 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-halo-text">{e.name}</p>
            <JbChip>{modelChip(e.model)}</JbChip>
            {e.year && <JbChip>{e.year}</JbChip>}
            <JbChip>{t(JB_REASONING_LABEL_KEYS[e.reasoning])}</JbChip>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-halo-muted">
            {e.text}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-0.5">
          {builtin ? (
            <button
              onClick={() => copyBuiltin(e)}
              title={t("jb.builtinCopy")}
              className="rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
            >
              {t("jb.builtinCopy")}
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  if (jbWarnSuppressed()) {
                    setAppliedMsg(
                      t(
                        onApply(e) === "task" ? "jb.applied" : "jb.appliedNew",
                        { name: e.name },
                      ),
                    );
                  } else {
                    setWarnEntry(e);
                  }
                }}
                title={t("jb.apply")}
                className="rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
              >
                {t("jb.apply")}
              </button>
              <button
                onClick={() => startEdit(e)}
                title={t("prompts.edit")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                <MiniPencilIcon />
              </button>
              <button
                onClick={() => onChange(entries.filter((x) => x.id !== e.id))}
                title={t("prompts.deleteTitle")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="mt-6">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("jb.title")}
      </h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">
        {t("jb.desc")}
      </p>

      {/* Встроенные пресеты-образцы: только копирование, не редактируются */}
      <p className="mb-2 text-xs font-medium text-halo-muted">
        {t("jb.builtinTitle")}
      </p>
      <div className="mb-4 space-y-2">
        {builtins.map((b) => entryRow(b, true))}
      </div>

      <p className="mb-2 text-xs font-medium text-halo-muted">
        {t("jb.ownTitle")}
      </p>

      {/* Умный поиск: слова (AND) + модель + год + сортировка */}
      <div className="mb-2 space-y-2">
        <input
          type="text"
          value={queryRaw}
          onChange={(e) => setQueryRaw(e.target.value)}
          placeholder={t("jb.searchPh")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="flex gap-2">
          <Dropdown
            className="min-w-0 flex-1"
            value={modelF}
            options={[
              { value: "", label: t("jb.filterAllModels") },
              ...modelFacets.map((f) => ({
                value: f.value,
                label: `${f.value === "any" ? t("jb.modelAny") : f.value} · ${f.count}`,
              })),
            ]}
            onSelect={setModelF}
          />
          <Dropdown
            className="w-36 shrink-0"
            value={yearF}
            options={[
              { value: "", label: t("jb.filterAllYears") },
              ...yearFacets.map((f) => ({ value: f.value, label: `${f.value} · ${f.count}` })),
            ]}
            onSelect={setYearF}
          />
          <Dropdown
            className="w-40 shrink-0"
            value={sort}
            options={[
              { value: "relevance", label: t("jb.sortRelevance") },
              { value: "newest", label: t("jb.sortNewest") },
              { value: "name", label: t("jb.sortName") },
            ]}
            onSelect={(v) => setSort(v as "relevance" | "newest" | "name")}
          />
        </div>
        <p className="text-[0.625rem] text-halo-muted">
          {t("jb.foundOf", { n: String(results.length), m: String(entries.length) })}
        </p>
      </div>

      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-center text-xs text-halo-muted">
            {t("jb.empty")}
          </p>
        ) : shown.length === 0 ? (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-center text-xs text-halo-muted">
            {t("jb.searchEmpty")}
          </p>
        ) : (
          shown.map((e) => entryRow(e, false))
        )}
        {results.length > visible && (
          <button
            onClick={() => setVisible((v) => v + PAGE)}
            className="w-full rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
          >
            {t("jb.showMore", { n: String(Math.min(PAGE, results.length - visible)) })}
          </button>
        )}
      </div>

      <div className="mt-4 space-y-2 rounded-xl border border-halo-line p-3">
        {draftFields(
          name, setName,
          model, setModel,
          year, setYear,
          reasoning, setReasoning,
          t("jb.namePh"),
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={t("jb.textPh")}
          className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="flex justify-end">
          <button
            onClick={add}
            disabled={!name.trim() || !text.trim()}
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("jb.add")}
          </button>
        </div>
      </div>

      <JailbreaksLiveSearch entries={entries} onChange={onChange} />

      {appliedMsg && (
        <p className="mt-2 text-xs leading-relaxed text-emerald-400">
          {appliedMsg}
        </p>
      )}

      {warnEntry && (
        <JbWarnModal
          onConfirm={(dontShow) => {
            if (dontShow) suppressJbWarn();
            setAppliedMsg(
              t(
                onApply(warnEntry) === "task" ? "jb.applied" : "jb.appliedNew",
                { name: warnEntry.name },
              ),
            );
            setWarnEntry(null);
          }}
          onCancel={() => setWarnEntry(null)}
        />
      )}
    </div>
  );
}
