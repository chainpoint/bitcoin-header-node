/*!
 * util.js - utils for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');

/**
 * @exports utils/util
 */

const util = exports;

/**
 * Reverse a hex-string.
 * @param {String} str - Hex string.
 * @returns {String} Reversed hex string.
 */

util.revHex = function revHex(buf) {
  assert(Buffer.isBuffer(buf));

  const str = buf.toString('hex');

  let out = '';

  for (let i = str.length - 2; i >= 0; i -= 2)
    out += str[i] + str[i + 1];

  return out;
};
