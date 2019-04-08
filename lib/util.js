/*!
 * util.js - utils for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const bcurl = require('bcurl');
const { ChainEntry } = require('bcoin');

/**
 * Reverse a hex-string.
 * @param {String} str - Hex string.
 * @returns {String} Reversed hex string.
 */

function revHex(buf) {
  assert(Buffer.isBuffer(buf));

  const str = buf.toString('hex');

  let out = '';

  for (let i = str.length - 2; i >= 0; i -= 2) {
    out += str[i] + str[i + 1];
  }

  return out;
}

function fromRev(str) {
  assert(typeof str === 'string');
  assert((str.length & 1) === 0);

  let out = '';

  for (let i = str.length - 2; i >= 0; i -= 2) {
    out += str[i] + str[i + 1];
  }

  return Buffer.from(out, 'hex');
}

/**
 * Retrieve block info from btc.com
 * @param {Number} heights - a params list of block heights to retrieve
 * @returns {ChainEntry[]} - array of bcoin ChainEntries
 */
async function getRemoteBlockEntries(...heights) {
  heights = heights.join(',');

  const client = bcurl.client('https://chain.api.btc.com/v3/block');

  const blocks = await client.get(`/${heights}`);

  let entries;
  if (!Array.isArray(blocks.data)) {
    const block = convertBtcMetadata(blocks.data);
    entries = [ChainEntry.fromOptions(block).toRaw()];
  } else
    entries = blocks.data.map(meta => {
      const options = convertBtcMetadata(meta);
      return ChainEntry.fromOptions(options).toRaw();
    });

  return entries;
}

/**
 * Because the block data returned from btc.com
 * does not conform to the same JSON structure as bcoin
 * we need to convert the property names
 * @param {Object} meta - btc.com returned metadata for one block
 * @returns {Object} block - the bcoin conforming block object
 */
function convertBtcMetadata(meta) {
  const block = {};

  block.hash = fromRev(meta.hash);
  block.version = meta.version;
  block.prevBlock = fromRev(meta.prev_block_hash);
  block.merkleRoot = fromRev(meta.mrkl_root);
  block.time = meta.timestamp;
  block.bits = meta.bits;
  block.nonce = meta.nonce;
  block.height = meta.height;

  return block;
}

exports.revHex = revHex;
exports.getRemoteBlockEntries = getRemoteBlockEntries;
exports.convertBtcMetadata = convertBtcMetadata;

module.exports = exports;
