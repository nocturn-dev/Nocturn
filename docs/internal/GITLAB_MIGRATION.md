# GitLab-миграция — заготовка (05.10.2026)

GitHub-аккаунт владельца заблокирован, пуш в GitHub невозможен (ветка ahead,
см. PLAN §18). Следующая точка — GitLab. Документ — чеклист и заготовки, НЕ
выполненная миграция: хостинг/раннеры/публичность — решения владельца; пушит
владелец, агент — никогда (AGENTS.md, ритуал 3).

## Связки с GitHub в репо (инвентарь)

| Место | Что завязано | Куда мигрировать |
|---|---|---|
| `.github/workflows/ci.yml` | CI (frontend + rust-матрица 3 ОС) и релизы по тегам `v*` | `.gitlab-ci.yml` (драфт ниже) |
| `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` | `latest.json` с GitHub Releases | URL GitLab-релизов; см. «Обновлятор» |
| `RELEASE.md` | процесс: GitHub Secrets, теги, tauri-action | переписать после первых GitLab-релизов |
| `README.md` (ссылка Releases) | `github.com/nocturn-lab/Nocturn-AI/releases` | сменить на GitLab |
| `SECURITY.md` → Reporting | «open a GitHub issue» | сменить канал репортов |
| `PLAN.md` §18 «GitHub разбан» | пункт на владельце | закрыть решением «мигрируем на GitLab» |
| UPDATE.md / SESSION_NOTES | упоминания бана GitHub | история — не трогать |

## Порядок шагов (предложение)

1. **Репо**: владелец заводит проект на GitLab (приватность — его решение;
   сейчас GitHub-репо публичный, MIT).
2. **Пуш**: владелец локально —
   `git remote add gitlab <url> && git push gitlab main --tags`.
3. **CI**: переименовать драфт из этого дока в `.gitlab-ci.yml` в корне,
   подобрать раннеры (см. «Открытые решения»), первый прогон.
4. **Секреты**: `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   → Settings → CI/CD → Variables (ключ — type File, пароль — masked).
   Публичный ключ уже запечён в `tauri.conf.json` — пара подписи НЕ меняется,
   `.keys/` остаётся вне git.
5. **Релиз**: тег `v*` → release-джоба. ВАЖНО: `tauri-apps/tauri-action` —
   GitHub-only; на GitLab сборку делает `npm run tauri build`, а `latest.json`
   собирается скриптом (урок удалённого `make-latest-json.ps1`: `.sig` →
   `signature`, URL ассетов → `url`) и заливается `release-cli` / generic
   package registry. Без `TAURI_SIGNING_PRIVATE_KEY` сборка падает намеренно —
   неподписанные апдейтер-артефакты не выпускаем (RELEASE.md).
6. **Обновлятор**: новый endpoint из п.5 вписать в `tauri.conf.json`. Это
   ломающее изменение для УЖЕ установленных клиентов (0.2.2 смотрят на
   GitHub): на старом URL стоит оставить финальный релиз с последним
   `latest.json` (или редирект), иначе старые клиенты никогда не узнают про
   переезд.

## Открытые решения владельца

- **Хостинг**: GitLab.com (SaaS-раннеры, квоты минут, macOS-раннеры — бета)
  vs self-hosted GitLab + свой runner (полный контроль, своя машина должна
  быть включена).
- **Раннеры**: какие теги/мощности; гонять ли rust-матрицу на всех трёх ОС
  или начать с Windows+Linux (как требование RELEASE.md — macOS non-blocking).
- **Обновлятор**: где жить `latest.json` — GitLab Releases (страница проекта),
  generic packages или статический хост владельца.
- **GitHub после миграции**: заморозить как архив (объявление в README) или
  удалить; зеркалирование GitLab → GitHub в обратную сторону не планируется.
- **Публичность GitLab-репо**: public (как сейчас) / private.

## Драфт .gitlab-ci.yml

ЗАГОТОВКА: не активен (лежит в доке, не в корне). Активация — переименовать в
`.gitlab-ci.yml`. Теги раннеров (`saas-*`) — дефолтные пулы GitLab.com,
заменить при своих раннерах. Кэш cargo и webkit-зависимости Linux — грубые,
доводить при первом прогоне.

```yaml
# Драфт-перевод .github/workflows/ci.yml под GitLab.
# TODO(владелец): раннеры (tags), лимиты macOS, кэш cargo, переменные подписи.

stages: [test, release]

frontend:
  stage: test
  image: node:22
  tags: [saas-linux-medium-amd64]
  cache:
    key:
      files: [package-lock.json]
    paths: [.npm/]
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run lint
    - npm test
    - npm run build
    - npm audit --audit-level=high || true   # non-blocking, как в GH CI

rust-linux:
  stage: test
  image: ubuntu:22.04
  tags: [saas-linux-medium-amd64]
  cache:
    key: rust-linux
    paths: [src-tauri/target/]
  script:
    - apt-get update
    - apt-get install -y --no-install-recommends cargo rustc clippy libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    - cd src-tauri
    - cargo clippy --all-targets -- -D warnings
    - cargo test

rust-windows:
  stage: test
  tags: [saas-windows-medium-amd64]
  cache:
    key: rust-windows
    paths: [src-tauri/target/]
  script:
    - cd src-tauri
    - cargo clippy --all-targets -- -D warnings
    - cargo test

rust-macos:
  stage: test
  tags: [saas-macos-amd64]        # SaaS macOS — бета, дорогие минуты; можно выключить
  allow_failure: true
  cache:
    key: rust-macos
    paths: [src-tauri/target/]
  script:
    - cd src-tauri
    - cargo clippy --all-targets -- -D warnings
    - cargo test

# СХЕМА, не готовый пайплайн: tauri-action — GitHub-only, latest.json
# собирается вручную (см. шаг 5 чеклиста).
release-windows:
  stage: release
  rules: [{ if: '$CI_COMMIT_TAG =~ /^v/' }]
  tags: [saas-windows-medium-amd64]
  script:
    - npm ci
    - npm run tauri build
    # TODO: собрать latest.json (version/url/signature) из nsis/*.exe + *.sig
    # TODO: release-cli create + asset links (generic package registry)
  # Переменные CI/CD: TAURI_SIGNING_PRIVATE_KEY (type File),
  # TAURI_SIGNING_PRIVATE_KEY_PASSWORD (masked)
```
