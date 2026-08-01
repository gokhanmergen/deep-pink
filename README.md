# Deep Pink

A local-first desktop chat client for [OpenRouter](https://openrouter.ai). Your threads, statistics and settings live in a SQLite file on your own machine, and the app makes no network request you did not ask for.

MIT licensed. Built with Electron, React and TypeScript. Runs on Linux, macOS and Windows.

---

## What it does

**Models and routing**

- Bring your own OpenRouter API key, stored encrypted through your OS keyring.
- Pick any model from the full OpenRouter catalogue.
- Choose the *specific upstream provider* for a model — pin one outright, set an order of preference, sort by price/throughput/latency, or refuse providers that train on your data. Scope the choice to one thread or to every use of that model.
- Choose which model writes your thread names, and edit the prompt it uses.

**The conversation**

- Markdown, GitHub-flavoured tables, LaTeX (`$…$` and `$$…$$`) via KaTeX, and syntax-highlighted code blocks with copy buttons — all rendered locally.
- Streaming replies, with reasoning traces when the model produces them.
- Edit any message, regenerate any reply, branch a thread from any point.
- Instant search across every message, backed by a local FTS5 index. Results appear as you type because nothing leaves your machine.

**Capabilities**

- Web search and web fetch as toggleable tools — per thread or globally. Backends: DuckDuckGo, your own SearXNG instance, or OpenRouter's `:online` plugin. Off by default.
- Full MCP support over stdio and streamable HTTP. Per-server tool toggles, and per-call approval prompts so nothing runs without you saying yes.
- Context compaction: when a thread approaches the model's context window, the older part is replaced by a summary. The threshold, the prompt and the model are all yours to set; the original messages stay in the database.

**Bringing your history with you**

- Import a ChatGPT data export (Settings → Data controls → Export data). Drop in the `.zip` and it reconstructs each conversation from the branching tree ChatGPT stores, keeping the branch you last had on screen, along with titles, timestamps and any images you uploaded. Re-importing the same export changes nothing. Imported chats carry no cost, so your spending statistics stay true.

**Transparency**

- A system-prompt inspector shows every segment that will be sent — base prompt, thread prompt, tool schemas, and anything an MCP server wants to inject — with token counts, attribution and an off switch for each.
- MCP server instructions are **never** added to the system prompt until you read them and opt in.
- Per-message token counts, cost, cache hits, tokens/second and time-to-first-token.
- Per-thread and global statistics: spend by day, by model and by provider.

**Everything is keyboard-reachable**

Every action has a binding, every binding is rebindable, and `Ctrl/⌘ K` opens a command palette over the lot. `Ctrl/⌘ /` shows the cheatsheet.

---

## Install

### Download a build

Linux builds are published to the
[releases page](https://github.com/gokhanmergen/deep-pink/releases): an
AppImage, a `.deb`, an `.rpm` and a tarball, with `SHA256SUMS.txt` to check
them against. Built for x86-64.

The newest one is always at
[`/releases/latest`](https://github.com/gokhanmergen/deep-pink/releases/latest),
so an auto-updater can follow it:

```bash
curl -s https://api.github.com/repos/gokhanmergen/deep-pink/releases/latest \
  | grep -o 'https://[^"]*\.AppImage'
```

```bash
chmod +x 'Deep Pink-0.1.0-arm64.AppImage' && ./'Deep Pink-0.1.0-arm64.AppImage'
```

### From source

```bash
git clone https://github.com/gokhanmergen/deep-pink.git
cd deep-pink
pnpm install
pnpm dev
```

Node 20 or newer, and [pnpm](https://pnpm.io/installation). pnpm is used rather
than npm because electron-builder needs a package manager it can drive to
rebuild the native SQLite binding against Electron's ABI, and because npm's
hoisting quietly hides undeclared dependencies.

`pnpm install` downloads or compiles that SQLite binding; on Linux it needs
`build-essential` and `python3` if no prebuilt binary matches your platform.

### Build a Linux package yourself

```bash
pnpm dist:linux
```

Produces AppImage, `.deb`, `.rpm` and a tarball in `release/`.

Runtime dependencies on Debian/Ubuntu: `libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0`. `libsecret` is what backs encrypted key storage — without it the app still runs, and tells you the key is stored as a permission-restricted file instead.

### Build a macOS app

```bash
pnpm dist:mac
```

Produces `release/Deep Pink-<version>-arm64.dmg` and a `.zip`. Drag the app to
`/Applications` and open it.

The build is **ad-hoc signed**, because this project has no Apple Developer ID.
That is enough for Apple Silicon to run it locally, and the entitlements in
`build/entitlements.mac.plist` let the hardened runtime load the native SQLite
binding. macOS may still warn the first time — right-click the app and choose
*Open*, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Deep Pink.app"
```

### Wayland

Electron defaults to XWayland, which is usually fine but can render blurry on
HiDPI and can behave oddly with tiling compositors. To run natively:

```bash
deep-pink --ozone-platform-hint=auto
```

The app itself declares no draggable window regions outside macOS, because
Chromium's hit-testing for them misbehaves under Wayland and swallows clicks.

### First run

Open Settings (`Ctrl/⌘ ,`), paste an [OpenRouter key](https://openrouter.ai/keys), and start a thread.

---

## Where your data lives

One SQLite file under your platform's user-data directory:

| OS      | Path                                                  |
| ------- | ----------------------------------------------------- |
| Linux   | `~/.config/deep-pink/deep-pink.db`                    |
| macOS   | `~/Library/Application Support/deep-pink/deep-pink.db` |
| Windows | `%APPDATA%\deep-pink\deep-pink.db`                    |

Settings › Data shows the exact path and can open it in your file manager.

The app contacts exactly three kinds of host, all of them at your instruction:

1. **OpenRouter**, to list models and run completions.
2. **MCP servers** you configure — local processes or URLs you supply.
3. **The web**, only when web access is on and only for the searches and fetches the model makes. Loopback, link-local and private addresses are always refused.

There is no telemetry, no crash reporting and no update check. App attribution to OpenRouter — the header that puts a client on their public leaderboards — is off unless you turn it on.

---

## Keyboard shortcuts

`mod` is `⌘` on macOS and `Ctrl` elsewhere.

| | |
| --- | --- |
| `mod K` | Command palette |
| `mod P` | Search all threads |
| `mod N` | New thread |
| `mod M` | Change model |
| `mod ⇧ M` | Choose provider |
| `mod ⇧ T` | Choose thread-naming model |
| `mod I` | Inspect system prompt |
| `mod ⇧ W` | Toggle web access |
| `mod ⇧ E` | MCP servers |
| `mod ⇧ C` | Compact context |
| `mod ⇧ S` | Thread statistics |
| `mod ⇧ G` | Global statistics |
| `mod B` | Toggle sidebar |
| `mod /` | All shortcuts |

The full list, including the ones not shown here, is in the cheatsheet — and all of it is rebindable in Settings › Keyboard.

---

## Development

```bash
pnpm dev         # hot-reloading dev build
pnpm typecheck   # main, preload and renderer
pnpm test        # storage, streaming, tool handling, layout, web guards
pnpm build       # production bundle
```

To cut a release, bump the version and push the tag — the workflow builds the
Linux artefacts, refuses to publish if the tests fail or the tag disagrees with
`package.json`, and attaches everything to a GitHub release:

```bash
pnpm version patch
git push --follow-tags
```

The tests run inside Electron, because the storage layer is built against Electron's ABI and `safeStorage` exists nowhere else. On a headless machine, use `xvfb-run --auto-servernum pnpm test`.

## Project layout

```
src/
├─ main/              Electron main process
│  ├─ db/             SQLite schema, migrations, repository
│  ├─ providers/      OpenRouter client (streaming, routing, cost)
│  ├─ mcp/            MCP client host
│  ├─ tools/          Built-in web search and fetch
│  └─ chat/           System-prompt assembly, tool loop, compaction
├─ preload/           The single contextBridge surface
├─ renderer/          React UI
└─ shared/            Types shared across the boundary
```

The API key never crosses IPC, and the renderer runs with `contextIsolation` on and `nodeIntegration` off.

---

## Licence

MIT — see [LICENSE](LICENSE).
