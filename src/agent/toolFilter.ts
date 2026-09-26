/**
 * Фильтрация схем инструментов агента: убрать субагентов (когда выключены),
 * память memory_* (когда тумблер выключен) и инструменты, отключённые
 * пользователем для задачи (Session.disabledTools).
 * Чистая функция — юнит-тесты рядом. Элементы без function.name пропускаются
 * как есть: неизвестная форма схемы не должна молча теряться.
 */
export function filterToolSchemas(
  schemas: unknown,
  opts: { removeSubagent?: boolean; removeMemory?: boolean; disabled?: string[] },
): unknown {
  if (!Array.isArray(schemas)) return schemas;
  const disabled = new Set(opts.disabled ?? []);
  return schemas.filter((x) => {
    const name = (x as { function?: { name?: string } } | null)?.function?.name;
    if (name === undefined) return true;
    if (opts.removeSubagent && name === "subagent_run") return false;
    // Память выключена тумблером — модель не должна звать её инструменты
    if (opts.removeMemory && name.startsWith("memory_")) return false;
    return !disabled.has(name);
  });
}
