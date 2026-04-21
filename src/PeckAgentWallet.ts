/**
 * PeckAgentWallet — BRC-100 native wallet for autonomous agents.
 *
 * Wraps @bsv/wallet-toolbox. Agenten eier nøkkelen, wallet-toolbox håndterer
 * UTXO-state, ancestor-BEEF, signing via wallet.createAction(). Ingen P2PKH-
 * shortcuts — alt går via proper BRC-100-basket-mønster.
 *
 * FUNDING-FLOW:
 *   Agenten produserer en funding-request via makeFundingRequest().
 *   User's BRC-wallet (eller annen agent) sender BRC-29-payment til agentens
 *   identityKey med derivationPrefix/Suffix.
 *   Agenten internalizeAction på payment-TXen m/ protocol='wallet payment'.
 *   Da har walletet BRC-29-sporede UTXO-er den kan bruke i createAction.
 *
 * Se examples/funding-flow.md for full flyt (TODO).
 */
import { PrivateKey, AtomicBEEF, Script } from '@bsv/sdk'
import { Setup, Chain } from '@bsv/wallet-toolbox'
import type { SetupWallet } from '@bsv/wallet-toolbox'
import { MessageBoxClient, PeerPayClient } from '@bsv/message-box-client'
import type { IncomingPayment } from '@bsv/message-box-client'
import Redis from 'ioredis'
import {
  buildPost, buildLike, buildRepost, buildFollow,
} from './bitcoinSchema.js'
import type {
  PeckAgentWalletConfig,
  BroadcastResult,
  Network,
} from './types.js'

const DEFAULT_BROADCAST_STREAM = 'broadcast-queue'
const DEFAULT_MESSAGEBOX_URL = process.env.MESSAGEBOX_URL || 'https://msg.peck.to'

export class PeckAgentWallet {
  private config: PeckAgentWalletConfig
  private setup?: SetupWallet
  private signingKey: PrivateKey
  private address: string
  private identityKey: string
  private appName: string
  private network: Network
  private redis?: Redis
  private messageBox?: MessageBoxClient
  private peerPay?: PeerPayClient

  constructor(config: PeckAgentWalletConfig) {
    this.config = config
    this.network = config.network || 'main'
    this.appName = config.appName || 'peck.agents'
    this.signingKey = PrivateKey.fromString(config.privateKeyHex, 'hex')
    this.address = this.signingKey.toAddress(this.network === 'main' ? 'mainnet' : 'testnet') as string
    this.identityKey = this.signingKey.toPublicKey().toString()
  }

  async init(): Promise<void> {
    if (this.setup) return
    const storage = this.config.storage || { kind: 'sqlite', filePath: '.peck-agent-wallet.db' }
    if (storage.kind !== 'sqlite') {
      throw new Error(`Storage kind ${storage.kind} not yet implemented — use 'sqlite'`)
    }
    const env = {
      chain: this.network as Chain,
      identityKey: this.identityKey,
      identityKey2: this.identityKey,
      filePath: storage.filePath,
      taalApiKey: process.env.TAAL_API_KEY || '',
      devKeys: { [this.identityKey]: this.config.privateKeyHex },
      mySQLConnection: '',
    }
    this.setup = await Setup.createWalletSQLite({
      env,
      rootKeyHex: this.config.privateKeyHex,
      filePath: storage.filePath,
      databaseName: storage.databaseName || 'peck-agent',
    })
    if (this.config.services?.redisHost) {
      this.redis = new Redis({
        host: this.config.services.redisHost,
        port: this.config.services.redisPort || 6379,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      })
      await this.redis.connect()
    }

    // MessageBoxClient for generisk meldingsutveksling (funding-requests etc).
    // PeerPayClient extends det + håndterer BRC-29-payments automatisk.
    // Begge bruker vår wallet for BRC-104 auth. init() verifiserer kun wallet-
    // connectivity — SHIP-anoint må gjøres eksplisitt via anointHost() etter at
    // agenten har fått funding (krever en spendable UTXO for å lage
    // tm_messagebox PushDrop-output). Same-host same-routing (agent og
    // recipient begge på msg.peck.to) fungerer uten anoint.
    this.messageBox = new MessageBoxClient({
      walletClient: this.setup.wallet,
      host: DEFAULT_MESSAGEBOX_URL,
    })
    await this.messageBox.init(DEFAULT_MESSAGEBOX_URL)

    this.peerPay = new PeerPayClient({
      walletClient: this.setup.wallet,
      messageBoxHost: DEFAULT_MESSAGEBOX_URL,
    })
    await this.peerPay.init(DEFAULT_MESSAGEBOX_URL)
  }

  /**
   * Anoint agentens messagebox-host på overlay (SHIP-advertisement). Påkrevd
   * for cross-host discovery — hvis agenten og sender bruker ulike messagebox-
   * hosts, må senderens wallet kunne SHIP-lookup'e agenten.
   *
   * Krever en spendable UTXO (minst ~10 sat til fee + 1 sat til advertisement-
   * output). Kall først etter at agenten har mottatt funding.
   */
  async anointHost(host?: string): Promise<{ txid: string }> {
    this.ensureInit()
    if (!this.messageBox) throw new Error('MessageBox not initialized')
    return this.messageBox.anointHost(host || DEFAULT_MESSAGEBOX_URL)
  }

  // --- Payment requests (BRC-100 / @bsv/message-box-client standard) ---

  /**
   * Be en recipient (user's BRC-100-wallet eller annen agent) om betaling via
   * standard `payment_requests`-box. Sender en PaymentRequestMessage med
   * requestId + HMAC-proof (protocolID [2, 'payment request auth']). Kompatible
   * wallets (Babbage, bsv-browser, peck-desktop) plukker den opp via
   * listIncomingPaymentRequests og kan approve → sendLivePayment til vårt
   * payment_inbox.
   *
   * Returnerer requestId + requestProof slik at caller kan cancel'e senere.
   * Kaster 'Payment request blocked' hvis recipient har blokkert vår identityKey.
   */
  async requestPayment(args: {
    recipientIdentityKey: string
    sats: number
    description: string
    expiresAtMs?: number
  }): Promise<{ requestId: string; requestProof: string }> {
    this.ensureInit()
    if (!this.peerPay) throw new Error('PeerPay not initialized')
    return this.peerPay.requestPayment({
      recipient: args.recipientIdentityKey,
      amount: args.sats,
      description: args.description,
      expiresAt: args.expiresAtMs ?? Date.now() + 3600_000,
    })
  }

  /**
   * Poll agentens payment_inbox for innkommende BRC-29-payments via PeerPay.
   * Hver melding er en PaymentToken med BEEF + derivation info — PeerPay's
   * acceptPayment håndterer internalizeAction automatisk.
   * Returnerer antall payments akseptert.
   */
  async processIncomingPayments(): Promise<number> {
    this.ensureInit()
    if (!this.peerPay) throw new Error('PeerPay not initialized')
    const payments: IncomingPayment[] = await this.peerPay.listIncomingPayments()
    let processed = 0
    for (const p of payments) {
      try {
        await this.peerPay.acceptPayment(p)
        processed++
      } catch (e) {
        console.warn(`[peck-agent-wallet] failed to accept payment ${p.messageId}:`, (e as Error).message)
      }
    }
    return processed
  }

  /**
   * Lytt etter live (WebSocket) payments. Kaller onPayment når en payment
   * kommer inn — caller velger å accept/reject. Typisk agent-loop setter
   * dette opp én gang og lar PeerPay auto-accept.
   */
  async listenForLivePayments(onPayment?: (p: IncomingPayment) => void): Promise<void> {
    this.ensureInit()
    if (!this.peerPay) throw new Error('PeerPay not initialized')
    const handler = onPayment || (async (p) => {
      try {
        await this.peerPay!.acceptPayment(p)
        console.log(`[peck-agent-wallet] accepted payment ${p.messageId} (${p.token?.amount} sat)`)
      } catch (e) {
        console.warn(`[peck-agent-wallet] failed to auto-accept ${p.messageId}:`, (e as Error).message)
      }
    })
    await this.peerPay.listenForLivePayments({ onPayment: handler })
  }

  /** Agentens P2PKH-adresse (identifikasjon). */
  getAddress(): string {
    return this.address
  }

  /** Agentens identityKey (BRC-42 public key, hex). */
  getIdentityKey(): string {
    return this.identityKey
  }

  /**
   * Motta en BRC-29 payment (atomic BEEF) og internaliser den i walletet.
   * Argumentene (derivationPrefix/Suffix/senderIdentityKey) kommer fra
   * senderens createAction-response. Etter dette har walletet brukbare
   * satoshis for createAction().
   */
  async receivePayment(args: {
    tx: AtomicBEEF
    outputIndex: number
    derivationPrefix: string
    derivationSuffix: string
    senderIdentityKey: string
    description: string
  }): Promise<void> {
    this.ensureInit()
    await this.setup!.wallet.internalizeAction({
      tx: args.tx,
      outputs: [{
        outputIndex: args.outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: args.derivationPrefix,
          derivationSuffix: args.derivationSuffix,
          senderIdentityKey: args.senderIdentityKey,
        },
      }],
      description: args.description,
    })
  }

  // --- High-level content ops ---

  async post(args: { content: string; tags?: string[]; channel?: string; parentTxid?: string }): Promise<BroadcastResult> {
    this.ensureInit()
    const script = buildPost({
      content: args.content,
      tags: args.tags,
      channel: args.channel,
      parentTxid: args.parentTxid,
      app: this.appName,
      signingKey: this.signingKey,
      network: this.network,
    })
    return this.broadcastScript(script.toHex(), args.parentTxid ? 'peck reply' : 'peck post')
  }

  async reply(args: { parentTxid: string; content: string; tags?: string[] }): Promise<BroadcastResult> {
    return this.post({ ...args })
  }

  async like(targetTxid: string): Promise<BroadcastResult> {
    this.ensureInit()
    const script = buildLike({
      targetTxid,
      app: this.appName,
      signingKey: this.signingKey,
      network: this.network,
    })
    return this.broadcastScript(script.toHex(), 'peck like')
  }

  async repost(args: { targetTxid: string; content?: string }): Promise<BroadcastResult> {
    this.ensureInit()
    const script = buildRepost({
      targetTxid: args.targetTxid,
      content: args.content,
      app: this.appName,
      signingKey: this.signingKey,
      network: this.network,
    })
    return this.broadcastScript(script.toHex(), 'peck repost')
  }

  async follow(targetAddress: string): Promise<BroadcastResult> {
    this.ensureInit()
    const script = buildFollow({
      targetAddress,
      app: this.appName,
      signingKey: this.signingKey,
      network: this.network,
    })
    return this.broadcastScript(script.toHex(), 'peck follow')
  }

  /**
   * Lav-nivå public: broadcast arbitrary outputs through wallet-toolbox.
   *
   * All UTXO-valg, ancestor BEEF-assembly, signing og broadcast til ARC
   * (eller Redis → peck-broadcaster → overlay hvis services.redisHost er
   * satt) skjer via `@bsv/wallet-toolbox` createAction. Caller leverer
   * bare outputs og en description.
   *
   * Typisk bruk: appen bygger et Bitcoin Schema MAP+B+AIP script (eller
   * noe annet lockingScript) og lar peck-agent-wallet håndtere resten:
   *
   * ```ts
   * const script = buildMessageScript({channel, content, ...})
   * const result = await wallet.broadcast({
   *   description: 'peck message',
   *   outputs: [{ lockingScript: script.toHex(), satoshis: 0 }],
   * })
   * ```
   *
   * Denne primitiven gjør at høy-nivå apper (peck-mcp, scripts, daemons)
   * kan bruke peck-agent-wallet som eneste wallet-backend uten å bygge
   * eget UTXO-management eller egen broadcast-path.
   */
  async broadcast(args: {
    description: string
    outputs: Array<{
      lockingScript: Script | string
      satoshis?: number
      outputDescription?: string
    }>
    labels?: string[]
  }): Promise<BroadcastResult> {
    this.ensureInit()
    const wallet = this.setup!.wallet
    const normalizedOutputs = args.outputs.map(o => ({
      lockingScript: typeof o.lockingScript === 'string' ? o.lockingScript : o.lockingScript.toHex(),
      satoshis: o.satoshis ?? 0,
      outputDescription: o.outputDescription ?? args.description,
    }))
    const result = await wallet.createAction({
      description: args.description,
      outputs: normalizedOutputs,
      labels: args.labels,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    })
    if (!result.txid) {
      return { txid: '', status: 'rejected', detail: 'wallet.createAction returned no txid' }
    }
    const txid = result.txid
    if (this.redis && result.tx) {
      const beefHex = Buffer.from(result.tx).toString('hex')
      const stream = this.config.services?.broadcastStream || DEFAULT_BROADCAST_STREAM
      const payload = JSON.stringify({ txid, beef_hex: beefHex, topics: ['peck-schema'], attempt: 0 })
      await this.redis.xadd(stream, 'MAXLEN', '~', '100000', '*', 'payload', payload)
      return { txid, status: 'queued', detail: `enqueued to ${stream}` }
    }
    return { txid, status: 'submitted', detail: 'wallet-toolbox ARC' }
  }

  /** Kortere helper for single-script broadcasts med 0 sat output. */
  private async broadcastScript(scriptHex: string, description: string): Promise<BroadcastResult> {
    return this.broadcast({
      description,
      outputs: [{ lockingScript: scriptHex, satoshis: 0 }],
    })
  }

  private ensureInit(): void {
    if (!this.setup) throw new Error('PeckAgentWallet not initialized — call await wallet.init() first')
  }

  async close(): Promise<void> {
    if (this.redis) await this.redis.quit()
  }
}
