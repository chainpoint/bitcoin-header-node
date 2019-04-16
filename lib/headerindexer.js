'use strict'

const bdb = require('bdb')
const assert = require('bsert')
const { Indexer, Headers, ChainEntry, CoinView } = require('bcoin')

const { ChainState, BlockMeta } = require('./records')
const layout = require('./layout')
const { getRemoteBlockEntries } = require('./util')
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
    super('headers', options)

    this.db = bdb.create(this.options)
    this.checkpoints = this.client.chain.options.checkpoints
    if (options) this.fromOptions(options)
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HeaderIndexer options}
   */

  fromOptions(options) {
    if (options.startHeight) {
      assert(typeof options.startHeight === 'number')
      this.startHeight = options.startHeight
    }
    // start tip will take precedence over startHeight
    if (options.startTip) {
      assert(options.startTip.length >= 2, 'Chain tip array must have two items to initiate block')

      // check that we hvae two buffers for chain tip
      for (let i = 0; i < 2; i++) {
        const entry = options.startTip[i]
        assert(Buffer.isBuffer(entry), 'Chain tip items must be buffers')
      }

      this.startTip = options.startTip
    }

    if (!options.network) {
      // Without this base indexer defaults to mainnet if no
      // network is set even if chain has a different network
      this.network = this.client.network
    }

    return this
  }

  async open() {
    // ensure is normally run by `super`'s `open` method
    // but in this case we need to make sure that the required
    // direcetories exist before setStartTip is run
    await this.ensure()
    // need to setStartTip before anything else since
    // the super open method will also connect the client
    // which causes events to fire that the tip needs to be initialized for first
    await this.setStartTip()
    await super.open()
    await this.initializeChain()
  }

  /**
   * @private
   * Set custom starting entry for fast sync
   */

  async setStartTip() {
    // can use a custom start height and use the btc.com
    // api to retrieve the block header information
    // this is not a trustless approach but is easier to bootstrap
    // startTip will take precedence though
    if (this.startHeight && !this.startTip) {
      assert.equal(
        this.network.type,
        'main',
        'Can only get starting block data for mainnet. Use `startTip` \
        with block data instead for other networks'
      )
      const entries = await getRemoteBlockEntries(this.startHeight - 1, this.startHeight)

      this.logger.info('Setting custom start height at %d', this.startHeight)
      this.startTip = entries
    }

    // if no custom startTip then we can skip and sync from genesis
    if (!this.startTip) return

    // when chain is reset and the tip is not
    // the genesis block, chain will check to see if
    // it can find the previous block for the tip.
    // this means that for a custom start, we need two
    // entries: the tip to start from, and the previous entry
    assert(Array.isArray(this.startTip) && this.startTip.length >= 2, 'Need at least two blocks for custom start tip')

    // since this is run before the `open` method where
    // there are other contextual checks that are done,
    // let's manually open the indexer db
    if (!this.db.loaded) await this.db.open()

    // need the chain db to be open so that we can set the tip
    // there to match the indexer
    assert(this.client.chain.opened, 'Chain should be opened to set the header index tip')

    let entry, prev
    for (let raw of this.startTip) {
      assert(Buffer.isBuffer(raw), 'Start must be a Buffer')
      prev = entry ? entry : null
      try {
        entry = ChainEntry.fromRaw(raw)
      } catch (e) {
        if (e.type === 'EncodingError')
          throw new Error('HeaderIndexer: Must pass a block or chain entry buffer to start fast sync')
        throw e
      }

      assert(entry.height > 0, 'Cannot pass Genesis block as custom start tip')

      // confirm that the starter tip is made up of incrementing blocks
      // i.e. prevBlock hash matches hash of previous block in array
      if (prev) {
        assert.equal(
          prev.hash.toString('hex'),
          entry.prevBlock.toString('hex'),
          `Entry's prevBlock doesn't match previous block hash (prev: ${prev.hash.toString(
            'hex'
          )}, tip: ${entry.prevBlock.toString('hex')})`
        )
      }

      const headerState = await this.getState()

      // if the index already has a state
      // and the state's height is ahead of the startTip
      // then everything has already been intialized and we can skip
      if (headerState && headerState.height > entry.height) {
        this.logger.debug('Indexer state already ahead of custom start tip.')
        await this.db.close()
        return
      }

      // and then add the entry to the chaindb with reconnect
      // note that this won't update the chain object, just its db
      await this.addEntryToChain(entry)
    }

    // if start height is _after_ lastCheckpoint, need to set lastCheckpoint
    // to our custom start tip and add to the network's checkpointMap
    // this is primarily for testing chains (like regtest). Can be used for
    // for real chains too but not safe behavior if on too recent of a block
    if (entry.height > this.network.lastCheckpoint) {
      this.logger.debug(`Setting network's lastCheckpoint to %d`, entry.height)
      this.setCustomCheckpoint(entry.height, toBuff(entry.hash))
    }

    // need to set the state so that the tip can be properly read and set
    this.state = new ChainState()
    this.state.height = entry.height
    this.state.startHeight = entry.height
    this.startHeight = entry.height

    // also need to add the entry to the header index
    // this will index the entry and set the tip
    await this.indexEntryBlock(entry)

    // closing and re-opening the chain will reset the state
    // based on the custom starting tip
    await this.client.chain.close()
    await this.client.chain.open()

    // re-close the database once the tip has been set
    await this.db.close()
  }

  /*
   * Sets a custom checkpoint on the network object
   * Useful for syncing from a custom block height
   * NOTE: This will affect anything that shares the same
   * bcoin module, e.g. for tests when running multiple nodes
   * @param {Object} checkpoint
   * @param {Number} checkpoint.height
   * @param {Buffer} checkpoint.hash
   */

  setCustomCheckpoint(height = 0, hash) {
    assert(!hash || Buffer.isBuffer(hash), 'Must pass in a buffer for checkpoint hash')
    this.logger.info('Setting custom lastCheckpoint as %d (checkpoint=%h)', height, hash)
    this.network.lastCheckpoint = height
    if (height) {
      this.network.checkpointMap[height] = hash
      this.network.checkpoints.push({ hash, height })
      this.network.checkpoints.sort((a, b) => a.height - b.height)
    } else {
      // if lastCheckpoint height is zero then clear checkpoint map
      this.logger.debug('Empty height passed to setCustomCheckpoint')
      this.logger.debug("Clearing %s network's checkpoint map", this.network.type)
      this.network.checkpointMap = {}
      this.network.checkpoints = []
    }
  }

  /**
   * Initialize chain by comparing with an existing
   * Headers index if one exists
   * Because we only use an in-memory chain, we may need to initialize
   * the chain from saved state in the headers index if it's being persisted
   */

  async initializeChain() {
    const unlock = await this.lock.lock()
    try {
      await this._initializeChain()
    } finally {
      unlock()
    }
  }

  async _initializeChain() {
    // targetReset to false for testing chains which have this set to true
    // needs to be false to avoid extra pow checks on historical blocks
    // that aren't necessary for the header node (see Chain's getTarget method)
    this.network.pow.targetReset = false

    // get chain and header index's tips to compare state
    let chainTip = await this.client.chain.db.getTip()
    const headersTip = await this.getState()

    // if everything is fresh, we can sync as normal
    if (!headersTip) return

    // if there is no chainTip or chainTip is behind the headers height
    // then we need to rebuild the in-memory chain for contextual checks
    // and index management
    if (!chainTip || chainTip.height < headersTip.height) {
      this.logger.info('Chain state is behind header. Re-initializing...')

      // Need to set the starting entry to initialize the chain from
      // we will build the chain up from the start to the current headers tip
      let entry

      // Option 1) Chain initialized with current headers tip
      // Option 2) Start from the network's lastCheckpoint
      if (
        !this.network.lastCheckpoint || // need to catch when no lastCheckpoint for test chains
        headersTip.height <= this.network.lastCheckpoint
      ) {
        // if headers tip is historical (before last checkpoint)
        // then we can just initialize the chain with the headers tip
        this.logger.info('Headers tip before last checkpoint. Re-initializing chain at tip: %d', headersTip.height)

        // start at one less of the height to set a prevBlock
        entry = await this.getHeader(headersTip.height - 1)
      } else {
        // otherwise first entry in the chain should be the last checkpoint
        this.logger.info('Re-initializing chain from last checkpoint: %d', this.network.lastCheckpoint)
        // TODO: Test if this is necessary if we never run getBlocks from Pool.
        // Currently we need the chain going back to the last checkpoint because of
        // orphan checks when we run getBlocks (which happens when checkpoints gets
        // turned off) since the chain history seems to be needed.
        // question is if we can keep checkpoints on for the whole chain without
        // risking orphans and reorgs?
        entry = await this.getHeader(this.network.lastCheckpoint)
      }

      // add entries until chain is caught up to the header index
      while (entry && entry.height <= headersTip.height) {
        this.logger.debug('Re-indexing block entry %d to chain: %h', entry.height, entry.hash)

        await this.addEntryToChain(entry)
        // increment to the next entry
        entry = await this.getHeader(entry.height + 1)
      }

      // reset the chain once the db is loaded
      await this.client.chain.close()
      await this.client.chain.open()

      this.logger.info('ChainDB successfully re-initialized to headers tip.')
    }
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
    const header = Headers.fromEntry(entry)
    const height = entry.height

    const b = this.db.batch()

    // save block header
    // if block is historical (i.e. older than last checkpoint)
    // we can save the header. Otherwise need to save the
    // whole entry so the chain can be replayed from that point
    const prev = { height: header.height - 1 } // only need height for checking isHistorical
    if (this.isHistorical(prev)) b.put(layout.b.encode(height), header.toRaw())
    else b.put(layout.b.encode(height), entry.toRaw())

    return b.write()
  }

  /**
   * Remove header from index.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   */

  async unindexBlock(entry) {
    const b = this.db.batch()
    const height = entry.height

    b.del(layout.b.encode(height))

    return b.write()
  }

  /**
   * locator code is mostly from bcoin's chain.getLocator
   * Calculate chain locator (an array of hashes).
   * Need this to override chain's getLocator to account for custom startTip
   * which means we have no history earlier than that block which breaks
   * the normal getLocator
   * @param {Hash?} start - Height or hash to treat as the tip.
   * The current tip will be used if not present. Note that this can be a
   * non-existent hash, which is useful for headers-first locators.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getLocator(start) {
    const unlock = await this.lock.lock()
    try {
      return await this._getLocator(start)
    } finally {
      unlock()
    }
  }

  /**
   * Calculate chain locator without a lock.
   * Last locator should be genesis _or_ startHeight
   * if there is one
   * @private
   * @param {Hash?} start
   * @returns {Hash[]} hashes - array of entry hashs
   */
  async _getLocator(start) {
    let entry
    if (start == null) {
      entry = await this.getHeader(this.state.height)
      start = entry.hash
    } else {
      assert(Buffer.isBuffer(start))
      entry = await this.client.chain.getEntryByHash(start)
    }

    const hashes = []
    hashes.push(start)

    let main = await this.client.chain.isMainChain(entry)
    let hash = entry.hash
    let height = entry.height
    let step = 1

    hashes.push(hash)

    // in `Chain` this is just zero. But this will break if
    // we try and get an entry older than a custom startHeight
    const end = this.startHeight ? this.startHeight : 0

    while (height > end) {
      height -= step

      if (height < end) height = end

      if (hashes.length > 10) step *= 2

      if (main) {
        // If we're on the main chain, we can
        // do a fast lookup of the hash.
        hash = await this.getHash(height)
        assert(hash)
      } else {
        const ancestor = await this.getAncestor(entry, height)
        assert(ancestor)
        main = await this.chain.isMainChain(ancestor)
        hash = ancestor.hash
      }

      hashes.push(hash)
    }

    return hashes
  }

  /**
   * Get block header by height
   * @param {height} block height
   * @returns {Headers|null} block header
   */

  async getHeader(height) {
    assert(typeof height === 'number' && height >= 0, 'Must pass valid height to get header')
    const data = await this.db.get(layout.b.encode(height))
    if (!data) return null
    return ChainEntry.fromRaw(data)
  }

  /**
   * Test whether the entry is potentially
   * an ancestor of a checkpoint.
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  isHistorical(prev) {
    return this.client.chain.isHistorical(prev)
  }

  /*
   * Simple utility to add an entry to the chain
   * with chaindb's 'reconnect'
   */
  async addEntryToChain(entry) {
    // `reconnect` needs a block. The AbstractBlock class
    // that Headers inherits from should be sufficient
    const block = Headers.fromHead(entry.toRaw())
    block.txs = []

    // chaindb's reconnect will make the updates to the
    // the chain state that we need to catch up
    await this.client.chain.db.reconnect(entry, block, new CoinView())
  }

  /*
   * Takes a ChainEntry and derives a block so that it can index
   * the block and set a new tip
   * @param {ChainEntry} entry - chain entry to index
   */
  async indexEntryBlock(entry) {
    this.logger.debug('Indexing entry block: %h', entry.hash)
    const block = Headers.fromHead(entry.toRaw())
    await this.indexBlock(entry, block, new CoinView())
    const tip = BlockMeta.fromEntry(entry)
    await this.setTip(tip)
  }

  /**
   * Get the hash of a block by height. Note that this
   * will only return hashes in the main chain.
   * @param {Number} height
   * @returns {Promise} - Returns {@link Hash}.
   */

  async getHash(height) {
    if (Buffer.isBuffer(height)) return height

    assert(typeof height === 'number')

    if (height < 0) return null

    // NOTE: indexer has no cache
    // this.getHash is replacing functionality normally done by the chain
    // which does cacheing for performance improvement
    // this would be a good target for future optimization of the header chain

    // const entry = this.cacheHeight.get(height);

    // if (entry)
    //   return entry.hash;

    return this.db.get(layout.h.encode(height))
  }

  /**
   * Get index tip.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async getTip() {
    let state = this.state

    // sometimes getTip is used before this.state has been initialized
    if (!state.height) state = await this.getState()
    const tip = await this.getBlock(state.height)

    if (!tip) throw new Error('Indexer: Tip not found!')

    return tip
  }
}

/*
 * Helpers
 */

function toBuff(hash) {
  return Buffer.from(hash, 'hex')
}

module.exports = HeaderIndexer
