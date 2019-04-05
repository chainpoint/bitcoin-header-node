/*!
 * headerpool.js - special Pool object for header nodes
 */

'use strict';

const assert = require('bsert');
const { Pool } = require('bcoin');

/**
 * Need a custom Pool object to deal with certain edge cases
 * for a header node where, for example, we don't have the full history
 * of the chain which breaks the chain.getLocator calls
 */
class HeaderPool extends Pool {
  /**
   * Send a sync to each peer.
   * @private
   * @param {Boolean?} force
   * @returns {Promise}
   */

  async resync(force) {
    if (!this.syncing)
      return;

    let locator;
    try {
      locator = await this.getLocator();
    } catch (e) {
      this.emit('error', e);
      return;
    }

    for (let peer = this.peers.head(); peer; peer = peer.next) {
      if (!peer.outbound)
        continue;

      if (!force && peer.syncing)
        continue;

      this.sendLocator(locator, peer);
    }
  }

  /**
   * Start syncing from peer.
   * @method
   * @param {Peer} peer
   * @returns {Promise}
   */

  async sendSync(peer) {
    if (peer.syncing)
      return false;

    if (!this.isSyncable(peer))
      return false;

    peer.syncing = true;
    peer.blockTime = Date.now();

    let locator;
    try {
      locator = await this.getLocator();
    } catch (e) {
      peer.syncing = false;
      peer.blockTime = -1;
      this.emit('error', e);
      return false;
    }

    return this.sendLocator(locator, peer);
  }

  /**
   * Send `getblocks` to peer after building
   * locator and resolving orphan root.
   * @method
   * @param {Peer} peer
   * @param {Hash} orphan - Orphan hash to resolve.
   * @returns {Promise}
   */
  async resolveOrphan(peer, orphan) {
    const locator = await this.chain.getLocator();
    const root = this.getOrphanRoot(orphan);

    assert(root);

    peer.sendGetBlocks(locator, root);
  }

  /**
   * A proxy to the chain's getLocator method
   * if we know we are in a "partial chain" state
   * we will return a truncated locator
   * @returns {Promise} - A promise returning an array of chain entry hashes
   */
  async getLocator() {
    // if we don't have a custom "pruned" chain, and the tip
    // is either at genesis or has a full history
    // then we can return the normal locator
    const isPruned = await this.isPrunedChain();
    if (!isPruned) return this.chain.getLocator();

    // otherwise prepare our custom locator

    // initialize an array of hashes to send as locator
    const hashes = [];

    // push the tip's hash onto the locator array (make sure it's a buffer)
    const tip = this.chain.tip;
    assert(Buffer.isBuffer(tip.hash));
    hashes.push(tip.hash);

    // getHash of prev and push onto array
    const prevHash = await this.chain.getHash(tip.height - 1);
    if (prevHash) hashes.push(prevHash);

    return hashes;
  }

  /**
   * Check if the chain is a special "pruned" chain
   * meaning that it does not have any history earlier than
   * it's tip and the tip's previous block entry
   * @returns {Bool}
   */
  async isPrunedChain() {
    if (this.chain.tip.height === 0) return false;

    let entry = await this.chain.getEntry(this.chain.tip.height - 2);

    if (entry)
      return false;

    return true;
  }
}

/*
 * Expose
 */

module.exports = HeaderPool;
