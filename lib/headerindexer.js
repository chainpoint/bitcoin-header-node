'use strict';

const bdb = require('bdb');
const assert = require('bsert');
const { Indexer, Headers, ChainEntry } = require('bcoin');

const layout = require('./layout');

/**
 * FilterIndexer
 * @alias module:indexer.FilterIndexer
 * @extends Indexer
 */
class HeaderIndexer extends Indexer {
  /**
   * Create a indexer
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super('headers', options);

    this.db = bdb.create(this.options);
    this.checkpoints = this.client.chain.options.checkpoints;
  }

  /**
   * add header to index.
   * @private
   * @param {ChainEntry} entry for block to chain
   * @param {Block} block - Block to index
   * @param {CoinView} view - Coin View
   * @returns {Promise} returns promise
   */
  async indexBlock(entry) {
    const hash = entry.hash;
    const header = Headers.fromEntry(entry);
    const height = entry.height;
    const chainState = this.client.chain.db.state;

    // ideally wouldn't have an async task here
    // since this has to happen for each block that gets indexed
    const prevEntry = await this.db.get(layout.t.encode());

    const b = this.db.batch();
    // save prevEntry, chain state, and chain entry for
    // resetting the chain
    b.put(layout.p.encode(), prevEntry);
    b.put(layout.c.encode(), chainState.toRaw());
    b.put(layout.t.encode(), entry.toRaw());

    // save block header
    // if block is historical (i.e. older than last checkpoint)
    // we can save the header. Otherwise need to save the
    // whole entry so the chain can be replayed from that point
    if (prevEntry && this.isHistorical(prevEntry))
      b.put(layout.b.encode(hash), header.toRaw());
    else
      b.put(layout.b.encode(hash), entry.toRaw());

    // save hash -> header for lookups
    b.put(layout.H.encode(height), hash);

    return b.write();
  }

  /**
   * Remove header from index.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   */

  async unindexBlock(entry) {
    const b = this.db.batch();

    const hash = entry.hash();
    const height = entry.height;

    b.del(layout.b.encode(hash));
    b.del(layout.H.encode(height));

    return b.write();
  }

  /**
   * Get block header by height
   * @param {height} block height
   * @returns {Headers|null} block header
   */

  async getHeaderByHeight(height) {
    const hash = await this.db.get(layout.H.encode(height));

    if (!hash) return null;

    return (await this.db.get(layout.b.encode(hash))) || null;
  }

  /**
   * Get latest ChainState
   * useful for resetting chain when there is no persistent db
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getChainState() {
    return this.db.get(layout.c.encode());
  }

  /**
   * Get previous entry
   * useful for resetting chain when there is no persistent db
   * @returns {ChainEntry} - returns chain entry for tip's previous block
   */

  async getPrevEntry() {
    const prevBlock = await this.db.get(layout.p.encode());
    const chainTip = await this.getChainTip();

    // checking that the prev entry matches prevBlock in tip
    assert.equal(
      ChainEntry.fromRaw(chainTip).prevBlock.toString('hex'),
      ChainEntry.fromRaw(prevBlock).hash.toString('hex'),
      'Mismatch between previous entry and prev hash in chain tip'
    );
    return prevBlock;
  }

  /**
   * Get chain tip
   * useful for resetting chain when there is no persistent db
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  async getChainTip() {
    return this.db.get(layout.t.encode());
  }

  /**
   * Test whether the entry is potentially
   * an ancestor of a checkpoint.
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  isHistorical(prev) {
    if (this.checkpoints) {
      if (prev.height + 1 <= this.network.lastCheckpoint)
        return true;
    }
    return false;
  }
}

module.exports = HeaderIndexer;
