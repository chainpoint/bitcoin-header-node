'use strict'
const fs = require('bfile')
const assert = require('bsert')

const common = exports

common.sleep = async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

common.rimraf = async function(p) {
  const allowed = new RegExp('^/tmp/(.*)$')
  if (!allowed.test(p)) throw new Error(`Path not allowed: ${p}.`)

  return await fs.rimraf(p)
}

/*
 * Sets a custom checkpoint on the network object
 * Useful for syncing from a custom block height
 * NOTE: This will affect anything that shares the same
 * bcoin module, e.g. for tests when running multiple nodes
 * @param {Object} checkpoint
 * @param {Number} checkpoint.height
 * @param {Buffer} checkpoint.hash
 */
common.setCustomCheckpoint = function(obj, height = 0, hash) {
  assert(!hash || Buffer.isBuffer(hash), 'Must pass in a buffer for checkpoint hash')
  assert(obj.network, 'Object passed to setCustomCheckpoint must have a network object attached')
  obj.logger.info('Setting custom lastCheckpoint as %d (checkpoint=%h)', height, hash)
  obj.network.lastCheckpoint = height
  if (height) {
    obj.network.checkpointMap[height] = hash
    obj.network.checkpoints.push({ hash, height })
    obj.network.checkpoints.sort((a, b) => a.height - b.height)
  } else {
    // if lastCheckpoint height is zero then clear checkpoint map
    obj.logger.debug('Empty height passed to setCustomCheckpoint')
    obj.logger.debug("Clearing %s network's checkpoint map", obj.network.type)
    obj.network.checkpointMap = {}
    obj.network.checkpoints = []
  }
}
