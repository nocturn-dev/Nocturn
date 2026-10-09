# Release process

## One-time setup

1. Keypair is already generated: the **public** key is set in
   `src-tauri/tauri.conf.json`; the private key and its password live in
   the local (gitignored) `.keys/` folder. To regenerate:

   ```bash
   npm run tauri signer generate -w ~/.tauri/nocturn.key
   ```

   (and update the pubkey in `tauri.conf.json` + the GitHub secrets).
2. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `.keys/nocturn-private.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of `.keys/PASSWORD.txt`.
3. The updater endpoint in `tauri.conf.json` points to
   `https://github.com/nocturn-dev/Nocturn/releases/latest/download/latest.json`.
   Earlier release channels (frozen GitHub `nocturn-lab` account, then GitLab)
   are unreachable for the updater; clients from those channels must update by
   downloading an installer manually.

## Cutting a release

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (+ the matching `Cargo.lock` entry — keep them in
   sync).
2. Commit, push to `origin` (GitHub `nocturn-dev/Nocturn`), then tag:

   ```bash
   git tag v0.2.3
   git push origin main --tags
   ```

3. The `v*` tag runs the `release` matrix in `.github/workflows/release.yml`
   (windows-latest, ubuntu-22.04, macos-latest): each job builds via
   `tauri-action` (signed where the updater requires it), and the action
   merges per-platform entries into one `latest.json` attached to the release.
   Without the signing secrets the build step fails — that is intentional
   (unsigned updater artifacts must not ship). The macOS job is
   `continue-on-error`: the builds are not signed/notarized, so the dmg ships
   but the in-app updater does not work on macOS (Gatekeeper rejects ad-hoc
   signatures — see Notes).
4. Installed clients check `latest.json` on startup and offer the update.

## Notes

- `latest.json` is what the in-app updater reads; it is generated because
  `bundle.createUpdaterArtifacts` is enabled. Without
  `TAURI_SIGNING_PRIVATE_KEY` the build step fails — that is intentional.
- The signing keypair is real and the pubkey in `tauri.conf.json` matches it.
- **macOS builds**: the updater requires a signed (and ideally notarized)
  app bundle — ad-hoc signatures will not pass Gatekeeper when applying an
  update. macOS is therefore not part of the release workflow; if it is
  added later, either configure `signingIdentity` + notarization, or exclude
  macOS artifacts from `latest.json` (owner decision).
- **Linux builds**: auto-discovery for Browser Use expects Edge binaries in
  PATH as `microsoft-edge` / `microsoft-edge-stable`; ambient video playback
  depends on GStreamer codecs (gst-libav for mp4/mov) being installed.
- **Updater asset URLs**: `releases/latest/download/…` resolves only for a
  public repo — the repo must stay public for the updater to work.
