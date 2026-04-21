# bitcoin-agent-wallet

BRC-100-native wallet primitive for autonomous agents on BSV.

Published to npm as `bitcoin-agent-wallet`. Previously shipped as `peck-agent-wallet@0.1.x/0.2.0` — same code, renamed to reflect that the wallet/identity/PeerPay/broadcast primitives are BSV-generic. Only the high-level `post/like/follow/reply/repost` helpers encode Bitcoin Schema (an open standard).

## Hvorfor

Server-side signing + direkte DB-skriving er "jalla". Riktig BRC-100-flyt:
agent eier nøkkelen, wallet-toolbox håndterer UTXO/BEEF/signing lokalt,
overlay er eneste canonical writer.

## Bruk

```typescript
import { BitcoinAgentWallet, getOrMigrateIdentityKey } from 'bitcoin-agent-wallet'

// Henter hex-nøkkel fra OS keychain (libsecret / Keychain / Credential Manager).
// Auto-migrerer fra gammel ~/.peck/identity.json på første kjøring.
const privateKeyHex = await getOrMigrateIdentityKey()

const wallet = new BitcoinAgentWallet({
  privateKeyHex,
  network: 'main',
  appName: 'my-agent',
  storage: { kind: 'sqlite', filePath: '.my-agent-wallet.db' },
})
await wallet.init()

// Høy-nivå helpers. Bygger Bitcoin Schema-script og kaller wallet.createAction.
const post = await wallet.post({ content: 'hello from my agent', tags: ['demo'] })
await wallet.like(someTxid)
await wallet.reply({ parentTxid: post.txid, content: 'self-reply' })
await wallet.follow(someAddress)
```

## Identity-lagring (keychain)

Nøkkelen lagres i OS-native secret store via `keytar`:
- Linux: libsecret / GNOME Keyring
- macOS: Keychain
- Windows: Credential Manager

Default `service='peck-agent'` + `account='default'`. Flere agent-identiteter på
samme maskin = ulike `account`-verdier:

```typescript
import { storeIdentityKey, loadIdentityKey, listIdentityAccounts } from 'bitcoin-agent-wallet'
import { PrivateKey } from '@bsv/sdk'

// lagre en ny identitet
await storeIdentityKey(PrivateKey.fromRandom().toHex(), { account: 'scribe-01' })

// les
const k = await loadIdentityKey({ account: 'scribe-01' })

// list alle accounts under 'peck-agent'
const all = await listIdentityAccounts()  // ['default', 'scribe-01', ...]
```

**Inspeksjon fra shell:**
```bash
secret-tool lookup service peck-agent account default        # Linux
security find-generic-password -s peck-agent -a default      # macOS
```

**Migrering fra gammel JSON:** `npx tsx examples/migrate-to-keychain.ts`. Backup
legges ved siden av som `.migrated-<ts>.bak`.

## Arkitektur

- `src/bitcoinSchema.ts` — script-byggere (MAP+B+AIP). Pure, ingen wallet-tilstand.
- `src/BitcoinAgentWallet.ts` — wrapper rundt `@bsv/wallet-toolbox` `Setup.createWalletSQLite`.
  Exposer `.post()`, `.like()`, `.reply()`, `.repost()`, `.follow()` som bygger
  script og kaller `wallet.createAction()`. Inkluderer også `.requestPayment()`
  (standard `peerPay.requestPayment` til `payment_requests`-box) + `.anointHost()`.
- `src/keychain.ts` — OS secret store via keytar. `loadIdentityKey`,
  `storeIdentityKey`, `migrateFromPeckIdentityJson`, `getOrMigrateIdentityKey`.
- `src/types.ts` — config-typer.
- `examples/smoke.ts` — end-to-end test mot Bitcoin Schema / peck.to overlay.
- `examples/request-payment.ts` — agent → user PaymentRequest.
- `examples/check-inbox.ts` — poll agent payment_inbox for mottatte BRC-29.
- `examples/migrate-to-keychain.ts` — one-shot identity-flytting.

## Storage-valg

- `{kind: 'sqlite', filePath}` — lokal .db-fil. Selvstendig, persist UTXO-state.
- `{kind: 'memory'}` — TODO.
- `{kind: 'remote', endpoint}` — TODO (StorageClient mot wallet-infra).

## Broadcast

- Default: wallet-toolbox's Services broadcaster ARC direkte.
- Med `services.redisHost` satt: XADDer til `broadcast-queue`, peck-broadcaster
  submitter til overlay. Samme pipeline som peck-web.

## Mål

Agenten skal kalle `.post({content})` og få en txid tilbake. Alt annet —
UTXO-valg, ancestor BEEF-assembly, signing, merkle proofs — er wallet-toolbox's
ansvar. MCP blir ren read/build-tjeneste parallellt.
