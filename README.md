# codexer

`codexer` is a read-only Codex session tool with two entry points:

- a global CLI for finding sessions and exporting one `.jsonl` session to Markdown
- an Electrobun desktop browser for scanning sessions, filtering by folder, and exporting the selected session to `.md`

## CLI

Install it globally from this folder:

```powershell
npm install -g d:\github\codexer
```

Use either `codexer` or `codex-sessions`:

```powershell
codexer
codexer d:\github\myDUDreamTool
codexer /mnt/d/github/myDUDreamTool
codexer --md C:\Users\tobias\.codex\sessions\2026\03\06\session.jsonl
codexer --md C:\Users\tobias\.codex\sessions\2026\03\06\session.jsonl --include-images --include-tool-results
```

Notes:

- the folder argument is optional; if omitted, the current working directory is used
- if the folder is inside a git repo, the CLI matches sessions for the repo root by default
- use `--cwd-only` to match only the folder tree you pass in
- use `--codex-home PATH` if your Codex data lives somewhere other than `%CODEX_HOME%` or `~/.codex`
- use `--include-images` with `--md` to write embedded images into a sibling `.assets` folder and link them from Markdown
- use `--include-tool-results` with `--md` to include tool calls and tool outputs in the export
- Windows drive paths, WSL `/mnt/<drive>/...` paths, and WSL UNC paths are treated as aliases of the same repo

## Desktop App

The desktop browser uses [Electrobun](https://electrobun.dev/).

Prerequisites:

- Bun `>=1.3.9`
- Windows 11+ with WebView2 available for the embedded webview runtime

Run it locally:

```powershell
bun install
bun run start
```

For live UI reload while editing:

```powershell
bun run dev:hmr
```

Other useful commands:

```powershell
bun run build:web
bun run build
```

Notes:

- `bun run start` is the easiest local launch path because it builds the web assets first
- the first Electrobun run downloads its platform-specific core binaries
- the app defaults to the current folder tree on launch
