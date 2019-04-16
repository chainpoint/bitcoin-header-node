/*!
 * headerpool.js - special Pool object for header nodes
 */

'use strict'

const assert = require('bsert')
const { Pool } = require('bcoin')

/**
 * Need a custom Pool object to deal with certain edge cases
 * for a header node where we don't have the full history
 * of the chain which, for example, breaks the chain.getLocator calls
 */
class HeaderPool extends Pool {
  constructor(options) {
    super(options)

    this.headerindex = null

    if (options.headerindex) {
      assert(typeof options.headerindex === 'object')
      this.headerindex = options.headerindex
    }
  }
  /**
   * Send a sync to each peer.
   * @private
   * @param {Boolean?} force
   * @returns {Promise}
   */

  async resync(force) {
    if (!this.syncing) return

    let locator
    try {
      locator = await this.headerindex.getLocator()
    } catch (e) {
      this.emit('error', e)
      return
    }

    for (let peer = this.peers.head(); peer; peer = peer.next) {
      if (!peer.outbound) continue

      if (!force && peer.syncing) continue

      this.sendLocator(locator, peer)
    }
  }

  /**
   * Start syncing from peer.
   * @method
   * @param {Peer} peer
   * @returns {Promise}
   */

  async sendSync(peer) {
    if (peer.syncing) return false

    if (!this.isSyncable(peer)) return false

    peer.syncing = true
    peer.blockTime = Date.now()

    let locator
    try {
      locator = await this.headerindex.getLocator()
    } catch (e) {
      peer.syncing = false
      peer.blockTime = -1
      this.emit('error', e)
      return false
    }

    return this.sendLocator(locator, peer)
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
    const locator = await this.headerindex.getLocator()
    const root = this.chain.getOrphanRoot(orphan)

    assert(root)

    peer.sendGetBlocks(locator, root)
  }

  /**
   * Send `getheaders` to peer after building locator.
   * @method
   * @param {Peer} peer
   * @param {Hash} tip - Tip to build chain locator from.
   * @param {Hash?} stop
   * @returns {Promise}
   */

  async getHeaders(peer, tip, stop) {
    const locator = await this.headerindex.getLocator(tip)
    peer.sendGetHeaders(locator, stop)
  }

  /**
   * Send `getblocks` to peer after building locator.
   * @method
   * @param {Peer} peer
   * @param {Hash} tip - Tip hash to build chain locator from.
   * @param {Hash?} stop
   * @returns {Promise}
   */

  async getBlocks(peer, tip, stop) {
    const locator = await this.headerindex.getLocator(tip)
    peer.sendGetBlocks(locator, stop)
  }
}

/*
 * Expose
 */

module.exports = HeaderPool
