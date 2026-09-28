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
4. Update the updater endpoint in `tauri.conf.json` if the repository is not
   `nocturn-app/nocturn` (it points to
   `https://github.com/<org>/<repo>/releases/latest/download/latest.json`).

## Cutting a release

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (keep them in sync).
2. Commit and push, then tag:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

3. CI builds the installer on `windows-latest` and attaches the `.exe`/`.msi`,
   updater signatures (`.sig`) and `latest.json` to the GitHub Release.
4. Installed clients check `latest.json` on startup and offer the update.

## Notes

- `latest.json` is what the in-app updater reads; it is generated because
  `bundle.createUpdaterArtifacts` is enabled. Without
  `TAURI_SIGNING_PRIVATE_KEY` the build step fails — that is intentional
  (unsigned updater artifacts must not ship).
- The `pubkey` placeholder must be replaced before the first tagged release.
- **macOS builds**: the updater requires a signed (and ideally notarized)
  app bundle — ad-hoc signatures will not pass Gatekeeper when applying an
  update. Configure `signingIdentity` + notarization in the CI job before
  shipping any macOS artifact; until then macOS releases must be
  distributed as manual downloads, not via the in-app updater.
- **Linux builds**: auto-discovery for Browser Use expects Edge binaries in
  PATH as `microsoft-edge` / `microsoft-edge-stable`; ambient video playback
  depends on GStreamer codecs (gst-libav for mp4/mov) being installed.
