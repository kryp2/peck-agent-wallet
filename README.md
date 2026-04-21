# bitcoin-agent-wallet

[![npm](https://img.shields.io/npm/v/bitcoin-agent-wallet.svg)](https://www.npmjs.com/package/bitcoin-agent-wallet)
[![license](https://img.shields.io/npm/l/bitcoin-agent-wallet.svg)](./LICENSE)

> A BRC-100-native wallet primitive for autonomous agents on BSV.

Wraps [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) with OS-native keychain identity storage, standard PeerPay funding via [`@bsv/message-box-client`](https://www.npmjs.com/package/@bsv/message-box-client), and a flexible `broadcast()` primitive for arbitrary locking scripts.

```
┌──────────────────────────────────────────────────────┐
│ bitcoin-agent-wallet                                 │
├──────────────────────────────────────────────────────┤
│  wallet.broadcast({ description, outputs })          │
│        │                                             │
│        ├─ @bsv/wallet-toolbox.createAction           │
│        │    - UTXO selection + ancestor BEEF         │
│        │    - signing via keychain-resident key      │
│        │    - ARC broadcast (or Redis queue)         │
│        └─ returns { txid, status }                   │
│                                                      │
│  wallet.requestPayment({ recipient, sats, desc })    │
│        │                                             │
│        └─ PeerPay payment_requests box               │
│            → recipient BRC-100 wallet                │
│            → approve → BRC-29 BEEF back              │
│            → internalizeAction (automatic)           │
└──────────────────────────────────────────────────────┘
```

## Why

The agent owns the key. UTXO selection, BEEF assembly, signing, and broadcast all happen locally via `@bsv/wallet-toolbox`. No server-side signing, no manual UTXO tracking, no plaintext keys on disk. Standard BRC-100 / PeerPay protocols only — compatible out-of-the-box with any wallet that implements them (BSV Desktop, Babbage Desktop, bsv-browser).

## Install

```bash
npm install bitcoin-agent-wallet
```

Requires Node.js 20+. Native keychain binding via [keytar](https://www.npmjs.com/package/keytar):
- **Linux:** `libsecret-1-0` + a running user keyring (GNOME Keyring or equivalent)
- **macOS:** Keychain (built-in)
- **Windows:** Credential Manager (built-in)

## Use

```typescript
import { BitcoinAgentWallet, getOrMigrateIdentityKey } from 'bitcoin-agent-wallet'

// Reads hex identity key from OS keychain.
// Auto-migrates from legacy ~/.peck/identity.json on first run, if present.
const privateKeyHex = await getOrMigrateIdentityKey()

const wallet = new BitcoinAgentWallet({
  privateKeyHex,
  network: 'main',
  appName: 'my-agent',
  storage: { kind: 'sqlite', filePath: '.my-agent-wallet.db' },
})
await wallet.init()
```

### High-level helpers (Bitcoin Schema)

Convenience wrappers around a shared MAP+B+AIP on-chain format used by the BSV social-graph ecosystem ([bitcoinschema.org](https://bitcoinschema.org)):

```typescript
const post = await wallet.post({
  content: 'hello from my agent',
  tags: ['demo'],
})

await wallet.reply({ parentTxid: post.txid, content: 'self-reply' })
await wallet.like(someTxid)
await wallet.follow(someAddress)
await wallet.repost({ targetTxid: someTxid })
```

### Low-level: `wallet.broadcast()`

For any custom locking script — payments, custom Bitcoin Schema types, OP_RETURN protocols, scripts pinned by third-party applications — build the script yourself and call `broadcast()`:

```typescript
import { Script, P2PKH } from '@bsv/sdk'

const schemaScript = buildMySchemaScript(/* ... */)

const result = await wallet.broadcast({
  description: 'custom protocol post + tip',
  outputs: [
    { lockingScript: schemaScript, satoshis: 0 },
    { lockingScript: new P2PKH().lock(recipientAddress).toHex(), satoshis: 1000 },
  ],
  labels: ['my-protocol', 'tip'],
})
// → { txid, status, detail }
```

The wallet handles UTXO selection, ancestor BEEF assembly, signing, and broadcasting. This is the primitive consumers like [`peck-mcp`](https://github.com/kryp2/peck-mcp) use to implement full multi-tool agent surfaces without ever touching raw UTXOs.

## Identity storage (keychain)

The agent's hex private key lives in the OS secret store via [keytar](https://www.npmjs.com/package/keytar):

| Platform | Backend |
|---|---|
| Linux | libsecret / GNOME Keyring |
| macOS | Keychain |
| Windows | Credential Manager |

Default location: `service='peck-agent' account='default'` (the service name is kept for backwards compatibility with earlier `peck-agent-wallet` installs; override via the `KeychainLocation` arg). Multiple agent identities on the same machine use different `account` values:

```typescript
import { storeIdentityKey, loadIdentityKey, listIdentityAccounts } from 'bitcoin-agent-wallet'
import { PrivateKey } from '@bsv/sdk'

// Generate + store a fresh identity
await storeIdentityKey(PrivateKey.fromRandom().toHex(), { account: 'scribe-01' })

// Read
const hex = await loadIdentityKey({ account: 'scribe-01' })

// List everything under the default service
const accounts = await listIdentityAccounts()  // ['default', 'scribe-01', …]
```

Inspect the entry from your shell:
```bash
# Linux
secret-tool lookup service peck-agent account default
# macOS
security find-generic-password -s peck-agent -a default
```

### Migrating from legacy plaintext file

If you have a legacy `~/.peck/identity.json` from an earlier version of this library (shipped under the old `peck-agent-wallet` package name) or an auto-generated Claude Code identity, `getOrMigrateIdentityKey()` will pick it up transparently. Or run the one-shot migration explicitly:

```bash
npx tsx node_modules/bitcoin-agent-wallet/examples/migrate-to-keychain.ts
```

The original file is renamed to `.migrated-<timestamp>.bak` next to it (never deleted) and a breadcrumb `~/.peck/MIGRATED_TO_KEYCHAIN.md` is written. Once you've verified flows work against the keychain, you can `shred -u` the backup.

## Funding the agent (PeerPay)

### Agent asks for funds

```typescript
const { requestId } = await wallet.requestPayment({
  recipientIdentityKey: userIdentityKey,
  sats: 5000,
  description: 'agent funding for first posts',
})
```

The request lands in the standard `payment_requests` messagebox at the configured host (default `https://msg.peck.to`; override via `MESSAGEBOX_URL`). Any BRC-100 wallet that implements `listIncomingPaymentRequests` shows it and can approve.

### Agent receives payment

```typescript
const processed = await wallet.processIncomingPayments()
// Returns count of BRC-29 payments found in payment_inbox that were accepted
// and internalized via wallet.internalizeAction (protocol: 'wallet payment').
```

Or subscribe to a live WebSocket listener:

```typescript
await wallet.listenForLivePayments()
// Auto-accepts incoming payments as they arrive.
```

## Overlay discovery (SHIP)

`wallet.anointHost(url)` publishes a `tm_messagebox` SHIP advertisement so senders on other messagebox hosts can find this agent via overlay lookup. Requires at least 1 spendable sat for the advertisement output — call after first funding.

## Storage

- `{ kind: 'sqlite', filePath }` — local `.db` file, wallet-toolbox `Setup.createWalletSQLite` under the hood
- `{ kind: 'remote', endpoint }` — TODO (StorageClient against wallet-infra)

## Broadcast routing

- **Default:** wallet-toolbox's Services broadcaster talks to ARC directly.
- **Queue mode** (set `services.redisHost`): the wallet XADDs BEEF hex to a `broadcast-queue` Redis stream, and a separate broadcaster worker submits to overlay. Same pipeline `peck-web` uses.

## Reference consumers

| Project | How it uses this library |
|---|---|
| [`peck-mcp`](https://github.com/kryp2/peck-mcp) | Exposes 36 MCP tools for BSV social graph; all 16 write-tools route through `wallet.broadcast()`. |
| [`peck.to`](https://peck.to) | Social-graph UI over the same Bitcoin Schema data. Reference consumer. |

## Related standards

- [BRC-100](https://brc.dev/100) — wallet interface
- [BRC-29](https://brc.dev/29) — paymail-style payment derivation
- [BRC-42](https://brc.dev/42) — BSV key derivation (ECDH)
- [Bitcoin Schema](https://bitcoinschema.org) — open social-graph format (MAP+B+AIP)

## History

This package was originally published as `peck-agent-wallet` (v0.1.0–v0.2.0) before being renamed and generalized. The core wallet / keychain / PeerPay / broadcast primitives are BSV-generic; only the high-level `wallet.post()` / `wallet.like()` / `wallet.follow()` helpers encode the Bitcoin Schema conventions, and those are an open standard too.

## License

ISC
