/**
 * One-shot migration of ~/.peck/identity.json into the OS keychain.
 *
 *   npx tsx examples/migrate-to-keychain.ts
 *
 * Safe: the original file is renamed to ~/.peck/identity.json.migrated-<ts>.bak
 * and a breadcrumb MIGRATED_TO_KEYCHAIN.md is dropped in ~/.peck/ pointing to it.
 *
 * Re-runnable: if the keychain already has an entry, nothing is touched.
 */
import {
  loadIdentityKey,
  migrateFromPeckIdentityJson,
  writeMigrationBreadcrumb,
} from '../src/index.js'

async function main() {
  const existing = await loadIdentityKey()
  if (existing) {
    console.log(`✓ Already in keychain. prefix=${existing.slice(0, 16)}…`)
    console.log(`  (nothing to migrate — call deleteIdentityKey() first if you want to re-import)`)
    return
  }

  const result = await migrateFromPeckIdentityJson()
  if (!result) {
    console.log(`ℹ  Nothing to migrate — no ~/.peck/identity.json found.`)
    console.log(`  Generate a fresh identity with storeIdentityKey(PrivateKey.fromRandom().toHex()).`)
    return
  }

  writeMigrationBreadcrumb(result.backupPath)
  console.log(`✓ Migrated identity to keychain (service=peck-agent account=default)`)
  console.log(`  key prefix: ${result.importedHexPrefix}…`)
  console.log(`  backup: ${result.backupPath}`)
  console.log(`  breadcrumb: ~/.peck/MIGRATED_TO_KEYCHAIN.md`)
  console.log()
  console.log(`Next: run examples/check-inbox.ts or examples/smoke.ts to verify keychain read works.`)
  console.log(`Then when you're confident: shred -u "${result.backupPath}"`)
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
