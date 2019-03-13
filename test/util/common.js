'use strict';
const fs = require('bfile');

const common = exports;

common.sleep = async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
};

common.rimraf = async function(p) {
  const allowed = new RegExp('^\/tmp\/(.*)$');
  if (!allowed.test(p))
    throw new Error(`Path not allowed: ${p}.`);

   return await fs.rimraf(p);
};
