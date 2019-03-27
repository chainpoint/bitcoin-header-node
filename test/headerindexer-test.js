'use strict';

const assert = require('bsert');
const { Chain, protocol, Miner, Headers } = require('bcoin');

const { sleep } = require('./util/common');
const HeaderIndexer = require('../lib/headerindexer');

const { Network } = protocol;
const network = Network.get('regtest');

const chain = new Chain({
  memory: true,
  network,
});

const miner = new Miner({
  chain,
  version: 4,
});

const cpu = miner.cpu;
miner.addresses.length = 0;
miner.addAddress('muhtvdmsnbQEPFuEmxcChX58fGvXaaUoVt');

describe('HeaderIndexer', () => {
  let indexer, options;

  before(async () => {
    options = { memory: true, chain };
    indexer = new HeaderIndexer(options);

    await chain.open();
    await miner.open();
    await indexer.open();
    // need to let the indexer get setup
    // otherwise close happens too early
    await sleep(500);
  });

  after(async () => {
    await indexer.close();
    await chain.close();
    await miner.close();
  });

  it('should create a new HeaderIndexer', async () => {
    assert(indexer);
  });

  it('should index headers for 10 blocks by height', async () => {
    const count = 10;
    for (let i = 0; i < count; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    let prevBlock;

    for (let i = 0; i < count; i++) {
      if (i !== 0) {
        let header = await indexer.getHeaderByHeight(i);
        header = Headers.fromRaw(header.toRaw());
        if (prevBlock)
          assert.equal(prevBlock, header.prevBlock.toString('hex'));
        prevBlock = header.hash().toString('hex');
      }
    }
  });

  xit('should support initializing a chain from custom height', () => {

  });
});
