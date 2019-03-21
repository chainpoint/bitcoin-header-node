'use strict';

const bdb = require('bdb');
const assert = require('bsert');
const { Indexer, Headers, ChainEntry, CoinView } = require('bcoin');

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

  async open() {
    await super.open();
    await this.setChainTip();
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
      b.put(layout.b.encode(height), header.toRaw());
    else b.put(layout.b.encode(height), entry.toRaw());

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
    const height = entry.height;

    b.del(layout.b.encode(height));

    return b.write();
  }

  /**
   * Get block header by height
   * @param {height} block height
   * @returns {Headers|null} block header
   */

  async getHeaderByHeight(height) {
    const data = await this.db.get(layout.b.encode(height));
    if (!data)
      return null;
    return ChainEntry.fromRaw(data);
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
    return this.client.chain.isHistorical(prev);
  }

  async setChainTip() {
    const unlock = await this.lock.lock();
    try {
      await this._setChainTip();
    } finally {
      unlock();
    }
  }

  async _setChainTip() {
    let chainTip = await this.client.chain.db.getTip();
    const headerState = await this.getState();

    // if everything is fresh, we can sync as normal
    if (!headerState) return;

    // if there is no chainTip or chainTip is behind the headers height
    // then we need to rebuild the in-memory chain for contextual checks
    // and index management
    if (!chainTip || chainTip.height < headerState.height) {
      chainTip = await this.getChainTip();
      const tip = ChainEntry.fromRaw(chainTip);
      this.logger.info(
        'Chain state is behind header. Resetting chain to: %h',
        tip.hash
      );

      // if headers tip is historical (before last checkpoint)
      // then we need to resync chain from genesis
      let entry;

      if (
        tip.height <= this.network.lastCheckpoint ||
        // need to catch when no lastCheckpoint for test chains
        !this.network.lastCheckpoint
      ) {
        this.logger.info(
          'Headers tip before last checkpoint. Resyncing chain from genesis'
        );
        // would be nice to not have to start from the beginning
        // but rather from between checkpoints
        await this.client.chain.db.saveGenesis();
        entry = await this.getHeaderByHeight(1);
      } else {
        // otherwise first entry in the chain can be the last checkpoint
        this.logger.info(
          'Resyncing chain from last checkpoint: %d',
          this.network.lastCheckpoint
        );
        entry = await this.getHeaderByHeight(this.network.lastCheckpoint);
      }

      // add entries until chain is caught up to the header index
      while (entry && entry.height <= tip.height) {
        this.logger.debug('Re-index block entry to chain: %h', entry.hash);
        // `reconnect`` needs a block. The AbstractBlock class
        // that Headers inherits from should be sufficient
        const block = Headers.fromHead(entry.toRaw());

        // chaindb's reconnect will make the updates to the
        // the chain state that we need to catch up
        await this.client.chain.db.reconnect(entry, block, new CoinView());

        // increment to the next entry
        entry = await this.getHeaderByHeight(entry.height + 1);
      }
      await this.client.chain.close();
      await this.client.chain.open();

      this.logger.info('ChainDB successfully re-initialized to headers tip.');
    }
  }
}

module.exports = HeaderIndexer;
