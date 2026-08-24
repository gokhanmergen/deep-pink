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
- Click a picture and it opens where you already are, not in whatever the desktop registered for PNGs: a viewer over the conversation with wheel-to-zoom about the pointer, drag to pan, double-click between fitted and actual size, `+` `−` `0` `1` on the keyboard, and the arrow keys stepping through every image in the thread. Save a copy or put it on the clipboard from the same bar; the desktop's own viewer is still one button away. Escape puts you back exactly where you were.
- Edit any message, regenerate any reply, branch a thread from any point.
- Threads name themselves from the first exchange, and keep trying until one sticks: stopping a reply, a failed request or closing the app mid-turn used to leave a thread called "Untitled" for good. Anything still unnamed is named on the next reply, or at the next start. Ask for a fresh name at any time with `⇧ F2`, from the command palette, or by right-clicking the thread.
- Open a thread, say nothing, go elsewhere and it is gone — an unnamed thread with no messages in it is not worth a row in the list. Pin it, file it in a folder or say something and it stays.
- Instant search across every message, backed by a local FTS5 index. Results appear as you type because nothing leaves your machine.
- Folders, for when the list gets long. Make one with `Ctrl/⌘ ⇧ N` or the small “New folder” button under the search box, then drag threads in and out of it — dropping a thread anywhere that is not a folder takes it back out. A folder sits in the list at the time its most recently edited thread was edited, so the ones you are working out of stay near the top, and it can be pinned exactly as a thread can.
- Opening a folder opens it in place: nothing is hidden, the rest of the list stays where it was, and everything outside the folder simply dims so what is inside reads at a glance. A dimmed thread is an ordinary row — click it and it opens. `Ctrl/⌘ ⇧ F` files the open thread by name, creating the folder if there is not one by that name yet, and clearing the name takes it out again.

**Capabilities**

- Charts in replies: a model can answer with a line, area, bar, column or scatter chart by writing a fenced `dp-chart` block of JSON, and the app draws it — in the same palette, on the same grid and with the same crosshair as the statistics panels, because the model chooses the numbers and Deep Pink chooses everything else. Off by default, switchable per thread from the composer or with `Ctrl/⌘ ⇧ B`, and the exact paragraph of system prompt the model is given is on screen in Settings › Charts. **It is deliberately not HTML**: nothing a model writes is ever parsed as markup, so a chart cannot run a script, load a remote image, restyle the window or escape the message it is in. Everything is validated and clamped before it reaches a component; anything that does not validate stays the code block it was and says why, and the numbers behind any chart are one click away.

- Web search and web fetch as toggleable tools — per thread or globally. Backends: DuckDuckGo, your own SearXNG instance, or OpenRouter's `:online` plugin. Off by default.
- Full MCP support over stdio and streamable HTTP. Per-server tool toggles, and per-call approval prompts so nothing runs without you saying yes.
- Context compaction: when a thread approaches the model's context window, the older part is replaced by a summary. The threshold, the prompt and the model are all yours to set; the original messages stay in the database.

**Bringing your history with you**

- Chat width is yours to set: Settings › Appearance has a slider from a narrow prose measure up to nearly the full window, and the transcript and composer follow it together.
- Import a ChatGPT data export (Settings → Data controls → Export data). Drop in the `.zip` and it reconstructs each conversation from the branching tree ChatGPT stores, keeping the branch you last had on screen, along with titles, timestamps and any images you uploaded. Re-importing the same export changes nothing. Imported chats carry no cost, so your spending statistics stay true.
- Export a thread two ways, from the command palette or by right-clicking it in the sidebar. **Markdown** (`Ctrl/⌘ ⇧ X`) is for reading and for handing to somebody else: every turn, what answered it, the reasoning folded away in a `<details>`, and what each reply cost. An **archive** (`Ctrl/⌘ ⌥ X`) is a single `.dpthread.json` this app can read back — the thread's name and settings, its folder, every message including what compaction replaced, the images inline, and the tokens and cost of each turn.
- Importing an archive is the same **Import conversations** picker; which format a file is gets worked out from the file itself. A conversation lands as a copy under a new id, so re-importing the same file a second time does nothing. Costs come back with it, so a library moved between machines still adds up. Anything the file names that this machine does not have — a directory that was attached, an MCP server, a model OpenRouter is not offering you — is dropped rather than allowed to fail the import; the model is the one it tells you about, since a thread that quietly changed which model it talks to would be a surprise. What each *reply* was answered by is left exactly as it was: that is a record of what happened, not a setting.

**Sync, if you want it**

- Sync across machines through any S3-compatible bucket you control — AWS, Cloudflare R2, Backblaze B2, MinIO on a machine in the next room. Off until you set it up, and it runs on its own after that: a few seconds after something changes, and every five minutes for whatever changed elsewhere.
- **The server is told nothing.** Everything is encrypted on your machine with a 256-bit key you generate, using AES-256-GCM with a fresh key derived per object; even the object *names* are keyed hashes, so a bucket listing gives away neither how many conversations you have nor which of them you touched today. There is no public-key cryptography anywhere in it, which is what makes it quantum-proof: the only attack left is Grover's against a symmetric key, and that leaves 128 bits standing. The key is yours alone — nobody can recover it for you, so write it down before you need it. Settings › Sync shows an eight-character fingerprint so you can check two machines match.
- Choose what travels: **conversations** (threads, messages, folders, attachments and their costs) and **settings** (prompts, models, shortcuts, appearance, MCP servers), independently. **Your OpenRouter key is never synced** — it lives in the OS keyring on the machine you typed it into and has never been in the database.
- Deletions travel too, which is the part naive sync gets wrong: every row that goes leaves a tombstone behind, recorded by a database trigger so nothing can miss one — not a cascade, not a code path written later. Delete a thread on your laptop and it goes from your desktop; a machine that has been asleep for a month will not hand it back.
- A line above the sidebar footer is the only place sync is visible: what it is doing while it works, with a bar that fills as it goes, when it last succeeded otherwise, and red when it has actually stopped — click it for the detail. Settings › Sync shows the same run at full size.
- Conflicts resolve last-write-wins per record, which is the honest model for one person's own machines. Records are immutable in the bucket — an object's name includes the revision it holds — so two machines pushing at once cannot corrupt anything, and superseded versions are collected afterwards.

**Transparency**

- A system-prompt inspector shows every segment that will be sent — base prompt, thread prompt, tool schemas, and anything an MCP server wants to inject — with token counts, attribution and an off switch for each.
- MCP server instructions are **never** added to the system prompt until you read them and opt in.
- Per-message token counts, cost, cache hits, tokens/second and time-to-first-token.
- Per-thread and global statistics, charted: a daily cost or token curve over the last 7 / 30 / 90 days with a crosshair readout, and a per-turn curve for the open thread — the one long reply that was half the cost shows up as a spike rather than hiding in an average. Every figure a chart shows is also in the table beneath it.
- Switch the daily chart to *by model* and each model gets its own line, in a colour palette checked for colour-vision deficiency against this exact background. Click a name in the legend to take that line out; the ones left keep their colours, and the axis rescales to what is actually on screen. Past five models the tail folds into one "Other" line rather than inventing hues nobody could tell apart.

**Everything is keyboard-reachable**

Every action has a binding, every binding is rebindable, and `Ctrl/⌘ K` opens a command palette over the lot. `Ctrl/⌘ /` shows the cheatsheet.

---

## Install

### Download a build

Linux and macOS builds are published to the
[releases page](https://github.com/gokhanmergen/deep-pink/releases): an
AppImage, a `.deb`, an `.rpm` and a tarball for Linux on x86-64, and a `.dmg`
and `.zip` for macOS on Apple Silicon — with an Intel disk image alongside them
when that build succeeds. `SHA256SUMS.txt` covers every file.

Nothing is signed with a paid developer certificate. Linux may ask you to
confirm the first launch; macOS will refuse it outright, so open the app once
with right-click → Open, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Deep Pink.app"
```

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

There is no telemetry, no crash reporting and no update check. The one thing that does identify anything is app attribution to OpenRouter — the header that puts a client on their public leaderboards. It names the app and its repository, never you, and it is on by default; Settings › Account turns it off and requests go out anonymously from then on.

---

## Keyboard shortcuts

`mod` is `⌘` on macOS and `Ctrl` elsewhere.

| | |
| --- | --- |
| `mod K` | Command palette |
| `mod P` | Search all threads |
| `mod N` | New thread |
| `F2` / `⇧ F2` | Rename thread / regenerate its name |
| `mod ⇧ N` | New folder |
| `mod ⇧ F` | File this thread in a folder |
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
Linux and macOS artefacts on their own machines, refuses to publish if the
tests fail or the tag disagrees with `package.json`, and attaches everything to
one GitHub release:

```bash
pnpm version patch
git push --follow-tags
```

The tests run inside Electron, because the storage layer is built against Electron's ABI and `safeStorage` exists nowhere else. On a headless machine, use `xvfb-run --auto-servernum pnpm test`.

To change the app icon, point the generator at one square image and rebuild:

```bash
python3 scripts/make-icons.py artwork.png
```

It writes `build/icon.icns` (macOS, padded to Apple's 824-in-1024 grid),
`build/icon.png` (Linux, full-bleed) and `build/icon.ico` (Windows). Needs
Pillow; the `.icns` step needs macOS.

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
