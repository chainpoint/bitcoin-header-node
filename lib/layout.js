/*!
 * layout.js - indexer layout for bcoin
 * Copyright (c) 2018, the bcoin developers (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict'

const bdb = require('bdb')

/*
 * Index Database Layout:
 * To be extended by indexer implementations
 *  V -> db version
 *  O -> flags
 *  R -> chain sync state
 *  b[height] -> block header
 *  h[height] -> recent block hash
 *  s[index] -> starting block entries for setting custom start heights (index either 0 or 1)
 */

const layout = {
  V: bdb.key('V'),
  O: bdb.key('O'),
  R: bdb.key('R'),
  b: bdb.key('b', ['uint32']),
  h: bdb.key('h', ['uint32']),
  s: bdb.key('s', ['uint8'])
}

/*
 * Expose
 */

module.exports = layout
