import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

/**
 * The cryptography sync is built on.
 *
 * ## What the server is allowed to know
 *
 * Nothing but sizes and timing. Every object's body is encrypted here before it
 * leaves the machine, and every object's *name* is a keyed hash rather than an
 * id, so a bucket full of conversations reveals neither what they say nor how
 * many threads there are, who they are with, or which of them changed today.
 * Whoever holds the bucket — a provider, someone who took the credentials —
 * holds ciphertext and nothing else.
 *
 * ## Why this is quantum-proof
 *
 * Because there is no public-key cryptography in it. The threat a quantum
 * computer poses is to the hard problems key exchange and signatures rest on —
 * factoring and discrete logs — and this design has neither: the key is
 * generated on one machine and carried to the others by the person who owns
 * them. What is left is symmetric, where the best known quantum attack is
 * Grover's, which square-roots the search space. A 256-bit key therefore keeps
 * 128 bits of security against an adversary with a quantum computer, and 128
 * bits is out of reach of anything physics currently allows.
 *
 * So: AES-256-GCM, keys derived per object with HKDF-SHA-256, names derived
 * with HMAC-SHA-256, and one 256-bit secret behind all of it.
 *
 * Pure and dependency-free, so it can be tested for the properties it claims.
 */

/** Length of the master key. 256 bits is the whole quantum-resistance story. */
export const KEY_BYTES = 32

/** Marks a sealed object, so a wrong file fails loudly instead of as garbage. */
const MAGIC = Buffer.from('DPSYNC1\0', 'utf8')

const SALT_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * Domains, so one key can safely do several jobs.
 *
 * A key used for two purposes is one purpose away from a hole; every derivation
 * below is bound to the string that says what it is for, and object encryption
 * is bound to the object's own name as well, so a sealed record cannot be moved
 * to another name and still open.
 */
const NAME_DOMAIN = 'deep-pink/sync/name/v1'
const CONTENT_DOMAIN = 'deep-pink/sync/content/v1'
const CHECK_DOMAIN = 'deep-pink/sync/key-check/v1'

/* ------------------------------------------------------------------ *
 * The key, as a person has to handle it
 * ------------------------------------------------------------------ */

/**
 * Crockford's base 32: no I, L, O or U, so nothing in a written-down key can be
 * confused with a digit and no accident of the alphabet can spell a word.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const PREFIX = 'DPSK1'

function toBase32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function fromBase32(text: string): Buffer | null {
  let bits = 0
  let value = 0
  const out: number[] = []

  for (const character of text) {
    const index = ALPHABET.indexOf(character)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Four characters of checksum, so a mistyped key is refused rather than tried. */
function checksum(key: Buffer): string {
  return toBase32(createHmac('sha256', key).update(CHECK_DOMAIN).digest().subarray(0, 3)).slice(0, 4)
}

/** A new key. The only copy: nothing else on earth has it after this returns. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/**
 * The key as something a person can carry between machines — read off a screen,
 * typed into another window, or kept in a password manager.
 */
export function formatKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('A sync key is 32 bytes')
  const body = `${toBase32(key)}${checksum(key)}`
  const groups = body.match(/.{1,5}/g) ?? []
  return `${PREFIX}-${groups.join('-')}`
}

/**
 * Reads a key back. Case and grouping are forgiven — what is not forgiven is a
 * key that fails its checksum, because a key that is nearly right decrypts
 * nothing and would otherwise look like the server having lost the data.
 */
export function parseKey(text: string): Buffer | null {
  const cleaned = text.trim().toUpperCase().replace(/[\s-]/g, '')
  const body = cleaned.startsWith(PREFIX) ? cleaned.slice(PREFIX.length) : cleaned
  if (body.length < 8) return null

  const bytes = fromBase32(body.slice(0, -4))
  const given = body.slice(-4)
  if (!bytes || bytes.length < KEY_BYTES) return null

  const key = bytes.subarray(0, KEY_BYTES)
  return checksum(key) === given ? key : null
}

/**
 * A short fingerprint of a key, for showing that two machines hold the same one
 * without showing the key. Derived, so it gives nothing away.
 */
export function keyFingerprint(key: Buffer): string {
  const digest = createHmac('sha256', key).update('deep-pink/sync/fingerprint/v1').digest()
  return toBase32(digest.subarray(0, 5)).slice(0, 8).replace(/(.{4})/, '$1-')
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

/**
 * The name an object is stored under.
 *
 * Deterministic, so the same logical thing lands in the same place every time
 * and can be found again without an index; keyed, so the name says nothing to
 * anyone without the key. Without this a bucket listing would be a list of
 * every thread id and every device that has ever synced.
 */
export function objectName(key: Buffer, logical: string): string {
  return createHmac('sha256', hkdfKey(key, NAME_DOMAIN, Buffer.alloc(0)))
    .update(logical)
    .digest('hex')
}

function hkdfKey(key: Buffer, domain: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(domain, 'utf8'), KEY_BYTES))
}

/* ------------------------------------------------------------------ *
 * Sealing
 * ------------------------------------------------------------------ */

/**
 * Encrypts one object.
 *
 * Every object gets its own key, derived from a fresh 32-byte salt, so the
 * master key is never used to encrypt anything directly and no number of
 * objects can exhaust the nonce space of any one key. The object's name is
 * mixed into the derivation and authenticated alongside the ciphertext: a
 * sealed record moved to a different name will not open, so nobody can swap
 * yesterday's thread into today's slot without the key.
 */
export function seal(key: Buffer, name: string, plaintext: Buffer): Buffer {
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const derived = hkdfKey(key, CONTENT_DOMAIN, salt)

  const cipher = createCipheriv('aes-256-gcm', derived, nonce)
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name, 'utf8')]))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), body])
}

/**
 * Decrypts one object, or returns null.
 *
 * Null for every kind of failure there is — a foreign file, a corrupted one, a
 * tampered one, the wrong key — because the caller can do nothing different
 * about any of them, and telling them apart is how padding oracles are born.
 */
export function open(key: Buffer, name: string, sealed: Buffer): Buffer | null {
  const header = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES
  if (sealed.length < header) return null
  if (!timingSafeEqual(sealed.subarray(0, MAGIC.length), MAGIC)) return null

  let at = MAGIC.length
  const salt = sealed.subarray(at, (at += SALT_BYTES))
  const nonce = sealed.subarray(at, (at += NONCE_BYTES))
  const tag = sealed.subarray(at, (at += TAG_BYTES))
  const body = sealed.subarray(at)

  try {
    const decipher = createDecipheriv('aes-256-gcm', hkdfKey(key, CONTENT_DOMAIN, salt), nonce)
    decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name, 'utf8')]))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return null
  }
}

/** JSON in, sealed bytes out. */
export function sealJson(key: Buffer, name: string, value: unknown): Buffer {
  return seal(key, name, Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Sealed bytes in, JSON out — null if it will not open or will not parse. */
export function openJson<T>(key: Buffer, name: string, sealed: Buffer): T | null {
  const plain = open(key, name, sealed)
  if (!plain) return null
  try {
    return JSON.parse(plain.toString('utf8')) as T
  } catch {
    return null
  }
}
