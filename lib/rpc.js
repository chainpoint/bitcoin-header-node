/*!
 * Extended rpc module for header node
 * Copyright (c) 2019-, Tierion Inc (MIT License).
 * https://github.com/chainpoint/headernode
 */

'use strict'

const Validator = require('bval')
const assert = require('bsert')
const {
  pkg,
  protocol: { Network, consensus },
  node: { RPC }
} = require('bcoin')
const { RPCError } = require('bweb')
const util = require('./util')

// constants from base implementation
const errs = {
  // General application defined errors
  MISC_ERROR: -1
}

class HeaderRPC extends RPC {
  constructor(node) {
    super(node)
    this.headerindex = node.headerindex
  }

  /*
   * Overall control/query calls
   */

  async getInfo(args, help) {
    if (help || args.length !== 0) throw new RPCError(errs.MISC_ERROR, 'getinfo')

    return {
      version: pkg.version,
      protocolversion: this.pool.options.version,
      blocks: this.headerindex.height,
      startheight: this.headerindex.startHeight ? this.headerindex.startHeight : undefined,
      timeoffset: this.network.time.offset,
      connections: this.pool.peers.size(),
      proxy: '',
      difficulty: toDifficulty(this.chain.tip.bits),
      testnet: this.network !== Network.main,
      keypoololdest: 0,
      keypoolsize: 0,
      unlocked_until: 0,
      errors: ''
    }
  }

  init() {
    super.init()
    this.add('getheaderbyheight', this.getHeaderByHeight)
    this.add('getstartheader', this.getStartHeader)
  }

  async help(args) {
    if (args.length === 0) return `Select a command:\n${Object.keys(this.calls).join('\n')}`

    const json = {
      method: args[0],
      params: []
    }

    return await this.execute(json, true)
  }

  async getStartHeader(args, help) {
    if (help || args.length > 1) throw new RPCError(errs.MISC_ERROR, 'getstartheader')

    const valid = new Validator(args)
    const verbose = valid.bool(0, true)

    const height = this.node.headerindex.startHeight
    const header = await this.node.headerindex.getEntry(height)
    if (!header) throw new RPCError(errs.MISC_ERROR, 'Block not found')

    if (!verbose) return header.toRaw().toString('hex', 0, 80)
    const json = await this.headerToJSON(header)
    // json.chainwork = undefined
    return json
  }

  async getHeaderByHeight(args, help) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, 'getheaderbyheight "height" ( verbose )')

    const valid = new Validator(args)
    const height = valid.u32(0)
    const verbose = valid.bool(1, true)

    if (height == null || height > this.chain.height || height < this.node.getStartHeight())
      throw new RPCError(errs.MISC_ERROR, 'Block height out of range.')

    const entry = await this.node.headerindex.getEntry(height)

    if (!entry) throw new RPCError(errs.MISC_ERROR, 'Block not found')

    if (!verbose) return entry.toRaw().toString('hex', 0, 80)

    return await this.headerToJSON(entry)
  }

  // slight different from the parent since the next lookup won't always work
  // and we probably wont' have the chainwork for a historical block
  async headerToJSON(entry) {
    const mtp = await this.chain.getMedianTime(entry)
    const next = await this.node.headerindex.getEntry(entry.height + 1)

    return {
      hash: entry.rhash(),
      confirmations: this.chain.height - entry.height + 1,
      height: entry.height,
      version: entry.version,
      versionHex: hex32(entry.version),
      merkleroot: util.revHex(entry.merkleRoot),
      time: entry.time,
      mediantime: mtp,
      bits: entry.bits,
      difficulty: toDifficulty(entry.bits),
      previousblockhash: !entry.prevBlock.equals(consensus.ZERO_HASH) ? util.revHex(entry.prevBlock) : null,
      nextblockhash: next.hash ? util.revHex(next.hash) : null
    }
  }
}

/*
 * Helpers
 */

function toDifficulty(bits) {
  let shift = (bits >>> 24) & 0xff
  let diff = 0x0000ffff / (bits & 0x00ffffff)

  while (shift < 29) {
    diff *= 256.0
    shift++
  }

  while (shift > 29) {
    diff /= 256.0
    shift--
  }

  return diff
}

function hex32(num) {
  assert(num >= 0)

  num = num.toString(16)

  assert(num.length <= 8)

  while (num.length < 8) num = '0' + num

  return num
}

module.exports = HeaderRPC
