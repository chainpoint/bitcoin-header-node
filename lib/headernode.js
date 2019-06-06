/*!
 * headernode.js - header node for bcoin based on
 * spv node from bcoin
 */

'use strict'

const assert = require('bsert')
const { Chain, Node, blockstore } = require('bcoin')

const HTTP = require('./http')
const RPC = require('./rpc')
const HeaderIndexer = require('./headerindexer')
const HeaderPool = require('./headerpool')

/**
 * Header Node
 * Create a headernode which only maintains
 * an in-memory chain, a pool, a headers index and an http server.
 * @alias module:node.HeaderNode
 * @extends Node
 */

class HeaderNode extends Node {
  /**
   * Create Headers node.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super('bcoin', 'bcoin.conf', 'debug.log', options)

    this.opened = false

    // setting spv and checkpoints flag since
    // we will want the same/similar behavior
    // where applicable on chain and pool
    this.spv = false
    this.checkpoints = true
    this.memory = true

    // Instantiate block storage.
    this.blocks = blockstore.create({
      network: this.network,
      logger: this.logger,
      prefix: this.config.prefix,
      cacheSize: this.config.mb('block-cache-size'),
      memory: this.memory
    })

    // Instantiate blockchain.
    // Chain needs access to blocks.
    this.chain = new Chain({
      network: this.network,
      logger: this.logger,
      blocks: this.blocks,
      workers: this.workers,
      memory: this.memory,
      prefix: this.config.prefix,
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      forceFlags: this.config.bool('force-flags'),
      bip91: this.config.bool('bip91'),
      bip148: this.config.bool('bip148'),
      prune: this.config.bool('prune'),
      checkpoints: this.checkpoints,
      entryCache: this.config.uint('entry-cache')
    })

    this.headerindex = new HeaderIndexer({
      network: this.network,
      logger: this.logger,
      blocks: this.blocks,
      chain: this.chain,
      memory: this.config.bool('memory'),
      prefix: this.config.filter('index').str('prefix') || this.config.prefix,
      startTip: this.config.array('start-tip'),
      startHeight: this.config.int('start-height')
    })

    this.pool = new HeaderPool({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      prefix: this.config.prefix,
      selfish: true,
      compact: false,
      bip37: false,
      maxOutbound: this.config.uint('max-outbound'),
      maxInbound: this.config.uint('max-inbound'),
      createSocket: this.config.func('create-socket'),
      proxy: this.config.str('proxy'),
      onion: this.config.bool('onion'),
      upnp: this.config.bool('upnp'),
      seeds: this.config.array('seeds'),
      nodes: this.config.array('nodes'),
      only: this.config.array('only'),
      publicHost: this.config.str('public-host'),
      publicPort: this.config.uint('public-port'),
      host: this.config.str('host'),
      port: this.config.uint('port'),
      listen: false,
      memory: this.config.bool('memory'),
      headerindex: this.headerindex
    })

    this.rpc = new RPC(this)

    this.http = new HTTP({
      network: this.network,
      logger: this.logger,
      node: this,
      prefix: this.config.prefix,
      ssl: this.config.bool('ssl'),
      keyFile: this.config.path('ssl-key'),
      certFile: this.config.path('ssl-cert'),
      host: this.config.str('http-host'),
      port: this.config.uint('http-port'),
      apiKey: this.config.str('api-key'),
      noAuth: this.config.bool('no-auth'),
      cors: this.config.bool('cors')
    })

    this.init()
  }

  /**
   * Initialize the node.
   * @private
   */

  init() {
    // Bind to errors
    this.chain.on('error', err => this.error(err.stack))
    this.pool.on('error', err => this.error(err.stack))

    if (this.http) this.http.on('error', err => this.error(err.stack))

    if (this.headerindex) this.headerindex.on('error', err => this.error(err))

    this.chain.on('block', block => this.emit('block', block))

    this.chain.on('connect', async (entry, block) => {
      this.emit('block', block)
      this.emit('connect', entry, block)
    })

    this.chain.on('disconnect', (entry, block) => {
      this.emit('disconnect', entry, block)
    })

    this.chain.on('reorganize', (tip, competitor) => {
      this.emit('reorganize', tip, competitor)
    })

    this.chain.on('reset', tip => this.emit('reset', tip))
  }

  /**
   * Open the node and all its child objects,
   * wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'HeaderNode is already open.')
    this.opened = true

    await this.handlePreopen()
    await this.blocks.open()
    await this.chain.open()
    await this.headerindex.open()
    await this.pool.open()
    await this.openPlugins()
    await this.http.open()
    await this.handleOpen()

    this.logger.info('Node is loaded.')
  }

  /**
   * Close the node, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'HeaderNode is not open.')
    this.opened = false

    await this.handlePreclose()
    if (this.http.opened) await this.http.close()

    await this.closePlugins()
    await this.headerindex.close()
    await this.pool.close()
    await this.chain.close()
    await this.blocks.close()
    await this.handleClose()
  }

  /**
   * Connect to the network.
   * @returns {Promise}
   */

  connect() {
    return this.pool.connect()
  }

  /**
   * Disconnect from the network.
   * @returns {Promise}
   */

  disconnect() {
    return this.pool.disconnect()
  }

  /**
   * Start the blockchain sync.
   */

  async startSync() {
    this.headerindex.sync()
    return this.pool.startSync()
  }

  /**
   * Stop syncing the blockchain.
   */

  stopSync() {
    return this.pool.stopSync()
  }

  /**
   * Retrieve a block header from the header index.
   * @param {Height} height
   * @returns {Promise} - Returns {@link Headers}.
   */

  getHeader(height) {
    return this.headerindex.getHeader(height)
  }

  /**
   * Get header index tip
   * @returns {Promise} - Returns {@link Headers}.
   */

  getTip() {
    return this.headerindex.getTip()
  }

  /**
   * Get indexer start height
   * @returns {Promise} - Returns {@link Headers}.
   */

  getStartHeight() {
    return this.headerindex.startHeight
  }
}

/*
 * Expose
 */

module.exports = HeaderNode
