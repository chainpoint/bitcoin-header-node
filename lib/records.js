/*!
 * Chain State for use with bcoin blockchain module
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2019, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */
'use strict';

const bio = require('bufio');
const { protocol } = require('bcoin');

const { consensus } = protocol;
/**
 * Chain State
 */

class ChainState {
  /**
   * Create chain state.
   * @alias module:blockchain.ChainState
   * @constructor
   */

  constructor() {
    this.tip = consensus.ZERO_HASH;
    this.tx = 0;
    this.coin = 0;
    this.value = 0;
    this.committed = false;
  }

  clone() {
    const state = new ChainState();
    state.tip = this.tip;
    state.tx = this.tx;
    state.coin = this.coin;
    state.value = this.value;
    return state;
  }

  connect(block) {
    this.tx += block.txs.length;
  }

  disconnect(block) {
    this.tx -= block.txs.length;
  }

  add(coin) {
    this.coin += 1;
    this.value += coin.value;
  }

  spend(coin) {
    this.coin -= 1;
    this.value -= coin.value;
  }

  commit(hash) {
    this.tip = hash;
    this.committed = true;
    return this.toRaw();
  }

  toRaw() {
    const bw = bio.write(56);
    bw.writeHash(this.tip);
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.value);
    return bw.render();
  }

  static fromRaw(data) {
    const state = new ChainState();
    const br = bio.read(data);
    state.tip = br.readHash();
    state.tx = br.readU64();
    state.coin = br.readU64();
    state.value = br.readU64();
    return state;
  }
}

/**
 * Block Meta
 * @alias module:indexer.BlockMeta
 */

class BlockMeta {
  /**
   * Create block meta.
   * @constructor
   * @param {Hash} hash
   * @param {Number} height
   */

  constructor(hash, height) {
    this.hash = hash || consensus.NULL_HASH;
    this.height = height != null ? height : -1;
  }

  /**
   * Clone the block.
   * @returns {BlockMeta}
   */

  clone() {
    return new this.constructor(this.hash, this.height);
  }

  /**
   * Get block meta hash as a buffer.
   * @returns {Buffer}
   */

  toHash() {
    return Buffer.from(this.hash, 'hex');
  }

  /**
   * Instantiate block meta from chain entry.
   * @private
   * @param {IndexEntry} entry
   */

  fromEntry(entry) {
    this.hash = entry.hash;
    this.height = entry.height;
    return this;
  }

  /**
   * Instantiate block meta from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    this.hash = util.revHex(json.hash);
    this.height = json.height;
    return this;
  }

  /**
   * Instantiate block meta from serialized tip data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    const br = bio.read(data);
    this.hash = br.readHash('hex');
    this.height = br.readI32();
    return this;
  }

  /**
   * Instantiate block meta from chain entry.
   * @param {IndexEntry} entry
   * @returns {BlockMeta}
   */

  static fromEntry(entry) {
    return new this().fromEntry(entry);
  }

  /**
   * Instantiate block meta from json object.
   * @param {Object} json
   * @returns {BlockMeta}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Instantiate block meta from serialized data.
   * @param {Hash} hash
   * @param {Buffer} data
   * @returns {BlockMeta}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  /**
   * Serialize the block meta.
   * @returns {Buffer}
   */

  toRaw() {
    const bw = bio.write(36);
    bw.writeHash(this.hash);
    bw.writeI32(this.height);
    return bw.render();
  }

  /**
   * Convert the block meta to a more json-friendly object.
   * @returns {Object}
   */

  toJSON() {
    return {
      hash: util.revHex(this.hash),
      height: this.height
    };
  }
}

/*
 * Expose
 */

exports.ChainState = ChainState;
exports.BlockMeta = BlockMeta;

module.exports = exports;
