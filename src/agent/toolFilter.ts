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
    if (opts.removeSubagent && (name === "subagent_run" || name === "workflow_run"))
      // workflow_run тоже не субагентам: вложенный сценарий = глубина > 1
      return false;
    // Память выключена тумблером — модель не должна звать её инструменты
    if (opts.removeMemory && name.startsWith("memory_")) return false;
    return !disabled.has(name);
  });
}

/**
 * Мутирующий ли инструмент (plan-режим блокирует, ask — спрашивает).
 * ЗЕРКАЛО perm.rs (is_mutating, perm.rs:74-81): классификация обязана
 * совпадать на обеих сторонах, иначе ask/plan-гардал бекенда и подтверждение
 * фронта расходятся. Стык держится на этом тесте + комментарии-зеркале:
 * при добавлении инструмента обнови ОБЕ стороны и тест ниже.
 */
export function isMutatingTool(name: string): boolean {
  return (
    name === "shell_run" ||
    name === "fs_write" ||
    name === "fs_delete" ||
    name === "vault_write" ||
    name === "memory_save" ||
    name === "image_generate" ||
    name.startsWith("mcp__") ||
    (name.startsWith("browser_") &&
      name !== "browser_read" &&
      name !== "browser_screenshot") ||
    (name.startsWith("computer_") && name !== "computer_screenshot")
  );
}
