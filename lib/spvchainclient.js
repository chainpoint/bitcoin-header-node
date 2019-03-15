/*!
 * spvchainclient.js - spv chain client for bcoin
 * adds some overrides to parent chain client class
 * Copyright (c) 2019, bucko (MIT License).
 */

'use strict';

const assert = require('bsert');
const { ChainClient } = require('bcoin');

class SPVChainClient extends ChainClient {
  /**
   * Create a chain client.
   * @constructor
   * @param {Chain} chain - a blockchain object
   */
  constructor(chain) {
    super(chain);
  }

  /**
   * Get block
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns {@link Block}
   */

  async getBlock(hash) {
    let block = await this.chain.getBlock(hash);
    if (!block)
      block = await this.chain.getEntry(hash);

    if (!block)
      return null;

    return block;
  }

  /**
   * Rescan for any missed blocks.
   * @param {Number} start - Start block.
   * @returns {Promise}
   */

  async rescan(start) {
    for (let i = start; ; i++) {
      const entry = await this.getEntry(i);
      if (!entry) {
        await this.emitAsync('chain tip');
        break;
      };

      const block = await this.getBlock(entry.hash);
      assert(block);

      await this.emitAsync('block rescan', entry, block);
    }
  };
}

module.exports = SPVChainClient;
