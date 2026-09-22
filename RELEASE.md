# Release process

## One-time setup

1. Generate the updater signing keypair:

   ```bash
   npm run tauri signer generate -w ~/.tauri/nocturn.key
   ```

2. Replace `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the
   **public** key printed by the command.
3. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (or empty).
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
