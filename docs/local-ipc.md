# Local IPC

Deep Pink exposes a versioned local socket on Linux so small native clients can
use app services without opening an Electron window. The GTK Quick Question
popup is the first client; the method names are intended to remain useful for
other local integrations.

## Endpoint and access

The service listens on a Unix domain socket at:

- `$XDG_RUNTIME_DIR/deep-pink-$UID.sock`, when `XDG_RUNTIME_DIR` is set.
- `$XDG_CACHE_HOME/deep-pink/ipc.sock`, or `~/.cache/deep-pink/ipc.sock` as a
  fallback.

The socket is mode `0600`. The fallback directory is mode `0700`; the runtime
directory must be private and owned by the current user. The service is local
to the user session and does not listen on a network interface.

## Framing

Messages are newline-delimited, tab-separated frames. Text payloads are UTF-8
encoded as base64 so tabs and newlines never affect framing. The maximum frame
size is 1 MiB.

```text
REQ<TAB>version<TAB>request-id<TAB>method<TAB>base64-payload<NEWLINE>
EVT<TAB>version<TAB>request-id<TAB>event-name<TAB>base64-payload<NEWLINE>
RES<TAB>version<TAB>request-id<TAB>status<TAB>base64-payload<NEWLINE>
```

The current version is `1`. Request IDs may contain letters, digits, `.`, `_`,
and `-`, and are limited to 64 characters. A connection may have multiple
requests in flight. Events and final responses carry the originating request
ID. Unknown methods return an `error` response; an incompatible protocol
version closes the connection.

## Methods

| Method | Payload | Events and response |
| --- | --- | --- |
| `system.ping` | Empty | `ok` with `pong`. |
| `app.openMain` | Empty | Opens the main window; `ok` with `opened`. |
| `quickQuestion.ask` | The question text | Streams `quickQuestion.content` events and returns the final one-paragraph answer. |
| `quickQuestion.cancel` | The request ID to cancel on this connection | `ok` with `cancelled` or `not-running`. |

For example, a client can ask a question with:

```text
REQ<TAB>1<TAB>q-1<TAB>quickQuestion.ask<TAB>SG93IGZhc3QgY2FuIGEgY2hlZXRhaCBydW4gPwo=<NEWLINE>
```

It receives zero or more `EVT` frames, then one `RES` frame. An error response
has status `error` and a base64-encoded UTF-8 error message. The socket remains
open until the client exits so the service can tell whether a standalone
launcher is still in use.

## Native launcher

The Linux build compiles `native/launcher.c` as `deep-pink-launcher` and
packages it under `resources/native/`. On startup the app copies it to a stable
path under its user data directory; Settings shows that path for a window
manager shortcut. On Wayland compositors with layer-shell protocol v4, it uses
an overlay layer with on-demand keyboard focus, preserving the compositor's
normal shortcuts. Older protocol versions use the regular GTK dialog fallback
because they only offer exclusive keyboard focus. The native popup starts the Electron process with
`--ipc-server` if the socket is not available; that service exits when the
popup disconnects unless background Quick Question is enabled.

Build just the GTK launcher with:

```sh
just launcher
```

`just build` compiles it along with the app, and `just package-linux` builds all
Linux packages with the helper included. These commands require a C compiler,
`pkg-config`, GTK 3 development files, and GTK Layer Shell development files.
