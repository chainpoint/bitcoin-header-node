'use strict';
const assert = require('bsert');

const { protocol, Headers } = require('bcoin');

const HeaderNode = require('../lib/headernode');
const { rimraf, sleep } = require('./util/common');
const {
  initFullNode,
  initNodeClient,
  initWalletClient,
  initWallet,
  generateInitialBlocks,
  generateBlocks,
  generateReorg,
} = require('./util/regtest');

const { Network } = protocol;
const network = Network.get('regtest');

const testPrefix = '/tmp/bcoin-fullnode';
const headerTestPrefix = '/tmp/bcoin-headernode';
const genesisTime = 1534965859;

const ports = {
  full: {
    p2p: 49331,
    node: 49332,
    wallet: 49333,
  },
  header: {
    p2p: 49431,
    node: 49432,
    wallet: 49433,
  },
};

describe('HeaderNode', function() {
  this.timeout(30000);
  let node,
    headerNode,
    wallet = null;
  let nclient,
    wclient = null;
  let coinbase,
    initHeight = null;

  before(async () => {
    await rimraf(testPrefix);
    await rimraf(headerTestPrefix);

    initHeight = 20;

    node = await initFullNode({
      ports,
      prefix: testPrefix,
      logLevel: 'none',
    });

    headerNode = new HeaderNode({
      prefix: headerTestPrefix,
      network: network.type,
      port: ports.header.p2p,
      httpPort: ports.header.node,
      logLevel: 'none',
      nodes: [`127.0.0.1:${ports.full.p2p}`],
      memory: false,
      workers: true,
    });

    nclient = await initNodeClient({ ports: ports.full });
    wclient = await initWalletClient({ ports: ports.full });
    wallet = await initWallet(wclient);

    await wclient.execute('selectwallet', ['test']);
    coinbase = await wclient.execute('getnewaddress', ['blue']);

    await generateInitialBlocks({
      nclient,
      wclient,
      coinbase,
      genesisTime,
      blocks: initHeight,
    });

    await sleep(1000);
    await headerNode.open();
    await headerNode.connect();
    await headerNode.startSync();
  });

  after(async () => {
    await wallet.close();
    await wclient.close();
    await nclient.close();
    await node.close();
    await headerNode.close();
    await rimraf(testPrefix);
    await rimraf(headerTestPrefix);
  });

  it('should create a new HeaderNode', async () => {
    assert(headerNode);
  });

  it('should sync a chain of block headers from peers', async () => {
    for (let i = 0; i < initHeight; i++) {
      const entry = await node.chain.getEntry(i);
      let header = await headerNode.getHeader(i);

      if (header) header = Headers.fromRaw(header);
      else throw new Error(`No header in the index for block ${i}`);

      assert.equal(
        entry.hash,
        header.hash(),
        `Expected header hash to equal block entry hash for block ${i}`
      );
    }
  });

  it('should index new block headers when new blocks are \
mined on the network', async () => {
    const count = 10;

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase);
    await sleep(1000);

    const tip = await nclient.execute('getblockcount');
    const header = await headerNode.getHeader(tip);
    assert(header, 'Expected to get a header for the latest tip');
  });

  it('should start syncing from last tip when restarted', async () => {
    const count = 10;
    await headerNode.close();

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase);
    await sleep(500);

    // restart header node
    await headerNode.open();
    await headerNode.connect();
    await headerNode.startSync();
    await sleep(500);

    const tip = await nclient.execute('getblockcount');
    const header = await headerNode.getHeader(tip);
    assert(header, 'Expected to get a header for the latest tip');
  });

  // TODO
  xit('should handle a reorg', () => {});

  xit('should support syncing from a custom height', () => {});
});
