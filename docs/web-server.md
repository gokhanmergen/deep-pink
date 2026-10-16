# Web server

The experimental web server exposes a small HTTP API on `127.0.0.1`. It is off
by default. Turn on **Experimental Features** in Settings, then open **Settings
› Web server** and enable the listener. That page has its own model, system
prompt and port (3789 by default). Requests use only those prompt settings:
they do not receive web search, MCP servers, repository access, skills, or chat
tools. Replies are sent after generation finishes, not as a stream.

The listener binds to loopback only. Browser requests are accepted from
localhost origins. Result IDs live in memory for up to 24 hours and are lost
when Deep Pink exits.

## Endpoints

### `POST /v1/prompt`

Request:

```json
{"prompt":"What is the capital of France?"}
```

Response:

```json
{
  "id": "result-id",
  "prompt": "What is the capital of France?",
  "reply": "Paris.",
  "model": "anthropic/claude-sonnet-4.5"
}
```

### `POST /v1/open`

Pass the result ID to save the prompt and reply as a Deep Pink thread and open
it in the app. Repeating the request opens the same thread again.

Request:

```json
{"id":"result-id"}
```

Response:

```json
{"id":"result-id","threadId":"thread-id","opened":true}
```

## Try it with curl

Enable the web server in Settings first, then run:

```sh
WEB_SERVER_RESULT=$(curl -sS http://127.0.0.1:3789/v1/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What is the capital of France? Give one sentence."}')
printf '%s\n' "$WEB_SERVER_RESULT"
WEB_SERVER_ID=$(printf '%s' "$WEB_SERVER_RESULT" | jq -r .id)
curl -sS http://127.0.0.1:3789/v1/open \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$WEB_SERVER_ID\"}"
```

If you changed the port in Settings, replace `3789` in both URLs.

## Run in the tray

Turn on **Keep running in the tray after closing the window** to keep Deep Pink
and the listener alive when the window is closed. The tray menu can reopen the
app or quit it. With this option off, closing the last window stops the server
along with the app (or stops the listener on macOS).
