import { X509Certificate } from 'node:crypto'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

export function validateCertificate(pem: string): void {
  try {
    if (/PRIVATE KEY/.test(pem)) throw new Error('private key')
    new X509Certificate(pem)
  } catch {
    throw new Error('Invalid CA certificate. Import a PEM certificate, not a private key.')
  }
}

/** A CA belongs to this endpoint, never to the app's global HTTPS settings. */
export function serverFetch(endpoint: URL, caCertificate?: string | null): FetchLike {
  const ca = caCertificate?.trim()
  if (!ca) return (url, init) => fetch(url, { ...init, redirect: 'error' })
  if (endpoint.protocol !== 'https:') throw new Error('A CA certificate requires an HTTPS URL.')
  validateCertificate(ca)

  return async (input, init = {}) => {
    const url = new URL(input)
    if (url.origin !== endpoint.origin) {
      throw new Error('The MCP certificate can only be used with this server’s HTTPS origin.')
    }
    // The MCP transport sends JSON strings and otherwise has no request body.
    // Reject unsupported bodies rather than accidentally sending an empty one.
    if (init.body != null && typeof init.body !== 'string') {
      throw new Error('Unsupported MCP HTTP request body.')
    }
    const body = init.body
    const headers = new Headers(init.headers)
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers),
        ca,
        rejectUnauthorized: true,
        // Do not share a pooled connection with another server's trust policy.
        agent: false,
        signal: init.signal ?? undefined
      }, (response) => {
        // An SSE response can legitimately stay open without sending events.
        req.setTimeout(0)
        const responseHeaders = new Headers()
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1])
        }
        const status = response.statusCode ?? 500
        const empty = init.method === 'HEAD' || [204, 205, 304].includes(status)
        if (empty) response.resume()
        resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders
        }))
      })
      req.on('error', reject)
      req.setTimeout(30_000, () => req.destroy(new Error('MCP HTTP connection timed out.')))
      // Redirects are returned to the SDK as errors. Never forward the bearer
      // key to another origin or downgrade a connection to HTTP.
      req.end(body ?? undefined)
    })
  }
}

/** Surface useful transport/auth failures without including saved credentials. */
export function connectionError(error: unknown, headers: Record<string, string>): string {
  const codes = new Set<string>()
  let cause: unknown = error
  for (let depth = 0; cause && typeof cause === 'object' && depth < 8; depth++) {
    const item = cause as { code?: string; cause?: unknown }
    if (item.code) codes.add(String(item.code))
    cause = item.cause
  }
  let message = error instanceof Error ? error.message : String(error)
  if ([...codes].some((code) => /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))) {
    message = 'The HTTPS certificate is not trusted. Import this server’s CA certificate in its MCP settings.'
  } else if (codes.has('ERR_TLS_CERT_ALTNAME_INVALID')) {
    message = 'The HTTPS certificate does not match the URL hostname. For Obsidian, use https://127.0.0.1:27124/mcp/ rather than localhost.'
  } else if (codes.has('ECONNREFUSED')) {
    message = 'The MCP server refused the connection. Check the URL and that the local server or Obsidian plugin is running.'
  } else if (codes.has('401') || /\b401\b/.test(message)) {
    message = 'Authentication failed (401). Check the Authorization header and bearer key. Browser OAuth sign-in is not supported yet.'
  } else if (codes.has('403') || /\b403\b/.test(message)) {
    message = 'Access denied (403). Check the server’s key permissions and required authentication headers.'
  }
  for (const value of Object.values(headers)) {
    if (value) message = message.split(value).join('[redacted]')
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) message = message.split(bearer).join('[redacted]')
  }
  return message
}
