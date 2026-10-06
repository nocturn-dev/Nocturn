#!/usr/bin/env node
/**
 * Локальный верификатор Nocturn — «зелёный коммит» без CI.
 *
 *   node scripts/verify.mjs fast   — tsc + eslint + vitest (pre-commit, десятки секунд)
 *   node scripts/verify.mjs all    — fast + cargo clippy + cargo test + vite build
 *
 * Шаги идут по порядку, первый провал останавливает прогон с ненулевым кодом.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "all";
if (mode !== "fast" && mode !== "all") {
  console.error(`verify: unknown mode "${mode}" (expected: fast | all)`);
  process.exit(2);
}

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m" }
  : { dim: "", bold: "", green: "", red: "", reset: "" };

/** npx под Windows — это .cmd, ему нужен shell; командная строка собирается
 *  строкой из контролируемых констант (DEP0190 не любит args+shell) */
function run(name, cmd, args, cwd) {
  const t0 = Date.now();
  process.stdout.write(`${C.dim}verify${C.reset} ${C.bold}${name}${C.reset} ... `);
  const useShell = process.platform === "win32";
  const r = spawnSync(useShell ? `${cmd} ${args.join(" ")}` : cmd, {
    cwd,
    stdio: "inherit",
    shell: useShell,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log(`${C.red}FAIL${C.reset} ${C.dim}(${dt}s, exit ${r.status ?? "?"})${C.reset}`);
    return false;
  }
  console.log(`${C.green}ok${C.reset} ${C.dim}(${dt}s)${C.reset}`);
  return true;
}

const steps = [
  { name: "tsc", cmd: "npx", args: ["tsc"], cwd: ROOT },
  { name: "eslint", cmd: "npx", args: ["eslint", "src"], cwd: ROOT },
  { name: "vitest", cmd: "npx", args: ["vitest", "run"], cwd: ROOT },
];

/** A7-2 (аудит 06.10): pre-commit гонял только JS-слой — красный cargo test
 *  (протухший счётчик tool_schemas_valid) пережил два коммита. cargo test в
 *  fast — но ТОЛЬКО когда rust-дерево реально трогается (индекс pre-commit
 *  или рабочее дерево): на тёплом кэше это секунды, холодный первый прогон —
 *  цена осознанная */
function rustTouched() {
  const g = (args) => {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().length > 0 : false;
  };
  return (
    g(["diff", "--cached", "--name-only", "--", "src-tauri"]) ||
    g(["status", "--porcelain", "--", "src-tauri"])
  );
}
if (mode === "fast" && rustTouched()) {
  steps.push({ name: "cargo test", cmd: "cargo", args: ["test"], cwd: path.join(ROOT, "src-tauri") });
}
if (mode === "all") {
  steps.push(
    {
      name: "clippy",
      cmd: "cargo",
      args: ["clippy", "--all-targets", "--", "-D", "warnings"],
      cwd: path.join(ROOT, "src-tauri"),
    },
    { name: "cargo test", cmd: "cargo", args: ["test"], cwd: path.join(ROOT, "src-tauri") },
    { name: "vite build", cmd: "npx", args: ["vite", "build"], cwd: ROOT },
  );
}

const t0 = Date.now();
let failed = null;
for (const s of steps) {
  if (!run(s.name, s.cmd, s.args, s.cwd)) {
    failed = s.name;
    break;
  }
}
const total = ((Date.now() - t0) / 1000).toFixed(1);
if (failed) {
  console.error(`\nverify: ${C.red}FAILED on "${failed}"${C.reset} ${C.dim}(${total}s)${C.reset}`);
  process.exit(1);
}
console.log(`\nverify: ${C.green}all green${C.reset} ${C.dim}(${mode}, ${total}s)${C.reset}`);
