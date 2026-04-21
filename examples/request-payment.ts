/**
 * Proof-of-life: agent sender PaymentRequest til user's BRC-100-wallet via
 * standard @bsv/message-box-client payment_requests-box. Du skal se den i
 * BSV Desktop / Babbage-wallet som "incoming payment request".
 */
import { homedir } from 'os'
import { join } from 'path'
import { BitcoinAgentWallet, getOrMigrateIdentityKey } from '../src/index.js'

const USER_IDENTITY_KEY = '0347485617d85799087719b8ccd27dacdde395160f628d9dd69ea3176d724848fd'

async function main() {
  const privateKeyHex = await getOrMigrateIdentityKey()

  const wallet = new BitcoinAgentWallet({
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
  console.log(`📬 Agent identity: ${wallet.getIdentityKey()}`)
  console.log(`🎯 Target user:    ${USER_IDENTITY_KEY}`)

  console.log(`\n📤 Sending PaymentRequest (standard payment_requests-box) ...`)
  const res = await wallet.requestPayment({
    recipientIdentityKey: USER_IDENTITY_KEY,
    sats: 5000,
    description: 'peck-agent-wallet smoke-test — standard BRC-100 request',
  })
  console.log(`✓ Sent. requestId=${res.requestId}`)
  console.log(`\n👉 Open your BRC-100 wallet and look for the incoming payment request.`)

  await wallet.close()
}

main().catch(err => {
  console.error('Request failed:', err)
  process.exit(1)
})
