/*!
 * Chain State for use with bcoin blockchain module
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2019, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */
'use strict'
const assert = require('bsert')
const { protocol } = require('bcoin')
const { ZERO_HASH } = protocol.consensus

/**
 * Block Meta
 */

class BlockMeta {
  constructor(hash, height) {
    this.hash = hash || ZERO_HASH
    this.height = height || 0

    assert(Buffer.isBuffer(this.hash) && this.hash.length === 32)
    assert(Number.isInteger(this.height))
  }

  /**
   * Instantiate block meta from chain entry.
   * @private
   * @param {IndexEntry} entry
   */

  fromEntry(entry) {
    this.hash = entry.hash
    this.height = entry.height
    return this
  }

  /**
   * Instantiate block meta from chain entry.
   * @param {IndexEntry} entry
   * @returns {BlockMeta}
   */

  static fromEntry(entry) {
    return new this().fromEntry(entry)
  }
}

/*
 * Expose
 */

exports.BlockMeta = BlockMeta

module.exports = exports
