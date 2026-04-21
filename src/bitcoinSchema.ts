/**
 * Bitcoin Schema script builders (MAP + B + AIP).
 *
 * Utensignert Bitcoin Schema — produserer et OP_RETURN-script som deretter
 * pakkes inn i en TX via wallet.createAction. All MAP-protokoll-parsing
 * gjøres nedstrøms av overlay's PeckSchemaTopicManager.
 *
 * Kopiert og rensket fra peck-mcp-remote.ts så biblioteket ikke har runtime-
 * avhengighet til peck-mcp.
 */
import { Script, OP, PrivateKey, BSM } from '@bsv/sdk'
import { createHash } from 'crypto'

// Well-known Bitcoin Schema protocol prefix addresses (public).
export const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
export const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
export const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
const PIPE = 0x7c

type Network = 'main' | 'test'

function pushData(s: Script, data: string | Buffer | number[]): void {
  const bytes = typeof data === 'string'
    ? Array.from(Buffer.from(data, 'utf8'))
    : Array.isArray(data) ? data : Array.from(data)
  s.writeBin(bytes)
}

function signAip(s: Script, content: string, key: PrivateKey, network: Network): void {
  const addr = key.toAddress(network === 'main' ? 'mainnet' : 'testnet') as string
  const hash = Array.from(createHash('sha256').update(content).digest())
  // BSM.sign returnerer base64-string by default. AIP-protokollen pusher
  // signaturen som base64-string (ikke raw bytes) — matcher alle eksisterende
  // Bitcoin Schema TX-es.
  const sig = BSM.sign(hash, key, 'base64') as string
  s.writeBin([PIPE])
  pushData(s, PROTO_AIP)
  pushData(s, 'BITCOIN_ECDSA')
  pushData(s, addr)
  pushData(s, sig)
}

export interface PostOpts {
  content: string
  tags?: string[]
  channel?: string
  parentTxid?: string
  app: string
  signingKey: PrivateKey
  network: Network
}

export function buildPost(opts: PostOpts): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  // B content
  pushData(s, PROTO_B)
  pushData(s, opts.content)
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')
  s.writeBin([PIPE])
  // MAP SET
  pushData(s, PROTO_MAP)
  pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, opts.app)
  pushData(s, 'type'); pushData(s, 'post')
  if (opts.parentTxid) {
    pushData(s, 'context'); pushData(s, 'tx')
    pushData(s, 'tx'); pushData(s, opts.parentTxid)
  }
  if (opts.channel) { pushData(s, 'channel'); pushData(s, opts.channel) }
  // Tags via MAP ADD
  if (opts.tags?.length) {
    s.writeBin([PIPE])
    pushData(s, PROTO_MAP); pushData(s, 'ADD'); pushData(s, 'tags')
    for (const t of opts.tags) pushData(s, t)
  }
  signAip(s, opts.content, opts.signingKey, opts.network)
  return s
}

export interface LikeOpts {
  targetTxid: string
  app: string
  signingKey: PrivateKey
  network: Network
}

export function buildLike(opts: LikeOpts): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, opts.app)
  pushData(s, 'type'); pushData(s, 'like')
  pushData(s, 'context'); pushData(s, 'tx')
  pushData(s, 'tx'); pushData(s, opts.targetTxid)
  signAip(s, opts.targetTxid, opts.signingKey, opts.network)
  return s
}

export interface RepostOpts {
  targetTxid: string
  content?: string
  app: string
  signingKey: PrivateKey
  network: Network
}

export function buildRepost(opts: RepostOpts): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  const hasComment = !!opts.content && opts.content.trim().length > 0
  // B (empty string if pure repost)
  pushData(s, PROTO_B)
  pushData(s, hasComment ? opts.content! : '')
  pushData(s, 'text/markdown')
  pushData(s, 'UTF-8')
  s.writeBin([PIPE])
  // MAP SET — quote post if has comment, pure repost if not
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, opts.app)
  if (hasComment) {
    pushData(s, 'type'); pushData(s, 'post')
    pushData(s, 'context'); pushData(s, 'tx')
    pushData(s, 'tx'); pushData(s, opts.targetTxid)
    pushData(s, 'subcontext'); pushData(s, 'quote')
  } else {
    pushData(s, 'type'); pushData(s, 'repost')
    pushData(s, 'tx'); pushData(s, opts.targetTxid)
  }
  signAip(s, opts.content || opts.targetTxid, opts.signingKey, opts.network)
  return s
}

export interface FollowOpts {
  targetAddress: string
  unfollow?: boolean
  app: string
  signingKey: PrivateKey
  network: Network
}

export function buildFollow(opts: FollowOpts): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  pushData(s, PROTO_MAP); pushData(s, 'SET')
  pushData(s, 'app'); pushData(s, opts.app)
  pushData(s, 'type'); pushData(s, opts.unfollow ? 'unfollow' : 'follow')
  pushData(s, 'bapID'); pushData(s, opts.targetAddress)
  signAip(s, opts.targetAddress, opts.signingKey, opts.network)
  return s
}
