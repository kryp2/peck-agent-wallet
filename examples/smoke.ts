/**
 * Smoke-test for PeckAgentWallet — BRC-100 native flow.
 *
 * Kjør:
 *   npx tsx examples/smoke.ts
 *
 * 1. Scripten initialiserer wallet, printer agentens identity key
 * 2. Den venter til en BRC-29-payment dukker opp i inbox
 * 3. Du åpner din BRC-100-wallet, Send → Recipient = printed identity key → Amount (feks 5000 sat) → Send
 * 4. Agenten plukker opp, internaliserer, poster til peck.to
 */
import { homedir } from 'os'
import { join } from 'path'
import { PeckAgentWallet, getOrMigrateIdentityKey } from '../src/index.js'

async function main() {
  const privateKeyHex = await getOrMigrateIdentityKey()

  const wallet = new PeckAgentWallet({
    privateKeyHex,
    network: 'main',
    appName: 'peck-agent-wallet-smoke',
    storage: {
      kind: 'sqlite',
      filePath: join(homedir(), '.peck-agent-wallet.db'),
    },
  })

  console.log('Initializing wallet...')
  await wallet.init()
  console.log(`\n📬 Agent identity key (send payment to this):`)
  console.log(`   ${wallet.getIdentityKey()}`)
  console.log(`📬 Agent address: ${wallet.getAddress()}`)

  // Poll for payments. I wallet-app: Send → paste identity key → f.eks. 5000 sat → Send.
  console.log(`\n⏳ Waiting for BRC-29 payment via msg.peck.to...`)
  console.log(`   (open your BRC-100 wallet and send ~5000 sat to the identity key above)`)
  let attempts = 0
  while (attempts < 60) {
    const processed = await wallet.processIncomingPayments()
    if (processed > 0) {
      console.log(`✓ Accepted ${processed} payment(s).`)
      break
    }
    await new Promise(r => setTimeout(r, 3000))
    attempts++
    if (attempts % 5 === 0) console.log(`   ... ${attempts * 3}s elapsed`)
  }

  if (attempts >= 60) {
    console.error('⏱ Timeout — no payment received in 180s. Abort.')
    await wallet.close()
    process.exit(1)
  }

  console.log('\n📝 Posting test message to peck.to...')
  const result = await wallet.post({
    content: `PeckAgentWallet smoke-test ${new Date().toISOString()} — BRC-100 native, full BEEF via wallet-toolbox, funded via PeerPay + msg.peck.to. No P2PKH shortcuts.`,
    tags: ['smoke-test', 'peck-agent-wallet', 'brc-100'],
  })
  console.log('Broadcast result:', result)
  console.log(`View: https://peck.to/tx/${result.txid}`)

  await wallet.close()
}

main().catch(err => {
  console.error('Smoke-test failed:', err)
  process.exit(1)
})
