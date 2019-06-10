'use strict'

const bdb = require('bdb')
const assert = require('bsert')
const bio = require('bufio')
const { Lock } = require('bmutex')
const { Indexer, Headers, ChainEntry, CoinView, util } = require('bcoin')
const { BlockMeta } = require('./records')
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
    this.checkpoints = this.chain.options.checkpoints
    this.locker = new Lock()
    this.bound = []
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
      this.network = this.chain.network
    }

    if (options.startHeight) {
      assert(typeof options.startHeight === 'number')
      this.startHeight = options.startHeight
    } else {
      // always need to initialize a startHeight so set to genesis if none is passed
      // this will get overriden later if one has been saved in the database already
      // or below if a startTip is passed
      this.startHeight = 0
    }

    // start tip will take precedence over startHeight
    if (options.startTip) {
      assert(options.startTip.length >= 2, 'Chain tip array must have two items to initiate block')

      // check that we have two buffers for chain tip
      for (let raw of options.startTip) {
        assert(Buffer.isBuffer(raw), 'Chain tip items must be buffers')
      }

      // start entry is the last in the tip field since we need a previous block
      // to pass contextual chain checks
      const startEntry = ChainEntry.fromRaw(options.startTip.slice(-1)[0])

      // once everything passes, we can set our values
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
    this.logger.info('Indexer successfully loaded')
  }

  /**
   * Close the indexer, wait for the database to close,
   * unbind all events.
   * @returns {Promise}
   */

  async close() {
    await this.db.close()
    for (const [event, listener] of this.bound) this.chain.removeListener(event, listener)

    this.bound.length = 0
  }

  /**
   * Bind to chain events and save listeners for removal on close
   * @private
   */

  bind() {
    const listener = async (entry, block, view) => {
      const meta = new BlockMeta(entry.hash, entry.height)

      try {
        await this.sync(meta, block, view)
      } catch (e) {
        this.emit('error', e)
      }
    }

    for (const event of ['connect', 'disconnect', 'reset']) {
      this.bound.push([event, listener])
      this.chain.on(event, listener)
    }
  }

  /**
   * @private
   * Set custom starting entry for fast(er) sync
   */

  async setStartTip() {
    const unlock = await this.locker.lock()
    try {
      // since this method is run before the `open` method where
      // there are other contextual checks that are done,
      // let's manually open the indexer db to initialize starting tip
      if (!this.db.loaded) await this.db.open()
      this.start() // batch db write operations
      await this._setStartTip()
      this.commit()
    } finally {
      unlock()
      if (this.db.loaded) await this.db.close()
    }
  }

  async _setStartTip() {
    // first need to see if a start height was already saved in the db
    this.logger.debug('Checking database for existing starting entry')

    const startTip = await this.getStartTip()
    if (startTip) {
      const startEntry = ChainEntry.fromRaw(startTip[1])

      // perform some checks on the startEntry:
      // if a start height was passed as an option and doesn't match with
      // one saved in DB, throw an error
      if (this.startHeight && startEntry.height !== this.startHeight)
        throw new Error(
          `Cannot retroactively change start height. Current start height is ${
            startEntry.height
          }. Delete indexer database to reset with new start height or remove config to use existing.`
        )
      else if (this.startHeight && this.startHeight === startEntry.height)
        this.logger.spam(`Start height already set at block ${startEntry.height}.`)
      else this.logger.info(`Starting block for header chain initializing to ${startEntry.height}`)

      // if checks have completed, we can initialize the start tip in the db
      await this.initStartTip(startTip)

      // set indexer's start tip and start height for reference
      this.startHeight = startEntry.height
      this.startTip = startTip

      // if we had a startTip then we're done and can return
      return
    }

    // if no custom startTip or startHeight then we can skip and sync from genesis
    if (!this.startTip && !this.startHeight) {
      this.startHeight = 0
      return
    }

    // validate the startHeight that has been set correctly
    // will throw on any validation errors and should end startup
    this.validateStartHeight(this.startHeight)

    // Next, if we have a startHeight but no startTip, we can "cheat" by using an external api
    // to retrieve the block header information for mainnet and testnet blocks.
    // This is not a trustless approach but is easier to bootstrap.
    // startTip will take precedence if one is set however and the chain won't be able to sync
    // if initialized with "fake" blocks
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

    // Next, validate and init starting tip in db
    const tipEntries = await this.initStartTip(this.startTip)

    // get last two items for the prev and tip to index and set indexer state
    const [prev, tip] = tipEntries.slice(-2)

    // need to set the indexer state so that the tip can be properly read and set
    this.height = tip.height
    this.startHeight = tip.height

    // save the starting height in the database for re-starting later
    // this value is checked in getStartTip which is called at the beginning of this method
    // TODO: would be nice if this was in records.js for reading and writing from buffer/database
    const bw = bio.write()
    bw.writeU32(this.startHeight)
    await this.db.put(layout.s.encode(), bw.render())

    // also need to add the entry to the header index if it doesn't exist
    // this will index the entry and set the tip
    if (!(await this.getHeader(prev.height))) await this.indexEntryBlock(prev)
    if (!(await this.getHeader(tip.height))) await this.indexEntryBlock(tip)

    // closing and re-opening the chain will reset the state
    // based on the custom starting tip
    await this.chain.close()
    await this.chain.open()
  }

  /*
   * @private
   * check the headers index database for an existing start tip.
   * @returns {null|Buffer[]} - null if no start height set otherwise an array
   * of two items with the two starting entries
   */

  async getStartTip() {
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
  }

  /**
   * @private
   * verify start tip or height to confirm it passes the minimum threshold
   * MUST be called after this.network has been set
   * @param {ChainEntry | Number} entryOrHeight
   * @returns {void|Boolean} throws on any invalidations otherwise re
   */

  validateStartHeight(height) {
    assert(typeof height === 'number', 'Must pass a number as the start height to verify')

    const { lastCheckpoint } = this.network

    // cannot be genesis (this is default anyway though)
    assert(height >= 0, 'Custom start height must be a positive integer')

    // must be less than last checkpoint
    // must qualify as historical with at least one retarget interval occuring between height and lastCheckpoint
    if (lastCheckpoint)
      assert(
        this.isHistorical(height),
        `Starting entry height ${height} is too high. Must be before the lastCheckpoint (${lastCheckpoint}) ` +
          `and a retargetting interval. Recommended max start height: ${this.getHistoricalPoint()}`
      )

    return true
  }

  /**
   * @private
   * initialize a startTip by running some validations and adding it to the db
   * This will validate the startTip argument and add them to the chain db
   * @param {ChainEntry[]} startTip - an array of at least two raw chain entries
   * @returns {<Promise>} entry - eventually resolves to array of tip entries
   */

  async initStartTip(startTip) {
    // when chain is reset and the tip is not
    // the genesis block, chain will check to see if
    // it can find the previous block for the tip.
    // this means that for a custom start, we need two
    // entries: the tip to start from, and the previous entry
    assert(Array.isArray(startTip) && startTip.length >= 2, 'Need at least two blocks for custom start tip')

    // need the chain db to be open so that we can set the tip there to match the indexer
    assert(this.chain.opened, 'Chain should be opened to set the header index tip')

    const tip = [] // store an array of serialized entries to return if everything is successful

    let entry, prev
    for (let raw of startTip) {
      prev = entry ? entry : null
      try {
        // this will fail if serialization is wrong (i.e. not an entry buffer) or if data is not a Buffer
        entry = ChainEntry.fromRaw(raw)
      } catch (e) {
        if (e.type === 'EncodingError')
          throw new Error(
            'headerindexer: There was a problem deserializing data. Must pass a block or chain entry buffer to start fast sync.'
          )
        throw e
      }

      this.validateStartHeight(entry.height)

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

      // and then add the entries to the chaindb with reconnect
      // note that this won't update the chain object, just its db
      await this.addEntryToChain(entry)
      tip.push(entry)
    }
    return tip
  }

  /**
   * Initialize chain by comparing with an existing
   * Headers index if one exists
   * Because we only use an in-memory chain, we may need to initialize
   * the chain from saved state in the headers index if it's being persisted
   */

  async initializeChain() {
    const unlock = await this.locker.lock()
    try {
      await this._initializeChain()
    } finally {
      unlock()
    }
  }

  async _initializeChain() {
    const indexerHeight = await this.height

    // if everything is fresh, we can sync as normal
    if (!indexerHeight) return

    // get chain tip to compare w/ headers index
    let chainTip = await this.chain.db.getTip()

    // if there is no chainTip or chainTip is behind the headers height
    // then we need to rebuild the in-memory chain for contextual checks
    // and index management
    if (!chainTip || chainTip.height < indexerHeight) {
      this.logger.info('Chain state is behind header. Re-initializing...')

      // Need to set the starting entry to initialize the chain from.
      // Option 1) If tip is before historical point, then we will re-intialize chain from the startHeight
      // Option 2) If there's no lastCheckpoint (e.g. regtest), re-initialize from genesis
      // Option 3) When header tip is not historical, the chain still needs to be initialized to
      // start from first non-historical block for contextual checks (e.g. pow)
      let entry
      if (this.isHistorical(indexerHeight)) {
        this.logger.debug(
          'Headers tip before last checkpoint. Re-initializing chain from start height: %d',
          this.startHeight
        )

        entry = await this.getEntry(this.startHeight)
      } else if (!this.network.lastCheckpoint) {
        this.logger.info('Re-initializing chain db from genesis block')
        // since the genesis block will be hard-coded in, we actually will be initializing from block #1
        // but first run sanity check that we have a genesis block
        assert(this.network.genesisBlock, `Could not find a genesis block for ${this.network.type}`)
        entry = await this.getEntry(1)
      } else {
        // otherwise first entry in the chain should be the first "non-historical" block
        this.logger.info('Re-initializing chain from last historical block: %d', this.getHistoricalPoint())
        entry = await this.getHeader(this.getHistoricalPoint() + 1)
      }

      // add entries until chain is caught up to the header index
      while (entry && entry.height <= indexerHeight) {
        this.logger.spam('Re-indexing block entry %d to chain: %h', entry.height, entry.hash)
        await this.addEntryToChain(entry)
        // increment to the next entry
        entry = await this.getEntry(entry.height + 1)
      }

      // reset the chain once the db is loaded
      await this.chain.close()
      await this.chain.open()

      this.logger.info('ChainDB successfully re-initialized to headers tip.')
    }
  }

  /**
   * Add a block's transactions without a lock.
   * modified addBlock from parent class
   * @private
   * @param {BlockMeta} meta
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise}
   */

  async _addBlock(meta, block, view) {
    // removed hasRaw check for block from parent classe since we are in spv mode,
    // which we use for header node, we get merkleblocks which don't have
    // the `hasRaw` method and the check is for tx serialization anyway
    const start = util.bench()

    if (meta.height !== this.height + 1) throw new Error('Indexer: Can not add block.')

    // Start the batch write.
    this.start()

    // Call the implemented indexer to add to
    // the batch write.
    await this.indexBlock(meta, block, view)

    // Sync the height to the new tip.
    const height = await this._setTip(meta)

    // Commit the write batch to disk.
    await this.commit()

    // Update height _after_ successful commit.
    this.height = height

    // Log the current indexer status.
    this.logStatus(start, block, meta)
  }

  /**
   * add header to index.
   * @private
   * @param {ChainEntry} entry for block to chain
   * @param {Block} block - Block to index
   * @param {CoinView} view - Coin View
   * @returns {Promise} returns promise
   */
  async indexBlock(meta, block) {
    const height = meta.height

    // save block header
    // if block is historical (i.e. older than last checkpoint w/ at least one retarget interval)
    // we can save the header. Otherwise need to save the
    // whole entry so the chain can be replayed from that point
    if (this.isHistorical(height)) {
      const header = Headers.fromBlock(block)
      this.put(layout.b.encode(height), header.toRaw())
    } else {
      const prev = await this.chain.getEntry(height - 1)
      const entry = ChainEntry.fromBlock(block, prev)
      this.put(layout.b.encode(height), entry.toRaw())
    }
  }

  /**
   * Remove header from index.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   */

  async unindexBlock(meta) {
    const height = meta.height

    this.del(layout.b.encode(height))
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
    const unlock = await this.locker.lock()
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
      entry = await this.getEntry(this.height)
    } else {
      assert(Buffer.isBuffer(start))
      entry = await this.chain.getEntryByHash(start)
    }
    const hashes = []

    let main = await this.chain.isMainChain(entry)
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
        const ancestor = await this.chain.getAncestor(entry, height)
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
    if (this.isHistorical(height)) return Headers.fromRaw(data)
    return ChainEntry.fromRaw(data)
  }

  /**
   * Get block entry by height or hash
   * Overwrites the parent method which only handles by hash
   * If passed a height then it can convert a header to entry for
   * historical blocks which don't have an entry available
   * @param {Number|Buffer} height or hash - block height or hash
   * @returns {Headers|null} block entry
   */
  async getEntry(heightOrHash) {
    // indexer checks the chain db first by default
    // we can use that first and use header indexer
    // if none is found in the chain db (since it is not persisted)
    const entry = await super.getEntry(heightOrHash)
    if (entry) return entry

    let header = await this.getHeader(heightOrHash)

    // return null if none exists
    if (!header) return null

    // if it is already a chainentry then we can return it
    if (ChainEntry.isChainEntry(header)) return header
    let { height } = header

    if (!height) height = heightOrHash

    assert(typeof height === 'number')

    // otherwise convert to an entry by getting JSON w/ correct height
    // and adding a null chainwork (needed for entry initialization)
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
    await this.chain.db.reconnect(entry, block, new CoinView())
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
    await this._setTip(tip)
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
    let height = this.height
    assert(height, 'Cannot get headers tip until indexer has been initialized and synced')

    // in some instances when this has been run the indexer hasn't had a chance to
    // catch up to the chain and re-index a block, so we need to rollforward to the tip
    if (height < this.chain.height) {
      await this._rollforward()
      height = this.height
    }

    const tip = await this.getHeader(height)

    if (!tip) throw new Error('Indexer: Tip not found!')

    return tip
  }
}

module.exports = HeaderIndexer
