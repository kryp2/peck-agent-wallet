/**
 * OS-native secret storage for agent identity keys.
 *
 * Replaces plaintext ~/.peck/identity.json with libsecret (Linux), Keychain
 * (macOS) and Credential Manager (Windows) via `keytar`.
 *
 * The key is still a raw hex private key — keytar just wraps it in an OS
 * mechanism that requires process-level permission / user-session unlock
 * to read. This is the minimum bar for a wallet secret on disk.
 *
 * Service identifier defaults to 'peck-agent'. Supply `account` to namespace
 * multiple agent identities on the same machine ('default', 'scribe-01', …).
 */
import { readFileSync, existsSync, renameSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import keytar from 'keytar'

const DEFAULT_SERVICE = 'peck-agent'
const DEFAULT_ACCOUNT = 'default'

const LEGACY_PECK_IDENTITY_PATH = join(homedir(), '.peck', 'identity.json')

export interface KeychainLocation {
  service?: string
  account?: string
}

/**
 * Read the hex private key for an agent identity from the OS keychain.
 * Returns null if not stored.
 */
export async function loadIdentityKey(loc: KeychainLocation = {}): Promise<string | null> {
  const service = loc.service || DEFAULT_SERVICE
  const account = loc.account || DEFAULT_ACCOUNT
  return await keytar.getPassword(service, account)
}

/**
 * Store a hex private key for an agent identity in the OS keychain.
 * Overwrites any previous value at the same service/account.
 */
export async function storeIdentityKey(
  privateKeyHex: string,
  loc: KeychainLocation = {},
): Promise<void> {
  const service = loc.service || DEFAULT_SERVICE
  const account = loc.account || DEFAULT_ACCOUNT
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error(`Invalid private key hex — expected 64 hex chars, got ${privateKeyHex.length}`)
  }
  await keytar.setPassword(service, account, privateKeyHex.toLowerCase())
}

/**
 * Remove an agent identity from the OS keychain.
 * Returns true if something was deleted.
 */
export async function deleteIdentityKey(loc: KeychainLocation = {}): Promise<boolean> {
  const service = loc.service || DEFAULT_SERVICE
  const account = loc.account || DEFAULT_ACCOUNT
  return await keytar.deletePassword(service, account)
}

/**
 * List all accounts under a given service — useful for enumerating agent
 * identities stored on this machine.
 */
export async function listIdentityAccounts(service = DEFAULT_SERVICE): Promise<string[]> {
  const entries = await keytar.findCredentials(service)
  return entries.map(e => e.account)
}

/**
 * Migrate an existing ~/.peck/identity.json into the keychain under
 * service=peck-agent account=default (unless overridden).
 *
 * The original file is NOT deleted — instead it's renamed to
 * ~/.peck/identity.json.migrated-<timestamp>.bak so the user can verify
 * the keychain entry works before destroying the plaintext copy.
 *
 * Returns the imported identityKey prefix (first 20 hex chars) for logging.
 * No-op (returns null) if JSON doesn't exist or already migrated.
 */
export async function migrateFromPeckIdentityJson(
  loc: KeychainLocation = {},
): Promise<{ importedHexPrefix: string; backupPath: string } | null> {
  if (!existsSync(LEGACY_PECK_IDENTITY_PATH)) return null

  // If keychain already populated at this location, don't clobber — the JSON
  // might be stale. Caller should delete it manually if they want to re-migrate.
  const existing = await loadIdentityKey(loc)
  if (existing) return null

  const raw = readFileSync(LEGACY_PECK_IDENTITY_PATH, 'utf-8')
  const parsed = JSON.parse(raw)
  const hex = parsed.privateKeyHex
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`~/.peck/identity.json has no valid privateKeyHex`)
  }

  await storeIdentityKey(hex, loc)

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${LEGACY_PECK_IDENTITY_PATH}.migrated-${ts}.bak`
  renameSync(LEGACY_PECK_IDENTITY_PATH, backupPath)

  return { importedHexPrefix: hex.slice(0, 20), backupPath }
}

/**
 * One-stop helper: try keychain first, fall back to legacy JSON + auto-migrate.
 * Returns the hex private key to pass into PeckAgentWallet config.
 *
 * Throws if neither keychain nor legacy JSON has anything — caller should
 * then generate a fresh key via `storeIdentityKey(PrivateKey.fromRandom().toHex())`.
 */
export async function getOrMigrateIdentityKey(loc: KeychainLocation = {}): Promise<string> {
  const fromChain = await loadIdentityKey(loc)
  if (fromChain) return fromChain

  const migrated = await migrateFromPeckIdentityJson(loc)
  if (migrated) {
    const k = await loadIdentityKey(loc)
    if (k) return k
  }

  throw new Error(
    `No identity key found in keychain (service=${loc.service || DEFAULT_SERVICE}, ` +
    `account=${loc.account || DEFAULT_ACCOUNT}) and no ~/.peck/identity.json to migrate. ` +
    `Call storeIdentityKey() with a freshly generated PrivateKey.`
  )
}

/**
 * Write the post-migration backup path to a small breadcrumb file so the
 * user can find it easily.
 */
export function writeMigrationBreadcrumb(backupPath: string): void {
  const dir = join(homedir(), '.peck')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const breadcrumbPath = join(dir, 'MIGRATED_TO_KEYCHAIN.md')
  const content =
`# Peck identity migrated to OS keychain

Your agent identity key was moved from plaintext \`~/.peck/identity.json\`
into your OS keychain (libsecret / Keychain / Credential Manager).

**Backup of original plaintext file:**
\`${backupPath}\`

If you verify agent flows work after migration, you can delete that backup:
\`\`\`
shred -u "${backupPath}"    # Linux — overwrite before unlink
rm -P "${backupPath}"       # macOS
\`\`\`

**To inspect the keychain entry (requires a running user session):**
\`\`\`
secret-tool lookup service peck-agent account default   # Linux
security find-generic-password -s peck-agent -a default # macOS
\`\`\`

Managed by \`peck-agent-wallet/src/keychain.ts\`.
`
  writeFileSync(breadcrumbPath, content, 'utf-8')
}
