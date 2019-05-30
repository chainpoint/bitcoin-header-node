'use strict'

const bdb = require('bdb')
const assert = require('bsert')
const bio = require('bufio')
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
    if (!options.network) {
      // Without this, the base indexer defaults to mainnet if no
      // network is set even if chain has a different network
      // NOTE: This must be the first option set in `fromOptions`
      // since other configs (e.g. startHeight and startTip) rely on it
      this.network = this.client.network
    }

    if (options.startHeight) {
      assert(typeof options.startHeight === 'number')
      // in order to support start heights that are within a retargetting range
      // i.e. lastCheckpoint - (lastCheckpoint % retargetInterval)
      // we need to make sure to start indexing from the lastRetarget that is
      // before the lastCheckpoint
      const startIsValid = this.validateStartHeight(options.startHeight)

      if (!startIsValid)
        this.startHeight = options.startHeight - (options.startHeight % this.network.pow.retargetInterval)
      else this.startHeight = options.startHeight
    }

    // start tip will take precedence over startHeight
    if (options.startTip) {
      assert(options.startTip.length >= 2, 'Chain tip array must have two items to initiate block')

      // check that we hvae two buffers for chain tip
      for (let i = 0; i < 2; i++) {
        const raw = options.startTip[i]
        assert(Buffer.isBuffer(raw), 'Chain tip items must be buffers')
      }

      const { lastCheckpoint } = this.network

      // start entry is the second in the tip field since we need a previous block
      // to pass contextual chain checks
      const startEntry = ChainEntry.fromRaw(options.startTip[1])
      const startIsValid = this.validateStartHeight(startEntry.height)
      const maxStart = this.getHistoricalPoint()

      if (!startIsValid)
        throw new Error(
          `Starting entry height ${
            startEntry.height
          } is too high. Must be no higher than the lastCheckpoint (${lastCheckpoint}) ` +
            `and before a retargetting interval. Recommended max start height: ${maxStart}`
        )

      this.startTip = options.startTip
      this.startHeight = startEntry.height
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
   * verify start tip or height to confirm it passes the minimum threshold
   * MUST be called after this.network has been set
   * @param {ChainEntry | Number} entryOrHeight
   * @returns {Boolean} returns true if valid and false if invalid
   */

  validateStartHeight(height) {
    assert(typeof height === 'number', 'Must pass a number as the start height to verify')

    const { lastCheckpoint } = this.network

    assert(height >= 0, 'Custom start height must be a positive integer')

    if (lastCheckpoint)
      assert(
        height < lastCheckpoint,
        `Custom start height must be a historical block, i.e. less than last checkpoint ${lastCheckpoint}`
      )

    return this.isHistorical(height)
  }

  /**
   * @private
   * Set custom starting entry for fast sync
   */

  async setStartTip() {
    const unlock = await this.lock.lock()
    try {
      await this._setStartTip()
    } finally {
      unlock()
      if (this.db.loaded) await this.db.close()
    }
  }

  async _setStartTip() {
    // first need to see if a start height was already saved in the db
    try {
      this.logger.debug('Checking database for existing starting entry')

      const startTip = await this.getStartTip()
      if (startTip) {
        const prevEntry = ChainEntry.fromRaw(startTip[0])
        const startEntry = ChainEntry.fromRaw(startTip[1])

        // perform some checks on the startEntry

        // if a start height was passed as an option and doesn't match with
        // one saved in DB, throw an error
        if (this.startHeight && startEntry.height !== this.startHeight)
          throw new Error(
            `Cannot retroactively change start height. Current start height is ${
              startEntry.height
            }. Delete indexer database to reset with new start height.`
          )
        else if (this.startHeight && this.startHeight === startEntry.height)
          this.logger.spam(`Start height already set at block ${startEntry.height}.`)
        else this.logger.info(`Starting block for header chain initializing to ${startEntry.height}`)

        this.startHeight = startEntry.height
        this.startTip = startTip

        // add the entries to the chain db so chain can be initialized properly
        await this.addEntryToChain(prevEntry)
        await this.addEntryToChain(startEntry)
        // if we had a startTip then we're done and can return
        return
      }
    } catch (e) {
      this.logger.error('Problem initializing start tip: %s', e.message)
    }

    // Next, if we have a startHeight but no startTip, we can "cheat" by using an external api
    // from blockcypher to retrieve the block header information for mainnet
    // and testnet blocks. This is not a trustless approach but is easier to bootstrap.
    // startTip will take precedence if one is set however
    if (this.startHeight && !this.startTip) {
      assert(
        this.network.type === 'main' || this.network.type === 'testnet',
        'Can only get starting block data for mainnet or testnet. Use `startTip` \
        with raw block data instead for other networks'
      )

      const entries = await getRemoteBlockEntries(this.network.type, this.startHeight - 1, this.startHeight)

      this.logger.info('Setting custom start height at %d', this.startHeight)
      this.startTip = entries
    }

    // if no custom startTip then we can skip and sync from genesis
    if (!this.startTip) {
      this.startHeight = 0
      return
    }

    // Next, we need to verify the starting entries and then add them to chain database

    // when chain is reset and the tip is not
    // the genesis block, chain will check to see if
    // it can find the previous block for the tip.
    // this means that for a custom start, we need two
    // entries: the tip to start from, and the previous entry
    assert(Array.isArray(this.startTip) && this.startTip.length >= 2, 'Need at least two blocks for custom start tip')

    // since this method is run before the `open` method where
    // there are other contextual checks that are done,
    // let's manually open the indexer db to initialize starting tip
    if (!this.db.loaded) await this.db.open()

    // need the chain db to be open so that we can set the tip there to match the indexer
    assert(this.client.chain.opened, 'Chain should be opened to set the header index tip')

    let entry, prev
    for (let raw of this.startTip) {
      assert(Buffer.isBuffer(raw), 'Start must be a Buffer')
      prev = entry ? entry : null
      try {
        entry = ChainEntry.fromRaw(raw)
      } catch (e) {
        if (e.type === 'EncodingError')
          throw new Error(
            'headerindexer: There was a problem deserializing data. Must pass a block or chain entry buffer to start fast sync.'
          )
        throw e
      }

      assert(entry.height > 0, 'Cannot pass Genesis block as custom start tip')

      // confirm that the starter tip is made up of incrementing blocks
      // i.e. prevBlock hash matches hash of previous block in array
      if (prev) {
        assert.equal(
          entry.prevBlock.toString('hex'),
          prev.hash.toString('hex'),
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

      // and then add the entries to the chaindb with reconnect
      // note that this won't update the chain object, just its db
      await this.addEntryToChain(entry)
    }

    // need to set the indexer state so that the tip can be properly read and set
    this.state = new ChainState()
    this.state.height = entry.height
    this.state.startHeight = entry.height
    this.startHeight = entry.height

    // save the starting entries in the database for re-starting later
    // TODO: this should be in records for reading and writing from buffer/database
    const bw = bio.write()
    bw.writeU32(this.startHeight)
    await this.db.put(layout.s.encode(), bw.render())

    // also need to add the entry to the header index if it doesn't exist
    // this will index the entry and set the tip
    if (!(await this.getHeader(prev.height))) await this.indexEntryBlock(prev)
    if (!(await this.getHeader(entry.height))) await this.indexEntryBlock(entry)

    // closing and re-opening the chain will reset the state
    // based on the custom starting tip
    await this.client.chain.close()
    await this.client.chain.open()

    // re-close the database once the tip has been set
    await this.db.close()
  }

  /*
   * check the headers index database for an existing start tip
   * @returns {null|Buffer[]} - null if no start height set otherwise an array
   * of two items with the two starting entries
   */

  async getStartTip() {
    try {
      if (!this.db.loaded) await this.db.open()
      const data = await this.db.get(layout.s.encode())

      // if no height is saved then return null
      if (!data) return null

      // convert data buffer to U32
      const buffReader = bio.read(data)
      const startHeight = buffReader.readU32()
      let startEntry = await this.getEntry(startHeight)
      assert(startEntry, `Could not find an entry in database for starting height ${startHeight}`)

      // Need to also get a prevEntry which is necessary for contextual checks of an entry
      const prevEntry = await this.getEntry(startHeight - 1)
      assert(prevEntry, `No entry in db for starting block's previous entry at: ${startHeight - 1}`)

      return [prevEntry.toRaw(), startEntry.toRaw()]
    } finally {
      if (this.db.loaded) await this.db.close()
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
    const headersTip = await this.getState()

    // if everything is fresh, we can sync as normal
    if (!headersTip) return

    // get chain tip to compare w/ headers index
    let chainTip = await this.client.chain.db.getTip()

    // if there is no chainTip or chainTip is behind the headers height
    // then we need to rebuild the in-memory chain for contextual checks
    // and index management
    if (!chainTip || chainTip.height < headersTip.height) {
      this.logger.info('Chain state is behind header. Re-initializing...')

      // Need to set the starting entry to initialize the chain from.
      // Option 1) If tip is before historical point, then we will re-intialize chain from the startHeight
      // Option 2) If there's no lastCheckpoint (e.g. regtest), re-initialize from genesis
      // Option 3) When header tip is not historical, the chain still needs to be initialized to
      // start from first non-historical block for contextual checks (e.g. pow)
      let entry
      if (this.isHistorical(headersTip.height)) {
        this.logger.debug(
          'Headers tip before last checkpoint. Re-initializing chain from start height: %d',
          this.startHeight
        )
        // TODO: Confirm this change works
        // entry = await this.client.chain.getEntry(this.startHeight)
        entry = await this.getEntry(this.startHeight)
      } else if (!this.network.lastCheckpoint) {
        this.logger.info('Re-initializing chain db from genesis block')
        // since the genesis block will be hard coded in, we actually will be initializing from block #1
        // but first confirm that we have a genesis block first
        assert(this.network.genesisBlock, `Could not find a genesis block for ${this.network.type}`)
        entry = await this.getEntry(1)
      } else {
        // otherwise first entry in the chain should be the first "non-historical" block
        this.logger.info('Re-initializing chain from last historical block: %d', this.getHistoricalPoint())
        entry = await this.getHeader(this.getHistoricalPoint() + 1)
      }

      // add entries until chain is caught up to the header index
      while (entry && entry.height <= headersTip.height) {
        this.logger.spam('Re-indexing block entry %d to chain: %h', entry.height, entry.hash)
        await this.addEntryToChain(entry)
        // increment to the next entry
        entry = await this.getEntry(entry.height + 1)
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
    const height = entry.height
    const b = this.db.batch()

    // save block header
    // if block is historical (i.e. older than last checkpoint w/ at least one retarget interval)
    // we can save the header. Otherwise need to save the
    // whole entry so the chain can be replayed from that point
    if (this.isHistorical(height)) {
      const header = Headers.fromEntry(entry)
      b.put(layout.b.encode(height), header.toRaw())
    } else b.put(layout.b.encode(height), entry.toRaw())

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
   * Connect and sync with the chain server.
   * Somewhat different from parent since
   * if our tip is still historical then we won't have chain entries
   * but we can still be reasonably sure we're on the right height
   * @private
   * @returns {Promise}
   */

  async syncChain() {
    let height = this.state.height

    // if current height is no longer historical or is genesis then we should
    // have chain entries available and can use the default syncChain
    if (!this.isHistorical(height) || !height) return super.syncChain()

    // otherwise, let's just compare to what we have in our headers db
    for (;;) {
      const tip = await this.getHeader(height)
      assert(tip)

      // if we have a header at the previous height then we should be good
      if (await this.getHeader(height - 1)) break

      assert(height !== 0)
      height -= 1
    }

    if (this.state.startHeight < height) height = this.state.startHeight

    this.logger.spam('Starting block rescan from: %d.', height)
    return this.scan(height)
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
      entry = await this.getEntry(this.state.height)
    } else {
      assert(Buffer.isBuffer(start))
      entry = await this.client.chain.getEntryByHash(start)
    }
    const hashes = []

    let main = await this.client.chain.isMainChain(entry)
    let hash = entry.hash
    let height = entry.height
    let step = 1

    hashes.push(hash)

    // in `Chain` this is just zero. But this will break if
    // we try and get an entry older than the historical point
    const end = this.startHeight

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
        const ancestor = await this.client.chain.getAncestor(entry, height)
        assert(ancestor)
        main = await this.client.chain.isMainChain(ancestor)
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
    if (this.isHistorical(height)) return Headers.fromRaw(data)
    return ChainEntry.fromRaw(data)
  }

  async getEntry(height) {
    let header = await this.getHeader(height)

    // return null if none exists
    if (!header) return null

    // if it is already a chainentry then we can return it
    if (ChainEntry.isChainEntry(header)) return header

    // otherwise convert to an entry by getting JSON w/ correct height
    // and adding an null chainwork (needed for entry initialization)
    header = header.getJSON(this.network.type, null, height)
    header.chainwork = '0'
    return ChainEntry.fromJSON(header)
  }
  /**
   * Test whether the entry is potentially an ancestor of a checkpoint.
   * This is adapted from the chain's "isHistorical"
   * but to account for custom startHeights. Historical in this case is shifted to be before
   * the last retarget before the lastCheckpoint since chain needs at least 1 retargeted entry
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  isHistorical(height) {
    if (this.checkpoints) {
      // in the case where there is no lastCheckpoint then we just set to zero
      const historicalPoint = this.getHistoricalPoint()
      if (height <= historicalPoint) return true
    }
    return false
  }

  getHistoricalPoint() {
    const {
      lastCheckpoint,
      pow: { retargetInterval }
    } = this.network
    // in the case where there is no lastCheckpoint then we just set to zero
    return lastCheckpoint ? lastCheckpoint - (lastCheckpoint % retargetInterval) : 0
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
    this.logger.debug('Indexing entry block %d: %h', entry.height, entry.hash)
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

module.exports = HeaderIndexer
