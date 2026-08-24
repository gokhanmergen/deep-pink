import { createHash, createHmac } from 'node:crypto'

/**
 * A very small S3 client: four verbs, signed by hand.
 *
 * The AWS SDK is several megabytes to do GET, PUT, DELETE and LIST against one
 * bucket, and it would arrive with its own credential resolution — environment
 * variables, instance metadata, profiles on disk — none of which this app wants
 * to be reaching for. Signature Version 4 is a specification you can read in an
 * afternoon and test against published vectors, so it is written out here.
 *
 * Anything that speaks S3 works: AWS, Cloudflare R2, Backblaze B2, Wasabi,
 * MinIO on a machine in the next room. The server is never trusted with
 * anything but ciphertext, so which one it is matters less than usual.
 */

export interface S3Config {
  /** Empty for AWS itself; a full origin for anything else. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Everything this app writes lives under here. */
  prefix: string
}

export interface S3Object {
  key: string
  size: number
  lastModified: number
}

/** Injected so the tests can answer without a network. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const SERVICE = 's3'

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Percent-encoding as S3 wants it, which is not what `encodeURIComponent` does:
 * the slashes in a key have to survive in the path and `!'()*` have to be
 * escaped. Getting this wrong shows up as a signature mismatch, never as a
 * wrong path, which is why it is its own function.
 */
function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/')
}

function stamps(now: Date): { amzDate: string; day: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, day: amzDate.slice(0, 8) }
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
  /**
   * The canonical request the signature was computed over. Returned because it
   * is the only way to see what was actually signed: a mismatch here reaches
   * the user as an unexplained 403, so the tests assert on it directly.
   */
  canonical: string
}

/**
 * Signs one request.
 *
 * Exported for its own sake: this is the part with no forgiving failure mode,
 * so it is checked against Amazon's published test vector rather than against
 * "it seemed to work against a bucket once".
 */
export function sign(
  config: S3Config,
  method: string,
  /** The origin the request goes to, e.g. `https://bucket.s3.eu-west-1.amazonaws.com`. */
  base: string,
  path: string,
  query: Record<string, string>,
  payloadHash: string,
  now: Date,
  extraHeaders: Record<string, string> = {}
): SignedRequest {
  const { amzDate, day } = stamps(now)
  const origin = new URL(base)
  const host = origin.host

  /*
   * The canonical URI is the whole path of the request, and for a
   * path-style endpoint that includes the bucket. Signing only the key —
   * which is what this did at first — produces a signature the server cannot
   * reproduce, and every request to R2, MinIO or B2 comes back 403.
   */
  const fullPath = `${origin.pathname.replace(/\/+$/, '')}${path}`

  const headers: Record<string, string> = {
    ...extraHeaders,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  }

  // Signed headers are sorted, lower-cased and trimmed; the canonical request
  // is byte-for-byte or the signature is wrong.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name] ?? findHeader(headers, name)).trim()}\n`)
    .join('')

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(query[name])}`)
    .join('&')

  const canonicalRequest = [
    method,
    encodePath(fullPath),
    canonicalQuery,
    canonicalHeaders,
    names.join(';'),
    payloadHash
  ].join('\n')

  const scope = `${day}/${config.region}/${SERVICE}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), SERVICE),
    'aws4_request'
  )
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex')

  return {
    canonical: canonicalRequest,
    url: `${origin.origin}${encodePath(fullPath)}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(';')}, Signature=${signature}`
    }
  }
}

function findHeader(headers: Record<string, string>, lower: string): string {
  const match = Object.keys(headers).find((name) => name.toLowerCase() === lower)
  return match ? headers[match] : ''
}

/**
 * Where the bucket lives.
 *
 * AWS puts the bucket in the hostname; everything else — R2, MinIO, a bucket
 * whose name has a dot in it and therefore breaks TLS as a subdomain — is
 * addressed with the bucket as the first path segment.
 */
export function origin(config: S3Config): string {
  if (!config.endpoint) return `https://${config.bucket}.s3.${config.region}.amazonaws.com`
  const base = config.endpoint.replace(/\/+$/, '')
  return `${base}/${config.bucket}`
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

export class S3Client {
  constructor(
    private readonly config: S3Config,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** Everything this app owns sits under the configured prefix. */
  private full(key: string): string {
    const prefix = this.config.prefix.replace(/^\/+|\/+$/g, '')
    return `/${prefix ? `${prefix}/` : ''}${key}`
  }

  private async send(
    method: string,
    /** An object key, or null for the bucket itself — which is where a listing goes. */
    key: string | null,
    query: Record<string, string>,
    body?: Buffer
  ): Promise<Response> {
    const path = key === null ? '/' : this.full(key)
    const payloadHash = body ? sha256(body) : sha256('')
    const signed = sign(
      this.config,
      method,
      origin(this.config),
      path,
      query,
      payloadHash,
      this.clock()
    )

    const response = await this.fetcher(signed.url, {
      method,
      headers: signed.headers,
      body: body ? new Uint8Array(body) : undefined
    })

    return response
  }

  /** The object's bytes, or null if it is not there. */
  async get(key: string): Promise<Buffer | null> {
    const response = await this.send('GET', key, {})
    if (response.status === 404) return null
    if (!response.ok) throw await asError(response, `Could not read ${key}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async put(key: string, body: Buffer): Promise<void> {
    const response = await this.send('PUT', key, {}, body)
    if (!response.ok) throw await asError(response, `Could not write ${key}`)
  }

  async remove(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {})
    // A delete of something already gone is a success, not a problem.
    if (!response.ok && response.status !== 404) {
      throw await asError(response, `Could not delete ${key}`)
    }
  }

  /**
   * Every object under a prefix, following continuation tokens.
   *
   * Names are opaque hashes, so this is the only way to find what other devices
   * have written — there is nothing to guess and nothing to enumerate by id.
   */
  async list(prefix: string): Promise<S3Object[]> {
    const under = this.full(prefix).slice(1)
    const out: S3Object[] = []
    let token: string | undefined

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: under, 'max-keys': '1000' }
      if (token) query['continuation-token'] = token

      // Addressed to the bucket, not to the prefix: ListObjectsV2 is a query on
      // the bucket root, and the prefix is one of its parameters.
      const response = await this.send('GET', null, query)
      if (!response.ok) throw await asError(response, 'Could not list the bucket')

      const xml = await response.text()
      for (const chunk of xml.split('<Contents>').slice(1)) {
        const key = between(chunk, 'Key')
        if (!key) continue
        out.push({
          key,
          size: Number(between(chunk, 'Size') ?? 0),
          lastModified: Date.parse(between(chunk, 'LastModified') ?? '') || 0
        })
      }

      token =
        between(xml, 'IsTruncated') === 'true'
          ? (between(xml, 'NextContinuationToken') ?? undefined)
          : undefined
    } while (token)

    return out
  }

  /**
   * Writes an object, reads it back and removes it again, as a way to prove the
   * settings are right before anything real depends on them.
   *
   * The name and the body come from the caller because both are derived from
   * the encryption key: a probe called "connection-check" would be the one
   * object in the bucket that said what this is.
   */
  async check(name: string, body: Buffer): Promise<void> {
    await this.put(name, body)
    const back = await this.get(name)
    if (!back || !back.equals(body)) {
      throw new S3Error('The bucket did not return what was just written to it', 0)
    }
    await this.remove(name)
  }
}

/**
 * Pulls a value out of the list response.
 *
 * S3 answers in XML and this needs four fields from it; a parser dependency for
 * that would be more code than the thing it parses. Every value read here is a
 * key, a size or a date generated by the server, and none of it is trusted for
 * anything beyond addressing an object whose contents must still decrypt.
 */
function between(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)
  return match ? match[1] : null
}

async function asError(response: Response, context: string): Promise<S3Error> {
  let detail = ''
  try {
    const body = await response.text()
    detail = between(body, 'Message') ?? between(body, 'Code') ?? ''
  } catch {
    /* a response with no readable body still has its status */
  }
  return new S3Error(`${context} (HTTP ${response.status}${detail ? `: ${detail}` : ''})`, response.status)
}
