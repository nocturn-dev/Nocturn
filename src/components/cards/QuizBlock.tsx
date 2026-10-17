import { useEffect, useMemo, useState } from "react";
import { blockHash, parseQuizBlock } from "../../chartQuiz";
import { useLang } from "../../locales";

/** Прогресс квиза в localStorage по хэшу СОДЕРЖИМОГО блока (не чата):
 *  переживает рестарт и возвращается вместе с блоком в любом чате.
 *  Кап на число хранимых квизов — вытеснение самых старых */
const PROGRESS_KEY = "haloui-quiz-progress";
const PROGRESS_CAP = 50;

interface QuizProgress {
  /** Индекс текущего вопроса */
  i: number;
  /** Счёт правильных ответов */
  score: number;
  /** Вопросы, на которые уже ответили (индекс → верно ли) */
  answered: Record<number, boolean>;
}

function loadProgress(hash: string): QuizProgress | null {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<
      string,
      QuizProgress
    >;
    const p = all[hash];
    return p && typeof p.i === "number" ? p : null;
  } catch {
    return null;
  }
}

function saveProgress(hash: string, p: QuizProgress | null) {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<
      string,
      QuizProgress
    >;
    if (p) all[hash] = p;
    else delete all[hash];
    // Вытеснение старых: квиз — копеечная запись, кап от мусора
    const keys = Object.keys(all);
    if (keys.length > PROGRESS_CAP) {
      for (const k of keys.slice(0, keys.length - PROGRESS_CAP)) delete all[k];
    }
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    // localStorage недоступен — квиз работает без прогресса
  }
}

function sameAnswer(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Квиз из ```quiz-блока ответа модели: вопросы генерирует модель И ключи
 *  к ним, поэтому объяснение после ответа — обязательная часть (его можно
 *  проверить глазами). Прогресс локален и переживает рестарт */
export function QuizBlock({ code }: { code: string }) {
  const { t } = useLang();
  const spec = useMemo(() => parseQuizBlock(code), [code]);
  const hash = useMemo(() => blockHash(code), [code]);
  const [progress, setProgress] = useState<QuizProgress | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [hintShown, setHintShown] = useState(false);

  // Прогресс читаем один раз на монтировании блока: содержимое квиза
  // неизменно, внешних изменений хранилища не ждём
  useEffect(() => {
    const p = loadProgress(hash);
    if (p && spec && p.i < spec.questions.length) {
      setProgress(p);
      setHintShown(p.answered[p.i] !== undefined);
    }
  }, [hash, spec]);

  if (!spec) {
    return (
      <pre className="overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-code-bg px-3 py-2 text-xs leading-relaxed text-halo-text">
        {code}
      </pre>
    );
  }

  // До первого ответа прогресса нет — работаем от нулевого дефолта
  const base = progress ?? { i: 0, score: 0, answered: {} };
  const answeredMap = base.answered;
  const finished = base.i >= spec.questions.length;
  // После ответа на последний вопрос индекс указывает за пределы массива
  const q = finished ? spec.questions[0]! : spec.questions[base.i]!;
  const answered = answeredMap[base.i] !== undefined;
  const isCorrect = answeredMap[base.i] === true;
  const multi = q.answer.length > 1;
  const score = base.score;

  const commit = (next: QuizProgress) => {
    setProgress(next);
    saveProgress(hash, next);
  };

  const toggle = (idx: number) => {
    if (answered) return;
    setSelected((prev) =>
      multi
        ? prev.includes(idx)
          ? prev.filter((v) => v !== idx)
          : [...prev, idx].sort((a, b) => a - b)
        : [idx],
    );
  };

  // Проверка только фиксирует ответ: результат с объяснением остаётся на
  // экране, к следующему вопросу пользователь идёт сам (кнопка «Далее»)
  const check = () => {
    if (selected.length === 0) return;
    const ok = sameAnswer(selected, q.answer);
    commit({
      ...base,
      score: base.score + (ok ? 1 : 0),
      answered: { ...base.answered, [base.i]: ok },
    });
  };

  const advance = () => {
    commit({ ...base, i: base.i + 1 });
    setHintShown(false);
    setSelected([]);
  };

  const restart = () => {
    saveProgress(hash, null);
    setProgress(null);
    setSelected([]);
    setHintShown(false);
  };

  return (
    <div className="my-1 rounded-lg border border-halo-line/60 bg-halo-deep/40 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-halo-text">
          {spec.title ?? t("quiz.title")}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[0.625rem] tabular-nums text-halo-muted">
            {finished
              ? t("quiz.finalScore", { score, total: spec.questions.length })
              : t("quiz.progress", {
                  n: base.i + 1,
                  total: spec.questions.length,
                })}
          </span>
          <button
            onClick={restart}
            className="text-[0.625rem] text-halo-muted underline-offset-2 hover:text-halo-text hover:underline"
          >
            {t("quiz.restart")}
          </button>
        </span>
      </div>

      {finished ? (
        <div className="space-y-2">
          <div className="rounded-md border border-halo-line/60 bg-halo-raised/40 px-3 py-2 text-sm text-halo-text">
            {t("quiz.done", { score, total: spec.questions.length })}
          </div>
          <button
            onClick={restart}
            className="press rounded-md border border-halo-accent/40 bg-halo-accent/10 px-2.5 py-1 text-xs text-halo-accent hover:bg-halo-accent/20"
          >
            {t("quiz.restart")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm leading-snug text-halo-text">{q.question}</div>

          <div className="grid gap-1">
            {q.options.map((opt, idx) => {
              const chosen = selected.includes(idx);
              const reveal = answered;
              const correct = q.answer.includes(idx);
              // Статусы верно/неверно — семантическая палитра вне тем (конвенция)
              const tone = reveal
                ? correct
                  ? "border-emerald-500/50 bg-emerald-500/10 text-halo-text"
                  : chosen
                    ? "border-red-500/50 bg-red-500/10 text-halo-text"
                    : "border-halo-line/60 bg-halo-raised/30 text-halo-muted"
                : chosen
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-text"
                  : "border-halo-line/60 bg-halo-raised/30 text-halo-text hover:border-halo-line";
              return (
                <button
                  key={idx}
                  onClick={() => toggle(idx)}
                  disabled={answered}
                  className={`rounded-md border px-2.5 py-1.5 text-left text-xs leading-snug transition-colors ${tone}`}
                >
                  {opt}
                  {reveal && correct && (
                    <span className="ml-1.5 text-emerald-400">✓</span>
                  )}
                </button>
              );
            })}
          </div>

          {!answered && q.hint && (
            <div>
              {hintShown ? (
                <div className="rounded-md border border-halo-line/60 bg-halo-raised/40 px-2.5 py-1.5 text-xs italic text-halo-muted">
                  {q.hint}
                </div>
              ) : (
                <button
                  onClick={() => setHintShown(true)}
                  className="text-[0.625rem] text-halo-muted underline-offset-2 hover:text-halo-text hover:underline"
                >
                  {t("quiz.hint")}
                </button>
              )}
            </div>
          )}

          {answered && (
            <div
              className={`rounded-md border px-2.5 py-1.5 text-xs leading-relaxed ${
                isCorrect
                  ? "border-emerald-500/40 bg-emerald-500/5 text-halo-text"
                  : "border-red-500/40 bg-red-500/5 text-halo-text"
              }`}
            >
              <span className="font-medium">
                {isCorrect ? t("quiz.correct") : t("quiz.wrong")}
              </span>
              {q.explanation && ` — ${q.explanation}`}
            </div>
          )}

          {!answered ? (
            <div className="flex justify-end">
              <button
                onClick={check}
                disabled={selected.length === 0}
                className="press rounded-md border border-halo-accent/40 bg-halo-accent/10 px-2.5 py-1 text-xs text-halo-accent transition-colors hover:bg-halo-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {multi ? t("quiz.check") : t("quiz.answer")}
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                onClick={advance}
                className="press rounded-md border border-halo-accent/40 bg-halo-accent/10 px-2.5 py-1 text-xs text-halo-accent transition-colors hover:bg-halo-accent/20"
              >
                {/* Последний вопрос: кнопка открывает итоговую сводку */}
                {base.i + 1 < spec.questions.length ? t("quiz.next") : t("quiz.finish")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
