/*!
 * server.js - http server for header node
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * Copyright (c) 2019-, Tierion Inc (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict'

const Validator = require('bval')
const sha256 = require('bcrypto/lib/sha256')
const util = require('./util')
const {
  pkg,
  node: { HTTP }
} = require('bcoin')

/**
 * HTTP
 * @alias module:http.Server
 */

class HeaderHTTP extends HTTP {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(options)
    this.headerindex = this.node.headerindex
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    if (this.options.cors) this.use(this.cors())

    if (!this.options.noAuth) {
      this.use(
        this.basicAuth({
          hash: sha256.digest,
          password: this.options.apiKey,
          realm: 'node'
        })
      )
    }

    this.use(
      this.bodyParser({
        type: 'json'
      })
    )

    this.use(this.jsonRPC())
    this.use(this.router())

    this.error((err, req, res) => {
      const code = err.statusCode || 500
      res.json(code, {
        error: {
          type: err.type,
          code: err.code,
          message: err.message
        }
      })
    })

    this.get('/', async (req, res) => {
      let addr = this.pool.hosts.getLocal()

      if (!addr) addr = this.pool.hosts.address

      res.json(200, {
        version: pkg.version,
        network: this.network.type,
        chain: {
          height: this.chain.height,
          tip: this.chain.tip.rhash(),
          progress: this.chain.getProgress()
        },
        pool: {
          host: addr.host,
          port: addr.port,
          agent: this.pool.options.agent,
          services: this.pool.options.services.toString(2),
          outbound: this.pool.peers.outbound,
          inbound: this.pool.peers.inbound
        },
        time: {
          uptime: this.node.uptime(),
          system: util.now(),
          adjusted: this.network.now(),
          offset: this.network.time.offset
        },
        memory: this.logger.memoryUsage()
      })
    })

    // Block by hash/height
    this.get('/block/:height', (req, res) => this.getBlockHeader(req, res))
    this.get('/header/:height', (req, res) => this.getBlockHeader(req, res))
  }

  /*
   * Get a block header by height.
   * This method is used by two paths so pulling out as helper method
   */
  async getBlockHeader(req, res) {
    const valid = Validator.fromRequest(req)
    const height = valid.uint('height')

    enforce(height != null, 'Height required.')

    const header = await this.headerindex.getHeader(height)

    if (!header) {
      res.json(404)
      return
    }
    res.json(200, header.toJSON())
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg)
    err.statusCode = 400
    throw err
  }
}

/*
 * Expose
 */

module.exports = HeaderHTTP
