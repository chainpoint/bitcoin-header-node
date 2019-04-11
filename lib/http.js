/*!
 * server.js - http server for header node
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * Copyright (c) 2019-, Tierion Inc (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const path = require('path');
const { Server } = require('bweb');
const Validator = require('bval');
const { base58 } = require('bstring');
const { BloomFilter } = require('bfilter');
const sha256 = require('bcrypto/lib/sha256');
const random = require('bcrypto/lib/random');
const { safeEqual } = require('bcrypto/lib/safe');
const util = require('./util');
const { pkg, Network } = require('bcoin');

/**
 * HTTP
 * @alias module:http.Server
 */

class HTTP extends Server {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new HTTPOptions(options));

    this.network = this.options.network;
    this.logger = this.options.logger.context('node-http');
    this.node = this.options.node;

    this.chain = this.node.chain;
    this.headerindex = this.node.headerindex;
    this.pool = this.node.pool;
    this.rpc = this.node.rpc;

    this.init();
  }

  /**
   * Initialize routes.
   * @private
   */

  init() {
    this.on('request', req => {
      if (req.method === 'POST' && req.pathname === '/') return;

      this.logger.debug(
        'Request for method=%s path=%s (%s).',
        req.method,
        req.pathname,
        req.socket.remoteAddress
      );
    });

    this.on('listening', address => {
      this.logger.info(
        'Node HTTP server listening on %s (port=%d).',
        address.address,
        address.port
      );
    });

    this.initRouter();
    this.initSockets();
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    if (this.options.cors) this.use(this.cors());

    if (!this.options.noAuth) {
      this.use(
        this.basicAuth({
          hash: sha256.digest,
          password: this.options.apiKey,
          realm: 'node',
        })
      );
    }

    this.use(
      this.bodyParser({
        type: 'json',
      })
    );

    this.use(this.jsonRPC());
    this.use(this.router());

    this.error((err, req, res) => {
      const code = err.statusCode || 500;
      res.json(code, {
        error: {
          type: err.type,
          code: err.code,
          message: err.message,
        },
      });
    });

    this.get('/', async (req, res) => {
      let addr = this.pool.hosts.getLocal();

      if (!addr) addr = this.pool.hosts.address;

      res.json(200, {
        version: pkg.version,
        network: this.network.type,
        chain: {
          height: this.chain.height,
          tip: this.chain.tip.rhash(),
          progress: this.chain.getProgress(),
        },
        pool: {
          host: addr.host,
          port: addr.port,
          agent: this.pool.options.agent,
          services: this.pool.options.services.toString(2),
          outbound: this.pool.peers.outbound,
          inbound: this.pool.peers.inbound,
        },
        time: {
          uptime: this.node.uptime(),
          system: util.now(),
          adjusted: this.network.now(),
          offset: this.network.time.offset,
        },
        memory: this.logger.memoryUsage(),
      });
    });
  }

  /**
   * Handle new websocket.
   * @private
   * @param {WebSocket} socket
   */

  handleSocket(socket) {
    socket.hook('auth', (...args) => {
      if (socket.channel('auth')) throw new Error('Already authed.');

      if (!this.options.noAuth) {
        const valid = new Validator(args);
        const key = valid.str(0, '');

        if (key.length > 255) throw new Error('Invalid API key.');

        const data = Buffer.from(key, 'ascii');
        const hash = sha256.digest(data);

        if (!safeEqual(hash, this.options.apiHash))
          throw new Error('Invalid API key.');
      }

      socket.join('auth');

      this.logger.info('Successful auth from %s.', socket.host);
      this.handleAuth(socket);

      return null;
    });

    socket.fire('version', {
      version: pkg.version,
      network: this.network.type,
    });
  }

  /**
   * Handle new auth'd websocket.
   * @private
   * @param {WebSocket} socket
   */

  handleAuth(socket) {
    socket.hook('watch chain', () => {
      socket.join('chain');
      return null;
    });

    socket.hook('unwatch chain', () => {
      socket.leave('chain');
      return null;
    });

    socket.hook('get tip', () => {
      return this.chain.tip.toRaw();
    });

    // TODO: Update for header indexer
    socket.hook('get entry', async (...args) => {
      const valid = new Validator(args);
      const block = valid.uintbrhash(0);

      if (block == null) throw new Error('Invalid parameter.');

      const entry = await this.chain.getEntry(block);

      if (!entry) return null;

      if (!(await this.chain.isMainChain(entry))) return null;

      return entry.toRaw();
    });

    socket.hook('get hashes', async (...args) => {
      const valid = new Validator(args);
      const start = valid.i32(0, -1);
      const end = valid.i32(1, -1);

      return this.chain.getHashes(start, end);
    });
  }

  /**
   * Bind to chain events.
   * @private
   */

  initSockets() {
    this.chain.on('connect', (entry, block) => {
      const sockets = this.channel('chain');

      if (!sockets) return;

      const raw = entry.toRaw();

      this.to('chain', 'chain connect', raw);

      for (const socket of sockets) {
        const txs = this.filterBlock(socket, block);
        socket.fire('block connect', raw, txs);
      }
    });

    this.chain.on('disconnect', entry => {
      const sockets = this.channel('chain');

      if (!sockets) return;

      const raw = entry.toRaw();

      this.to('chain', 'chain disconnect', raw);
      this.to('chain', 'block disconnect', raw);
    });

    this.chain.on('reset', tip => {
      const sockets = this.channel('chain');

      if (!sockets) return;

      this.to('chain', 'chain reset', tip.toRaw());
    });
  }
}

class HTTPOptions {
  /**
   * HTTPOptions
   * @alias module:http.HTTPOptions
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = null;
    this.node = null;
    this.apiKey = base58.encode(random.randomBytes(20));
    this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    this.noAuth = false;
    this.cors = false;

    this.prefix = null;
    this.host = '127.0.0.1';
    this.port = 8080;
    this.ssl = false;
    this.keyFile = null;
    this.certFile = null;

    this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  fromOptions(options) {
    assert(options);
    assert(
      options.node && typeof options.node === 'object',
      'HTTP Server requires a Node.'
    );

    this.node = options.node;
    this.network = options.node.network;
    this.logger = options.node.logger;

    this.port = this.network.rpcPort;

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.apiKey != null) {
      assert(typeof options.apiKey === 'string', 'API key must be a string.');
      assert(options.apiKey.length <= 255, 'API key must be under 256 bytes.');
      this.apiKey = options.apiKey;
      this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    }

    if (options.noAuth != null) {
      assert(typeof options.noAuth === 'boolean');
      this.noAuth = options.noAuth;
    }

    if (options.cors != null) {
      assert(typeof options.cors === 'boolean');
      this.cors = options.cors;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.keyFile = path.join(this.prefix, 'key.pem');
      this.certFile = path.join(this.prefix, 'cert.pem');
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = options.host;
    }

    if (options.port != null) {
      assert(
        (options.port & 0xffff) === options.port,
        'Port must be a number.'
      );
      this.port = options.port;
    }

    if (options.ssl != null) {
      assert(typeof options.ssl === 'boolean');
      this.ssl = options.ssl;
    }

    if (options.keyFile != null) {
      assert(typeof options.keyFile === 'string');
      this.keyFile = options.keyFile;
    }

    if (options.certFile != null) {
      assert(typeof options.certFile === 'string');
      this.certFile = options.certFile;
    }

    // Allow no-auth implicitly
    // if we're listening locally.
    if (!options.apiKey) {
      if (this.host === '127.0.0.1' || this.host === '::1') this.noAuth = true;
    }

    return this;
  }

  /**
   * Instantiate http options from object.
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  static fromOptions(options) {
    return new HTTPOptions().fromOptions(options);
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}

/*
 * Expose
 */

module.exports = HTTP;
