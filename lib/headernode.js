/*!
 * headernode.js - header node for bcoin based on
 * spv node from bcoin
 */

'use strict';

const assert = require('bsert');
// TODO: make own custom HTTP/RPC that extends defaults for new commands
const { Chain, Node } = require('bcoin');

const HTTP = require('./http');
const RPC = require('./rpc');
const HeaderIndexer = require('./headerindexer');
const ChainClient = require('./spvchainclient');
const HeaderPool = require('./headerpool');

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
   * @param {Buffer?} options.sslKey
   * @param {Buffer?} options.sslCert
   * @param {Number?} options.httpPort
   * @param {String?} options.httpHost
   */

  constructor(options) {
    super('bcoin', 'bcoin.conf', 'debug.log', options);

    this.opened = false;

    // setting spv and checkpoints flag since
    // we will want the same/similar behavior
    // where applicable on chain and pool
    this.spv = true;
    this.checkpoints = true;

    // Instantiate blockchain.
    this.chain = new Chain({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      memory: true, // mainly using it as a client, saving info in the indexer
      prefix: this.config.prefix,
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      forceFlags: this.config.bool('force-flags'),
      bip91: this.config.bool('bip91'),
      bip148: this.config.bool('bip148'),
      prune: this.config.bool('prune'),
      coinCache: this.config.mb('coin-cache'),
      entryCache: this.config.uint('entry-cache'),
      spv: this.spv,
      checkpoints: this.checkpoints,
    });

    this.headerindex = new HeaderIndexer({
      network: this.network,
      logger: this.logger,
      client: new ChainClient(this.chain),
      memory: this.config.bool('memory'),
      prefix: this.config.filter('index').str('prefix') || this.config.prefix,
      startTip: this.config.array('start-tip'),
      startHeight: this.config.int('start-height'),
    });

    this.pool = new HeaderPool({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      headerindex: this.headerindex,
      prefix: this.config.prefix,
      proxy: this.config.str('proxy'),
      onion: this.config.bool('onion'),
      upnp: this.config.bool('upnp'),
      seeds: this.config.array('seeds'),
      nodes: this.config.array('nodes'),
      compact: this.config.bool('compact', false),
      only: this.config.array('only'),
      maxOutbound: this.config.uint('max-outbound'),
      createSocket: this.config.func('create-socket'),
      memory: this.config.bool('memory'),
      selfish: true,
      listen: false,
      spv: this.spv,
      checkpoints: this.checkpoints,
    });

    this.rpc = new RPC(this);

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
      cors: this.config.bool('cors'),
    });

    this.init();
  }

  /**
   * Initialize the node.
   * @private
   */

  init() {
    // Bind to errors
    this.chain.on('error', err => this.error(err.stack));
    this.pool.on('error', err => this.error(err.stack));
    this.headerindex.on('error', err => this.error(err.stack));
    if (this.http) this.http.on('error', err => this.error(err.stack));

    this.pool.on('tx', tx => (!this.rescanJob ? this.emit('tx', tx) : null));

    if (this.headerindex) this.headerindex.on('error', err => this.error(err));

    this.chain.on('block', block => this.emit('block', block));

    this.chain.on('connect', async (entry, block) => {
      if (this.rescanJob) {
        try {
          await this.watchBlock(entry, block);
        } catch (e) {
          this.error(e);
        }
        return;
      }

      this.emit('connect', entry, block);
    });

    this.chain.on('disconnect', (entry, block) => {
      this.emit('disconnect', entry, block);
    });

    this.chain.on('reorganize', (tip, competitor) => {
      this.emit('reorganize', tip, competitor);
    });

    this.chain.on('reset', tip => this.emit('reset', tip));
  }

  /**
   * Open the node and all its child objects,
   * wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'HeaderNode is already open.');
    this.opened = true;
    await this.handlePreopen();

    await this.chain.open();
    await this.headerindex.open();
    await this.pool.open();
    await this.openPlugins();

    await this.http.open();
    await this.handleOpen();

    this.logger.info('Node is loaded.');
  }

  /**
   * Close the node, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'HeaderNode is not open.');
    this.opened = false;

    await this.handlePreclose();
    await this.http.close();

    await this.closePlugins();
    await this.headerindex.close();
    await this.pool.close();
    await this.chain.close();
    await this.handleClose();
  }

  /**
   * Connect to the network.
   * @returns {Promise}
   */

  connect() {
    return this.pool.connect();
  }

  /**
   * Disconnect from the network.
   * @returns {Promise}
   */

  disconnect() {
    return this.pool.disconnect();
  }

  /**
   * Start the blockchain sync.
   */

  async startSync() {
    return this.pool.startSync();
  }

  /**
   * Stop syncing the blockchain.
   */

  stopSync() {
    return this.pool.stopSync();
  }

  /**
   * Retrieve a block header from the header index.
   * @param {Height} height
   * @returns {Promise} - Returns {@link Headers}.
   */

  getHeader(height) {
    return this.headerindex.getHeaderByHeight(height);
  }

  /**
   * Get header index tip
   * @returns {Promise} - Returns {@link Headers}.
   */

  getTip() {
    return this.headerindex.getTip();
  }

  /**
   * Set custom (last) checkpoint and checkpointMap
   */

  setCustomCheckpoint(height, hash) {
    this.headerindex.setCustomCheckpoint(height, hash);
  }
}

/*
 * Expose
 */

module.exports = HeaderNode;
