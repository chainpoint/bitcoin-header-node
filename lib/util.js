/*!
 * helper functions
 * Copyright (c) 2019-, Tierion (MIT License).
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License).
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict'

const assert = require('bsert')
const bcurl = require('bcurl')
const { ChainEntry } = require('bcoin')

/**
 * Reverse a hex-string.
 * @param {String} str - Hex string.
 * @returns {String} Reversed hex string.
 */

function revHex(buf) {
  assert(Buffer.isBuffer(buf))

  const str = buf.toString('hex')

  let out = ''

  for (let i = str.length - 2; i >= 0; i -= 2) {
    out += str[i] + str[i + 1]
  }

  return out
}

function fromRev(str) {
  assert(typeof str === 'string')
  assert((str.length & 1) === 0)

  let out = ''

  for (let i = str.length - 2; i >= 0; i -= 2) {
    out += str[i] + str[i + 1]
  }

  return Buffer.from(out, 'hex')
}

/**
 * Get current time in unix time (seconds).
 * @returns {Number}
 */

function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Retrieve block info from blockcypher
 * @param {Number} heights - a params list of block heights to retrieve
 * @returns {ChainEntry[]} - array of bcoin ChainEntries
 */
async function getRemoteBlockEntries(network, ...heights) {
  assert(typeof network === 'string', 'Must pass a network type of main or testnet as first argument')
  assert(network === 'main' || network === 'testnet', `${network} is not a valid network`)
  const client = bcurl.client(`https://api.blockcypher.com/v1/btc/${network === 'main' ? network : 'test3'}/blocks`)

  const blocks = []

  for (let height of heights) {
    let block = await client.get(`/${height}`)
    if (!block)
      throw new Error(
        `No block returned for height ${height} on ${network} network from blockcypher.
Make sure you have not exceeded API limit and the block exists on the blockchain.`
      )
    block = convertBlockcypherMeta(block)
    blocks.push(ChainEntry.fromOptions(block).toRaw())
  }

  return blocks
}

/**
 * Because the block data returned from blockcypher
 * does not conform to the same JSON structure as bcoin
 * we need to convert the property names
 * @param {Object} meta - blockcypher returned metadata for one block
 * @returns {Object} block - the bcoin conforming block object
 */
function convertBlockcypherMeta(meta) {
  const block = {}

  block.hash = fromRev(meta.hash)
  block.version = meta.ver
  block.prevBlock = fromRev(meta.prev_block)
  block.merkleRoot = fromRev(meta.mrkl_root)
  block.time = new Date(meta.time).getTime() / 1000
  block.bits = meta.bits
  block.nonce = meta.nonce
  block.height = meta.height

  return block
}

exports.revHex = revHex
exports.fromRev = fromRev
exports.getRemoteBlockEntries = getRemoteBlockEntries
exports.convertBlockcypherMeta = convertBlockcypherMeta
exports.now = now

module.exports = exports
