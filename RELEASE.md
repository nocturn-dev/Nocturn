# Release process

## One-time setup

1. Keypair is already generated: the **public** key is set in
   `src-tauri/tauri.conf.json`; the private key and its password live in
   the local (gitignored) `.keys/` folder. To regenerate:

   ```bash
   npm run tauri signer generate -w ~/.tauri/nocturn.key
   ```

   (and update the pubkey in `tauri.conf.json` + the GitHub secrets).

2. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `.keys/nocturn-private.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of `.keys/PASSWORD.txt`.
3. The updater endpoint in `tauri.conf.json` points to
   `https://github.com/nocturn-lab/Nocturn-AI/releases/latest/download/latest.json`
   — update it if the repository moves.

## Cutting a release

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (keep them in sync).
2. Commit and push, then tag:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

3. CI builds installers on a three-OS matrix (`windows-latest`,
   `ubuntu-22.04`, `macos-latest`) and attaches the Windows `.exe`/`.msi`,
   the Linux `.AppImage`/`.deb`, the unsigned macOS bundle, updater
   signatures (`.sig`) and `latest.json` to the GitHub Release. Only the
   Windows job has the signing key; the **macOS** artifact is built
   non-blocking (`continue-on-error`), a failing **Linux** job blocks
   the release.
4. Installed clients check `latest.json` on startup and offer the update.

## Notes

- `latest.json` is what the in-app updater reads; it is generated because
  `bundle.createUpdaterArtifacts` is enabled. Without
  `TAURI_SIGNING_PRIVATE_KEY` the build step fails — that is intentional
  (unsigned updater artifacts must not ship).
- The signing keypair is real and the pubkey in `tauri.conf.json` matches it
  (the old "replace the placeholder" step is done).
- **macOS builds**: the updater requires a signed (and ideally notarized)
  app bundle — ad-hoc signatures will not pass Gatekeeper when applying an
  update. KNOWN GAP: the release job builds macOS too and tauri-action with
  `includeUpdaterJson: true` merges macOS artifacts into the same
  `latest.json`, so macOS users may be offered an update that Gatekeeper
  will reject. Before shipping to macOS users: either configure
  `signingIdentity` + notarization, or exclude macOS artifacts from
  `latest.json` until then (owner decision).
- **Linux builds**: auto-discovery for Browser Use expects Edge binaries in
  PATH as `microsoft-edge` / `microsoft-edge-stable`; ambient video playback
  depends on GStreamer codecs (gst-libav for mp4/mov) being installed.
