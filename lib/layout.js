/*!
 * layout.js - indexer layout for bcoin
 * Copyright (c) 2018, the bcoin developers (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const bdb = require('bdb');

/*
 * Index Database Layout:
 * To be extended by indexer implementations
 *  V -> db version
 *  O -> flags
 *  R -> chain sync state
 *  c -> chain state // for saving the chain state
 *  t -> chain tip entry // saving the chain tip
 *  p -> prev block entry // needed for recovering chain state
 *  b[hash] -> block header
 *  H[height] -> hash
 *  h[height] -> recent block hash
 */

const layout = {
  V: bdb.key('V'),
  O: bdb.key('O'),
  R: bdb.key('R'),
  c: bdb.key('c'),
  t: bdb.key('t'),
  p: bdb.key('p'),
  b: bdb.key('b', ['hash256']),
  H: bdb.key('H', ['uint32']),
  h: bdb.key('h', ['uint32'])
};

/*
 * Expose
 */

module.exports = layout;
