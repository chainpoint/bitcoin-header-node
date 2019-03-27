'use strict';

const bdb = require('bdb');
const assert = require('bsert');
const { Indexer, Headers, ChainEntry, CoinView } = require('bcoin');

const { ChainState, BlockMeta } = require('./records');
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
    if (options) this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HeaderIndexer options}
   */

  fromOptions(options) {
    if (options.startTip) {
      assert(
        options.startTip.length >= 2,
        'Chain tip array must have two items to initiate block'
      );

      // check that we hvae two buffers for chain tip
      for (let i = 0; i < 2; i++) {
        const entry = options.startTip[i];
        assert(Buffer.isBuffer(entry), 'Chain tip items must be buffers');
      }

      this.startTip = options.startTip;
    }

    return this;
  }

  async open() {
    await super.open();
    await this.setStartTip();
    await this.initializeChain();
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
    if (!data) return null;
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

  /**
   * @private
   * Set custom starting entry for fast sync
   */

  async setStartTip() {
    if (!this.startTip) return;

    assert(
      Array.isArray(this.startTip) && this.startTip.length >= 2,
      'Need at least two blocks for custom start tip'
    );

    // when chain is reset and the tip is not
    // the genesis block, chain will check to see if
    // it can find the previous block for the tip.
    // this means that for a custom start, we need two
    // entries: the tip to start from, and the previous entry
    let entry;
    for (entry of this.startTip) {
      assert(Buffer.isBuffer(entry), 'Start must be a Buffer');
      try {
        entry = ChainEntry.fromRaw(entry);
      } catch (e) {
        if (e.type === 'EncodingError')
          throw new Error(
            'HeaderIndexer: \
  Must pass a block or chain entry buffer to start fast sync'
          );
        throw e;
      }
      assert(entry.height > 0, 'Cannot pass Genesis block as custom start tip');

      // and then add the entry to the chain and header index
      await this.addEntryToChain(entry);
    }

    // need to set lastCheckpoint to our custom start tip
    // and add to checkpointMap
    this.network.lastCheckpoint = entry.height;
    this.network.checkpointMap[entry.height] = b(entry.hash);

    // reset the chain once the db is loaded
    await this.client.chain.close();
    await this.client.chain.open();

    // also need to add the chain tip to the header index
    this.state = new ChainState();
    this.state.height = entry.height;
    await this.setTip(BlockMeta.fromEntry(entry));
    await this.addEntryBlock(entry);
  }

  /**
   * Initialize chain by comparing with an existing
   * Headers index if one exists
   */

  async initializeChain() {
    const unlock = await this.lock.lock();
    try {
      await this._initializeChain();
    } finally {
      unlock();
    }
  }

  async _initializeChain() {
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
        'Chain state is behind header. Re-initializing chain...',
        tip.hash
      );

      let entry;

      // if headers tip is historical (before last checkpoint)
      // then we need to resync chain from genesis
      if (
        // need to catch when no lastCheckpoint for test chains
        !this.network.lastCheckpoint ||
        tip.height <= this.network.lastCheckpoint
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
        this.logger.debug(
          'Re-indexing block entry %d to chain: %h',
          entry.height,
          entry.hash
        );

        await this.addEntryToChain(entry);
        // increment to the next entry
        entry = await this.getHeaderByHeight(entry.height + 1);
      }

      // reset the chain once the db is loaded
      await this.client.chain.close();
      await this.client.chain.open();

      this.logger.info('ChainDB successfully re-initialized to headers tip.');
    }
  }

  /*
   * Simple utility to add an entry to the chain
   * with chaindb's 'reconnect'
   */
  async addEntryToChain(entry) {
    // `reconnect` needs a block. The AbstractBlock class
    // that Headers inherits from should be sufficient
    const block = Headers.fromHead(entry.toRaw());

    // chaindb's reconnect will make the updates to the
    // the chain state that we need to catch up
    await this.client.chain.db.reconnect(entry, block, new CoinView());
  }

  async addEntryBlock(entry) {
    const block = Headers.fromHead(entry.toRaw());
    await this.addBlock(entry, block, new CoinView());
  }
}

/*
 * Helpers
 */

function b(hash) {
  return Buffer.from(hash, 'hex');
}

module.exports = HeaderIndexer;
