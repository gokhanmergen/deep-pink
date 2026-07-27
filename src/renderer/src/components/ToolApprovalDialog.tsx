import { useStore } from '../store'
import { Overlay } from './Overlay'

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2)
  } catch {
    return raw
  }
}

/** Nothing runs on the user's machine without this being answered. */
export function ToolApprovalDialog(): React.JSX.Element | null {
  const pending = useStore((s) => s.pendingApproval)
  const approveTool = useStore((s) => s.approveTool)

  if (!pending) return null

  return (
    <Overlay
      title="Allow this tool call?"
      onClose={() => void approveTool(false)}
      center
      footer={
        <>
          <span>You can turn per-call approval off for a server in the MCP panel.</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => void approveTool(false)} type="button">
            Deny
          </button>
          <button className="btn btn--primary" onClick={() => void approveTool(true)} type="button">
            Allow
          </button>
        </>
      }
    >
      <div className="panel__body">
        <p className="muted">
          <strong>{pending.serverName}</strong> wants to run{' '}
          <span className="mono">{pending.toolCall.name}</span>.
        </p>
        <div className="section-title">Arguments</div>
        <div className="codeblock">
          <pre>
            <code>{prettyArgs(pending.toolCall.arguments)}</code>
          </pre>
        </div>
      </div>
    </Overlay>
  )
}
