# Building and releasing FlowState

FlowState is packaged with [electron-builder](https://www.electron.build) (config: `electron-builder.yml`).
All installers are **unsigned** (see "What is unsigned" below).

## Build locally

Install dependencies once with `npm ci`. Each OS builds its own installers; cross-building is not supported
because `@lydell/node-pty` ships a different prebuilt binary per OS/CPU and npm installs only the one that
matches the build machine.

| OS | Command | Output in `dist/` |
|----|---------|-------------------|
| Windows | `npm run dist:win` | `FlowState-Setup-<v>-x64.exe` (NSIS), `FlowState-Portable-<v>-x64.exe` |
| macOS | `npm run dist:mac` (add `-- --arm64` or `-- --x64` for one CPU) | `FlowState-<v>-mac-<arch>.dmg` and `.zip` |
| Linux | `npm run dist:linux` | `FlowState-<v>-linux-x64.AppImage`, `.deb`, `.tar.gz` |

Quick packaging check without installers: `npm run dist:dir` (Windows, produces `dist/win-unpacked`).
On macOS an Apple Silicon machine builds arm64 natively; an Intel machine builds x64. Build the other CPU on a
matching machine (CI does this, see below). The Linux build needs a normal Linux userland (the AppImage/deb tools
are downloaded by electron-builder).

Icons are generated without dependencies: `npm run icon` writes `build/icon.png` (512 px) and `build/icons/<N>x<N>.png`
(16 to 1024). electron-builder converts `build/icon.png` to `.ico` / `.icns`.

### Native module note
`@lydell/node-pty` (the in-app sign-in terminal) is listed in `asarUnpack`, so its prebuilt `.node` files and the
macOS/Linux `spawn-helper` live in `resources/app.asar.unpacked/node_modules/@lydell/`. Verified on Windows
(`dist/win-unpacked` contains only `node-pty` and `node-pty-win32-x64`).

## What is unsigned (and how users open it)

- **Windows:** no Authenticode certificate. SmartScreen shows "Windows protected your PC": click **More info -> Run anyway**.
- **macOS:** the app carries an ad-hoc signature (`identity: "-"`, required for Apple Silicon to launch a modified bundle)
  but is not signed with a Developer ID and not notarized. Gatekeeper blocks the first launch: **right-click the app ->
  Open -> Open**, or run `xattr -cr /Applications/FlowState.app` once. Notarization is future work (needs a paid Apple Developer account).
- **Linux:** AppImages are not signed. `chmod +x FlowState-*.AppImage` then run it. The `.deb` installs with
  `sudo apt install ./FlowState-<v>-linux-x64.deb`; the `.tar.gz` is a plain archive (run `flowstate` inside).
  Chromium's sandbox may need `--no-sandbox` on distributions that block unprivileged user namespaces.

## Cut a release

1. Bump `version` in `package.json`, commit, push to `main`.
2. Tag and push the tag:
   ```
   git tag v0.2.0
   git push --tags
   ```
3. The **Build** workflow (`.github/workflows/build.yml`) runs on the tag: unit tests, then packaging on
   `windows-latest`, `macos-latest` (arm64), `macos-15-intel` (x64) and `ubuntu-latest`. Each job uploads its
   installers as a workflow artifact.
4. When all four succeed, a **draft** GitHub Release is created with every installer attached. Nothing is public
   until you open the draft, review it and press **Publish release**.

You can also run **Build** manually (Actions tab -> Build -> Run workflow) to get artifacts without a release.
`.github/workflows/ci.yml` runs `npm ci && npm test` on Windows, Linux and macOS for every pull request and push to `main`.

`macos-13` (named in the original plan) was retired by GitHub, so the Intel build uses `macos-15-intel`.

## Verification status
Windows packaging was built and inspected locally. The macOS and Linux targets and both workflows are written
from the electron-builder/GitHub documentation and unit-tested logic only; they have not been run on real
machines or runners yet. Expect to fix small things on the first tagged run.
