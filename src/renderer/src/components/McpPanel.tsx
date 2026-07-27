import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'

function parseArgs(input: string): string[] {
  return input.split(/\s+/).filter(Boolean)
}

function parseEnv(input: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of input.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return env
}

function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function ServerEditor({
  config,
  status,
  onChange,
  onRemove
}: {
  config: McpServerConfig
  status: McpServerStatus | undefined
  onChange: (patch: Partial<McpServerConfig>) => void
  onRemove: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="list-card">
      <div className="spread">
        <div className="row" style={{ minWidth: 0 }}>
          <span className="dot" data-state={status?.state ?? 'disconnected'} />
          <strong>{config.name}</strong>
          <span className="chip">{config.transport}</span>
          {status?.state === 'connected' && (
            <span className="chip">
              {status.tools.length} tool{status.tools.length === 1 ? '' : 's'}
            </span>
          )}
          {status?.instructions && <span className="chip">has instructions</span>}
        </div>
        <div className="row">
          <label className="switch">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => onChange({ enabled: event.target.checked })}
            />
          </label>
          <button className="btn btn--ghost" onClick={() => setOpen((v) => !v)} type="button">
            {open ? 'Done' : 'Edit'}
          </button>
        </div>
      </div>

      {status?.error && <div className="message__error">{status.error}</div>}

      {open && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <span className="field__label">Name</span>
            <input
              className="input"
              value={config.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </div>

          <div className="field">
            <span className="field__label">Transport</span>
            <select
              className="select"
              value={config.transport}
              onChange={(event) =>
                onChange({ transport: event.target.value as McpServerConfig['transport'] })
              }
            >
              <option value="stdio">stdio (local process)</option>
              <option value="http">HTTP (streamable)</option>
            </select>
          </div>

          {config.transport === 'stdio' ? (
            <>
              <div className="field">
                <span className="field__label">Command</span>
                <input
                  className="input mono"
                  placeholder="npx"
                  value={config.command ?? ''}
                  onChange={(event) => onChange({ command: event.target.value })}
                />
              </div>
              <div className="field">
                <span className="field__label">Arguments</span>
                <input
                  className="input mono"
                  placeholder="-y @modelcontextprotocol/server-filesystem /home/you/notes"
                  defaultValue={config.args.join(' ')}
                  onBlur={(event) => onChange({ args: parseArgs(event.target.value) })}
                />
              </div>
              <div className="field">
                <span className="field__label">Working directory</span>
                <input
                  className="input mono"
                  placeholder="(optional)"
                  value={config.cwd ?? ''}
                  onChange={(event) => onChange({ cwd: event.target.value || null })}
                />
              </div>
              <div className="field">
                <span className="field__label">Environment</span>
                <textarea
                  className="textarea mono"
                  rows={3}
                  placeholder={'KEY=value\nANOTHER=value'}
                  defaultValue={stringifyEnv(config.env)}
                  onBlur={(event) => onChange({ env: parseEnv(event.target.value) })}
                />
                <span className="field__hint">
                  One per line. These are stored in your local database in plain text.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <span className="field__label">URL</span>
                <input
                  className="input mono"
                  placeholder="https://example.com/mcp"
                  value={config.url ?? ''}
                  onChange={(event) => onChange({ url: event.target.value })}
                />
              </div>
              <div className="field">
                <span className="field__label">Headers</span>
                <textarea
                  className="textarea mono"
                  rows={2}
                  placeholder="Authorization=Bearer …"
                  defaultValue={stringifyEnv(config.headers)}
                  onBlur={(event) => onChange({ headers: parseEnv(event.target.value) })}
                />
              </div>
            </>
          )}

          <label className="switch" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={config.requireApproval}
              onChange={(event) => onChange({ requireApproval: event.target.checked })}
            />
            <span>
              Ask before every tool call
              <span className="field__hint">
                Recommended. MCP tools can read files and reach the network.
              </span>
            </span>
          </label>

          <label className="switch" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={config.injectInstructions}
              onChange={(event) => onChange({ injectInstructions: event.target.checked })}
            />
            <span>
              Add this server's instructions to the system prompt
              <span className="field__hint">
                Off by default. Read them below first — they become part of every request in
                threads where this server is active.
              </span>
            </span>
          </label>

          {status?.instructions && (
            <details className="disclosure">
              <summary className="disclosure__summary">
                Instructions this server wants to inject
              </summary>
              <div className="disclosure__content">
                <pre>{status.instructions}</pre>
              </div>
            </details>
          )}

          {status?.tools.length ? (
            <>
              <div className="section-title">Tools</div>
              {status.tools.map((tool) => (
                <label className="switch" key={tool.name} style={{ marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={(event) => {
                      const disabled = new Set(config.disabledTools)
                      if (event.target.checked) disabled.delete(tool.name)
                      else disabled.add(tool.name)
                      onChange({ disabledTools: [...disabled] })
                    }}
                  />
                  <span>
                    <span className="mono">{tool.name}</span>
                    <span className="field__hint">{tool.description || 'No description.'}</span>
                  </span>
                </label>
              ))}
            </>
          ) : null}

          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn"
              onClick={() => void window.deepPink.mcp.connect(config.id)}
              type="button"
            >
              Reconnect
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn btn--danger" onClick={onRemove} type="button">
              Remove server
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function McpPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const statuses = useStore((s) => s.mcpStatuses)
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const updateThread = useStore((s) => s.updateThread)
  const [configs, setConfigs] = useState<McpServerConfig[]>([])

  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  const reload = async (): Promise<void> => {
    setConfigs(await window.deepPink.mcp.configs())
  }

  useEffect(() => {
    void reload()
  }, [statuses])

  const update = async (id: string, patch: Partial<McpServerConfig>): Promise<void> => {
    await window.deepPink.mcp.update(id, patch)
    await reload()
  }

  const activeForThread = thread?.config.enabledMcpServers

  const toggleForThread = async (serverId: string): Promise<void> => {
    if (!thread) return
    const current = activeForThread ?? configs.filter((c) => c.enabled).map((c) => c.id)
    const next = current.includes(serverId)
      ? current.filter((id) => id !== serverId)
      : [...current, serverId]
    await updateThread(thread.id, { config: { enabledMcpServers: next } })
  }

  return (
    <Overlay
      title="MCP servers"
      onClose={onClose}
      wide
      footer={
        <>
          <span>Servers run on your machine or at a URL you choose. Nothing is proxied.</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn--primary"
            onClick={async () => {
              await window.deepPink.mcp.create({ name: 'New server' })
              await reload()
            }}
            type="button"
          >
            Add server
          </button>
        </>
      }
    >
      <div className="panel__body">
        {configs.length === 0 && (
          <div className="empty" style={{ height: 180 }}>
            <div className="empty__title">No MCP servers yet</div>
            <p>
              Add one to give the model tools — a filesystem, a database, your notes. Tools stay
              off until you enable the server.
            </p>
          </div>
        )}

        {configs.map((config) => (
          <ServerEditor
            key={config.id}
            config={config}
            status={statuses.find((s) => s.id === config.id)}
            onChange={(patch) => void update(config.id, patch)}
            onRemove={async () => {
              await window.deepPink.mcp.remove(config.id)
              await reload()
            }}
          />
        ))}

        {thread && configs.length > 0 && (
          <>
            <div className="section-title">Active in this thread</div>
            <p className="field__hint" style={{ marginBottom: 10 }}>
              By default every enabled server is available. Narrow it here to keep a thread's
              context small.
            </p>
            {configs
              .filter((config) => config.enabled)
              .map((config) => (
                <label className="switch" key={config.id} style={{ marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={activeForThread === null ? true : activeForThread?.includes(config.id) ?? true}
                    onChange={() => void toggleForThread(config.id)}
                  />
                  <span>{config.name}</span>
                </label>
              ))}
          </>
        )}
      </div>
    </Overlay>
  )
}
