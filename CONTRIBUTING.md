# Contributing to OurAdventureBook

Thanks for your interest! Contributions of all kinds are welcome — bug fixes,
features, docs, and ideas.

## Prerequisites

- **macOS** with the Photos app (the app reads your local Apple Photos library).
- **Node.js** 18+ and **Python 3**.

## Getting set up

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/ouradventurebook
cd ouradventurebook

# 2. Install everything (Node deps + a Python venv with Pillow + osxphotos)
npm run setup

# 3. Grant your terminal Full Disk Access so osxphotos can read Photos
#    System Settings → Privacy & Security → Full Disk Access

# 4. Run the app
npm run dev   # http://localhost:5173
```

Create your own trip from the home page to test with real data — you don't need
anyone else's.

## Development workflow

1. Create a branch: `git checkout -b fix/short-description` (or `feat/...`).
2. Make your change. Keep it focused — one topic per PR.
3. Make sure it still builds and type-checks:
   ```bash
   npm run build
   ```
4. Commit with a clear message and push to your fork.
5. Open a **Pull Request** against `main`. Describe what changed and why; add a
   screenshot for UI changes (blur any personal photos — see below).

Maintainers review, may request changes, and merge when it's ready.

## 🔒 Never commit personal data

Everything under `trips/` (photos, captions, configs, exports) is **git-ignored on
purpose** and must never be committed. Don't `git add -f` anything in there, and
blur faces/photos in any screenshots you attach to issues or PRs.

## Project structure

```
src/                 React + TypeScript frontend
  App.tsx            trip editor (Curate + Album views)
  views/             Home, Curadoria (Curate), Album, Story (digital album), ...
  lib/               api client, types, album/slot logic
server/index.mjs     Express API (per-trip endpoints + image serving)
scripts/             osxphotos ingest → thumbnails, web images, photobook PDF, export
trips-lib.mjs        shared path/config helpers (one folder per trip)
trips/<slug>/        a trip's data (git-ignored)
```

## Code style

- TypeScript, small and readable — match the surrounding style.
- No build errors or type errors (`npm run build` must pass).
- Keep dependencies minimal.

## Reporting bugs / ideas

Open an [issue](https://github.com/GabrielCasemiro/ouradventurebook/issues) with
steps to reproduce (for bugs) or the problem you're trying to solve (for features).

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
