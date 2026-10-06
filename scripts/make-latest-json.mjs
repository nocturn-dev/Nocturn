#!/usr/bin/env node
/**
 * Собирает latest.json для Tauri updater (RELEASE.md, GITLAB_MIGRATION.md
 * шаг 5). Формат файла проверен по документации Tauri v2 (v2.tauri.app/
 * plugin/updater): version + platforms[OS-ARCH] { signature, url }, где
 * signature — СОДЕРЖИМОЕ .sig-файла (не путь и не URL), url — ссылка на
 * скачиваемый ассет. Заливку ассетов и создание релиза делает
 * .gitlab-ci.yml (release-windows).
 *
 *   node scripts/make-latest-json.mjs <bundle-dir> <asset-url-prefix> [out]
 *
 *   bundle-dir       — каталог NSIS-сборки (…/target/release/bundle/nsis)
 *   asset-url-prefix — базовый URL ассета без имени файла
 *   out              — файл для результата (по умолчанию stdout)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [bundleDir, urlPrefix, out] = process.argv.slice(2);
if (!bundleDir || !urlPrefix) {
  console.error(
    "usage: make-latest-json.mjs <bundle-dir> <asset-url-prefix> [out]",
  );
  process.exit(2);
}

// Версия — из tauri.conf.json (может нести комментарии Tauri: вырезаем
// строки-комментарии перед JSON.parse; фолбэк — package.json)
function readVersion() {
  try {
    const raw = fs.readFileSync(
      path.join(ROOT, "src-tauri", "tauri.conf.json"),
      "utf8",
    );
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    const v = json?.version;
    if (typeof v === "string" && v) return v.replace(/^v/, "");
  } catch {
    // ниже — фолбэк
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return String(pkg.version).replace(/^v/, "");
}

// Артефакт апдейтера: installer .exe, рядом с которым лежит одноимённый .sig
// (таури-сборка с createUpdaterArtifacts). Несколько .exe (x64/arm64) —
// каждый получает свою запись, имя ключа платформы берём из архитектуры
// в имени файла (_x64/_arm64), дефолт — x86_64
function findArtifacts(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".exe"))
    .map((exe) => {
      const sigPath = path.join(dir, `${exe}.sig`);
      if (!fs.existsSync(sigPath)) {
        throw new Error(`no .sig next to ${exe} — is createUpdaterArtifacts on and the signing key set?`);
      }
      const arch = /_arm64/i.test(exe)
        ? "aarch64"
        : /_i686/i.test(exe)
          ? "i686"
          : "x86_64";
      return {
        key: `windows-${arch}`,
        url: `${urlPrefix.replace(/\/$/, "")}/${encodeURIComponent(exe)}`,
        signature: fs.readFileSync(sigPath, "utf8").trim(),
      };
    });
}

const artifacts = findArtifacts(bundleDir);
if (artifacts.length === 0) {
  console.error(`make-latest-json: no .exe installer found in ${bundleDir}`);
  process.exit(1);
}
const seen = new Set();
for (const a of artifacts) {
  if (seen.has(a.key)) {
    console.error(`make-latest-json: duplicate platform key ${a.key}`);
    process.exit(1);
  }
  seen.add(a.key);
}
const latest = {
  version: readVersion(),
  notes: `Nocturn ${readVersion()}`,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    artifacts.map((a) => [
      a.key,
      { signature: a.signature, url: a.url },
    ]),
  ),
};
const text = JSON.stringify(latest, null, 2);
if (out) {
  fs.writeFileSync(out, text);
  console.log(`make-latest-json: wrote ${out} (${latest.version})`);
} else {
  process.stdout.write(text + "\n");
}
