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

**Transparency**

- A system-prompt inspector shows every segment that will be sent — base prompt, thread prompt, tool schemas, and anything an MCP server wants to inject — with token counts, attribution and an off switch for each.
- MCP server instructions are **never** added to the system prompt until you read them and opt in.
- Per-message token counts, cost, cache hits, tokens/second and time-to-first-token.
- Per-thread and global statistics: spend by day, by model and by provider.

**Everything is keyboard-reachable**

Every action has a binding, every binding is rebindable, and `Ctrl/⌘ K` opens a command palette over the lot. `Ctrl/⌘ /` shows the cheatsheet.

---

## Install

### From source

```bash
git clone https://github.com/gokhanmergen/deep-pink.git
cd deep-pink
npm install
npm run dev
```

Node 20 or newer. `npm install` compiles or downloads a native SQLite binding for your Electron version; on Linux that needs `build-essential` and `python3` if no prebuilt binary matches your platform.

### Build a Linux package

```bash
npm run dist:linux
```

Produces AppImage, `.deb`, `.rpm` and a tarball in `release/`.

Runtime dependencies on Debian/Ubuntu: `libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0`. `libsecret` is what backs encrypted key storage — without it the app still runs, and tells you the key is stored as a permission-restricted file instead.

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
npm run dev         # hot-reloading dev build
npm run typecheck   # main, preload and renderer
npm test            # storage, streaming, tool handling, web guards
npm run build       # production bundle
```

The tests run inside Electron, because the storage layer is built against Electron's ABI and `safeStorage` exists nowhere else. On a headless machine, use `xvfb-run --auto-servernum npm test`.

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
