/*!
 * rpc.js - bitcoind-compatible json rpc for bcoin.
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const bweb = require('bweb');
const IP = require('binet');
const Validator = require('bval');
const hash160 = require('bcrypto/lib/hash160');
const hash256 = require('bcrypto/lib/hash256');
const { safeEqual } = require('bcrypto/lib/safe');
const secp256k1 = require('bcrypto/lib/secp256k1');
const util = require('./util');

const {
  Headers,
  protocol,
  pkg,
  net: { NetAddress },
} = require('bcoin');

const { Network, consensus } = protocol;
const RPCBase = bweb.RPC;
const RPCError = bweb.RPCError;

/*
 * Constants
 */

const errs = {
  // Standard JSON-RPC 2.0 errors
  INVALID_REQUEST: bweb.errors.INVALID_REQUEST,
  METHOD_NOT_FOUND: bweb.errors.METHOD_NOT_FOUND,
  INVALID_PARAMS: bweb.errors.INVALID_PARAMS,
  INTERNAL_ERROR: bweb.errors.INTERNAL_ERROR,
  PARSE_ERROR: bweb.errors.PARSE_ERROR,

  // General application defined errors
  MISC_ERROR: -1,
  FORBIDDEN_BY_SAFE_MODE: -2,
  TYPE_ERROR: -3,
  INVALID_ADDRESS_OR_KEY: -5,
  OUT_OF_MEMORY: -7,
  INVALID_PARAMETER: -8,
  DATABASE_ERROR: -20,
  DESERIALIZATION_ERROR: -22,
  VERIFY_ERROR: -25,
  VERIFY_REJECTED: -26,
  VERIFY_ALREADY_IN_CHAIN: -27,
  IN_WARMUP: -28,

  // P2P client errors
  CLIENT_NOT_CONNECTED: -9,
  CLIENT_IN_INITIAL_DOWNLOAD: -10,
  CLIENT_NODE_ALREADY_ADDED: -23,
  CLIENT_NODE_NOT_ADDED: -24,
  CLIENT_NODE_NOT_CONNECTED: -29,
  CLIENT_INVALID_IP_OR_SUBNET: -30,
  CLIENT_P2P_DISABLED: -31,
};

/**
 * Bitcoin RPC
 * @alias module:http.RPC
 * @extends bweb.RPC
 */

class RPC extends RPCBase {
  /**
   * Create RPC.
   * @param {Node} node
   */

  constructor(node) {
    super();

    assert(node, 'RPC requires a Node.');

    this.node = node;
    this.network = node.network;
    this.workers = node.workers;
    this.chain = node.chain;
    this.mempool = node.mempool;
    this.pool = node.pool;
    this.logger = node.logger.context('node-rpc');

    this.mining = false;
    this.procLimit = 0;
    this.attempt = null;
    this.lastActivity = 0;
    this.boundChain = false;
    this.nonce1 = 0;
    this.nonce2 = 0;
    this.pollers = [];

    this.init();
  }

  getCode(err) {
    switch (err.type) {
      case 'RPCError':
        return err.code;
      case 'ValidationError':
        return errs.TYPE_ERROR;
      case 'EncodingError':
        return errs.DESERIALIZATION_ERROR;
      default:
        return errs.INTERNAL_ERROR;
    }
  }

  handleCall(cmd, query) {
    if (
      cmd.method !== 'getwork' &&
      cmd.method !== 'getblocktemplate' &&
      cmd.method !== 'getbestblockhash'
    ) {
      this.logger.debug('Handling RPC call: %s.', cmd.method);
      if (cmd.method !== 'submitblock' && cmd.method !== 'getmemorypool') {
        this.logger.debug(cmd.params);
      }
    }

    if (cmd.method === 'getwork') {
      if (query.longpoll) cmd.method = 'getworklp';
    }
  }

  init() {
    // this.add('stop', this.stop);
    // this.add('help', this.help);
    // this.add('getblockchaininfo', this.getBlockchainInfo);
    // this.add('getbestblockhash', this.getBestBlockHash);
    // this.add('getblockcount', this.getBlockCount);
    // this.add('getblock', this.getBlock);
    // this.add('getblockbyheight', this.getBlockByHeight);
    // this.add('getblockhash', this.getBlockHash);
    // this.add('getblockheader', this.getBlockHeader);
    // this.add('getchaintips', this.getChainTips);
    // this.add('getdifficulty', this.getDifficulty);
    // this.add('invalidateblock', this.invalidateBlock);
    // this.add('reconsiderblock', this.reconsiderBlock);
    // this.add('getnetworkhashps', this.getNetworkHashPS);
    // this.add('getinfo', this.getInfo);
    // this.add('setmocktime', this.setMockTime);
    // this.add('getconnectioncount', this.getConnectionCount);
    // this.add('ping', this.ping);
    // this.add('getpeerinfo', this.getPeerInfo);
    // this.add('addnode', this.addNode);
    // this.add('disconnectnode', this.disconnectNode);
    // this.add('getaddednodeinfo', this.getAddedNodeInfo);
    // this.add('getnettotals', this.getNetTotals);
    // this.add('getnetworkinfo', this.getNetworkInfo);
    // this.add('setban', this.setBan);
    // this.add('listbanned', this.listBanned);
    // this.add('clearbanned', this.clearBanned);
    // this.add('getmemoryinfo', this.getMemoryInfo);
    // this.add('setloglevel', this.setLogLevel);
  }

  /*
   * Overall control/query calls
   */
}

/*
 * Expose
 */

module.exports = RPC;
