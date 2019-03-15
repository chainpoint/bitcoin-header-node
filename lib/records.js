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

/*
 * Expose
 */

exports.ChainState = ChainState;

module.exports = exports;
