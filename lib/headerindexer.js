'use strict';

const bdb = require('bdb');
const {Indexer, Headers} = require('bcoin');

const layout = require('./layout');

/*
 * HeaderIndexer Database Layout:
 *  b[hash] -> block header
 *  H[height] -> hash
*/

Object.assign(layout, {
  b: bdb.key('b', ['hash256']),
  H: bdb.key('H', ['uint32']),
});

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
    super('filter', options);

    this.db = bdb.create(this.options);
  }

  async indexBlock(entry, block, view) {
    const b = this.db.batch();

    const hash = block.hash();
    const header = Headers.fromEntry(entry);
    const height = entry.height;

    b.put(layout.b.encode(hash), header.toRaw());
    b.put(layout.H.encode(height), hash);
    return b.write();
  }

  /**
   * Remove transactions from index.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   */

  async unindexBlock(entry, block, view) {
    const b = this.db.batch();

    const hash = block.hash();
    const height = block.height;

    b.del(layout.b.encode(hash));
    b.del(layout.H.encode(height));

    return b.write();
  }

  /**
   * Get block header by height
   * @param {height} block height
   * @returns {Headers|null} block header
   */

  async getHeaderByHeight(height) {
    const hash = await this.db.get(layout.H.encode(height));

    if (!hash)
      return null;

    return await this.db.get(layout.b.encode(hash)) || null;
  }
}

module.exports = HeaderIndexer;
