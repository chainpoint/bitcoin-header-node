/*!
 * Extended rpc module for header node
 * Copyright (c) 2019-, Tierion Inc (MIT License).
 * https://github.com/chainpoint/headernode
 */

'use strict'

const Validator = require('bval')
const {
  pkg,
  protocol: { Network },
  node: { RPC }
} = require('bcoin')
const { RPCError } = require('bweb')

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

  async help(args) {
    if (args.length === 0) return `Select a command:\n${Object.keys(this.calls).join('\n')}`

    const json = {
      method: args[0],
      params: []
    }

    return await this.execute(json, true)
  }

  /*
   * Divergent from normal getBlockHeader
   * Does not support getting block header by hash
   * only height since that's all our indexer supports
   */
  async getBlockHeader(args, help) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, 'getblockheader "hash" ( verbose )')

    const valid = new Validator(args)
    const height = valid.uint(0)
    const verbose = valid.bool(1, true)

    if (!height) throw new RPCError(errs.MISC_ERROR, 'Invalid block height.')

    const header = await this.headerindex.getHeader(height)

    if (!header) throw new RPCError(errs.MISC_ERROR, 'Block not found')

    if (!verbose) return header.toRaw().toString('hex', 0, 80)

    return await this.headerToJSON(header)
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

module.exports = HeaderRPC
