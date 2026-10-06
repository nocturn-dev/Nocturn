# Release process

## One-time setup

1. Keypair is already generated: the **public** key is set in
   `src-tauri/tauri.conf.json`; the private key and its password live in
   the local (gitignored) `.keys/` folder. To regenerate:

   ```bash
   npm run tauri signer generate -w ~/.tauri/nocturn.key
   ```

   (and update the pubkey in `tauri.conf.json` + the GitLab CI variables).
2. In the GitLab project → **Settings → CI/CD → Variables**, add:
   - `TAURI_SIGNING_PRIVATE_KEY` (type **File**) — contents of
     `.keys/nocturn-private.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of `.keys/PASSWORD.txt`.
3. The updater endpoint in `tauri.conf.json` currently points to the frozen
   GitHub repository (`…/nocturn-lab/Nocturn-AI/releases/latest/download/latest.json`).
   After the first GitLab release exists, switch it to the GitLab asset URL —
   and keep a final `latest.json` on the old GitHub URL (or a redirect), or
   installed 0.2.x clients will never learn about the move
   (`docs/internal/GITLAB_MIGRATION.md`, шаг 6).

## Cutting a release

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (keep them in sync).
2. Commit, push to the `gitlab` remote, then tag:

   ```bash
   git tag v0.2.3
   git push gitlab main --tags
   ```

3. The `v*` tag runs the `release-windows` job in `.gitlab-ci.yml`: it builds
   the signed NSIS installer (`npm run tauri build`), generates `latest.json`
   with `scripts/make-latest-json.mjs`, uploads the installer, its `.sig` and
   `latest.json` to the project's **generic package registry**, and creates
   the release entry with `release-cli`. Without the signing variables the
   job fails — that is intentional (unsigned updater artifacts must not
   ship). Linux/macOS release jobs are not wired yet (GITLAB_MIGRATION.md,
   «Открытые решения»); rust test jobs cover all three platforms (macOS
   non-blocking).
4. Installed clients check `latest.json` on startup and offer the update
   (see the endpoint note above — until the endpoint is switched, they still
   look at the frozen GitHub URL).

## Notes

- `latest.json` is what the in-app updater reads; it is generated because
  `bundle.createUpdaterArtifacts` is enabled. Without
  `TAURI_SIGNING_PRIVATE_KEY` the build step fails — that is intentional.
- The signing keypair is real and the pubkey in `tauri.conf.json` matches it
  (the old "replace the placeholder" step is done).
- **macOS builds**: the updater requires a signed (and ideally notarized)
  app bundle — ad-hoc signatures will not pass Gatekeeper when applying an
  update. macOS is therefore not part of the GitLab release job; if it is
  added later, either configure `signingIdentity` + notarization, or exclude
  macOS artifacts from `latest.json` (owner decision).
- **Linux builds**: auto-discovery for Browser Use expects Edge binaries in
  PATH as `microsoft-edge` / `microsoft-edge-stable`; ambient video playback
  depends on GStreamer codecs (gst-libav for mp4/mov) being installed.
