'use strict'
const assert = require('bsert')

const { Network, ChainEntry } = require('bcoin')
const { NodeClient } = require('bclient')

const HeaderNode = require('../lib/headernode')
const { rimraf, sleep } = require('./util/common')
const { revHex } = require('../lib/util')
const {
  initFullNode,
  initNodeClient,
  initWalletClient,
  initWallet,
  generateInitialBlocks,
  generateBlocks
  // generateReorg,
} = require('./util/regtest')

const network = Network.get('regtest')

const testPrefix = '/tmp/bcoin-fullnode'
const headerTestPrefix = '/tmp/bcoin-headernode'
const genesisTime = 1534965859

const ports = {
  full: {
    p2p: 49331,
    node: 49332,
    wallet: 49333
  },
  header: {
    p2p: 49431,
    node: 49432
  }
}

describe('HeaderNode', function() {
  this.timeout(30000)
  let node = null
  let headerNode = null
  let fastNode = null
  let wallet = null
  let nclient,
    wclient = null
  let coinbase,
    headerNodeOptions,
    initHeight = null

  before(async () => {
    await rimraf(testPrefix)
    await rimraf(headerTestPrefix)

    initHeight = 20

    node = await initFullNode({
      ports,
      prefix: testPrefix,
      logLevel: 'none'
    })

    headerNodeOptions = {
      prefix: headerTestPrefix,
      network: network.type,
      port: ports.header.p2p,
      httpPort: ports.header.node,
      apiKey: 'iamsatoshi',
      logLevel: 'error',
      nodes: [`127.0.0.1:${ports.full.p2p}`],
      memory: false,
      workers: true
    }
    headerNode = new HeaderNode(headerNodeOptions)

    nclient = await initNodeClient({ ports: ports.full })
    wclient = await initWalletClient({ ports: ports.full })
    wallet = await initWallet(wclient)

    await wclient.execute('selectwallet', ['test'])
    coinbase = await wclient.execute('getnewaddress', ['blue'])

    await generateInitialBlocks({
      nclient,
      wclient,
      coinbase,
      genesisTime,
      blocks: initHeight
    })

    // need to turn off the targetReset to avoid pow bit checks
    // that need older blocks. This is only an issue for testnet which has different
    // retargeting rules and can be avoided by not starting sync past the lastCheckpoint
    headerNode.network.pow.targetReset = false
    await headerNode.ensure()
    await headerNode.open()
    await headerNode.connect()
    await headerNode.startSync()
    await sleep(1000)
  })

  after(async () => {
    await wallet.close()
    await wclient.close()
    await nclient.close()
    await node.close()
    await headerNode.close()
    await rimraf(testPrefix)
    await rimraf(headerTestPrefix)

    headerNode.network.pow.targetReset = true

    // clear checkpoint information on bcoin module
    if (node.network.lastCheckpoint) headerNode.setCustomCheckpoint()

    if (fastNode && fastNode.opened) await fastNode.close()
  })

  it('should create a new HeaderNode', async () => {
    assert(headerNode)
  })

  it('should sync a chain of block headers from peers', async () => {
    for (let i = 0; i < initHeight; i++) {
      // first block doesn't have valid headers
      if (i === 0) continue

      const entry = await node.chain.getEntry(i)
      const header = await headerNode.getHeader(i)

      if (!header) throw new Error(`No header in the index for block ${i}`)

      assert.equal(entry.hash.toString('hex'), header.hash.toString('hex'))
    }
  })

  it('should index new block headers when new blocks are \
mined on the network', async () => {
    const count = 10

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase)
    await sleep(500)

    const tip = await nclient.execute('getblockcount')

    const headerTip = await headerNode.getTip()
    const header = await headerNode.getHeader(headerTip.height)

    assert.equal(tip, headerTip.height, 'Expected chain tip and header tip to be the same')
    assert(header, 'Expected to get a header for the latest tip')
  })

  it('should start syncing from last tip when restarted', async () => {
    let headerTip
    const count = 10
    await headerNode.disconnect()

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase)
    await sleep(500)

    let tip = await nclient.execute('getblockcount')
    headerTip = await headerNode.getTip()

    assert.equal(tip - count, headerTip.height, 'Headers tip before sync should same as before blocks were mined')

    // reset the chain in case in-memory chain not picked up by GC
    await resetChain(headerNode)

    headerTip = await headerNode.getTip()
    const header = await headerNode.getHeader(headerTip.height)

    assert.equal(headerTip.height, tip, 'Expected chain tip and header tip to be the same')
    assert(header, 'Expected to get a header for the latest tip after restart')

    // now check subscriptions are still working for new blocks
    await generateBlocks(count, nclient, coinbase)
    await sleep(500)
    tip = await nclient.execute('getblockcount')

    headerTip = await headerNode.getTip()
    assert.equal(headerTip.height, tip, 'Expected chain tip and header tip to be the same after new blocks mined')

    assert(header, 'Expected to get a header for the latest tip after blocks mined')
  })

  it('should support checkpoints', async () => {
    // header index needs to maintain chain from the last checkpoint
    // this test will set a checkpoint for our regtest network
    // reset the headernode chain similar to the previous test
    // and then confirm that only the non-historical blocks were
    // restored on the chain, i.e. blocks newer than lastCheckpoint

    const checkpoint = await headerNode.getTip()
    const count = 10

    // mine a block on top of the checkpoint
    await generateBlocks(1, nclient, coinbase)
    await sleep(500)

    await headerNode.disconnect()

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase)
    await sleep(500)

    // set checkpoint
    headerNode.setCustomCheckpoint(checkpoint.height, checkpoint.hash)

    // resetting chain db to clear from memory
    await resetChain(headerNode, checkpoint.height - count)

    const historicalEntry = await headerNode.chain.getEntryByHeight(checkpoint.height - 2)

    const checkpointEntry = await headerNode.chain.getEntryByHeight(checkpoint.height + count - 1)

    assert(!historicalEntry, 'Expected there to be no entry for height earlier than checkpoint')
    assert(checkpointEntry, 'Expected there to be an entry for height after checkpoint')
  })

  it('should support custom starting header where lastCheckpoint - startHeight < retargetInterval', async () => {
    // need to reset checkpoints otherwise causes issues for creating a new node
    if (node.network.lastCheckpoint) headerNode.setCustomCheckpoint()

    // in order to test that pow checks will work, we need to mine past a retarget interval
    // to test that the start point is adjusted accordingly. If we don't have at least one retarget
    // block then it will adjust back to genesis
    // note that this makes the tests take a much longer time
    await generateBlocks(headerNode.network.pow.retargetInterval + 20, nclient, coinbase)

    // arbitrary block to start our new node's chain from
    // creating a tip with two blocks (prev and tip)
    const chainTip = await node.chain.db.getTip()
    const startHeight = chainTip['height'] - 50
    const startTip = []
    let entry = await node.chain.getEntryByHeight(startHeight)
    startTip.push(entry.toRaw('hex'))
    entry = await node.chain.getEntryByHeight(startHeight + 1)
    startTip.push(entry.toRaw('hex'))

    const options = {
      ...headerNodeOptions,
      port: ports.header.p2p + 10,
      httpPort: ports.header.node + 10,
      startTip: startTip,
      memory: true
    }

    // set a custom lastCheckpoint to confirm it can sync past it
    let checkpointEntry = await node.chain.getEntryByHeight(startHeight + 10)
    assert(checkpointEntry, 'Problem finding checkpoint block')

    // NOTE: since the functionality to start at a later height
    // involves mutating the networks module's lastCheckpoint
    // this will impact all other nodes involved in tests since
    // they all share the same bcoin instance
    // This only happens on `open` for a start point that
    // is after the network's lastCheckpoint (which is zero for regtest)
    fastNode = new HeaderNode(options)

    fastNode.setCustomCheckpoint(checkpointEntry.height, checkpointEntry.hash)
    const {
      pow: { retargetInterval },
      lastCheckpoint
    } = fastNode.network

    assert(
      lastCheckpoint - startHeight < retargetInterval,
      'Problem setting up the test. Expected start height to before the last checkpoint but after a retarget'
    )
    await fastNode.ensure()
    await fastNode.open()
    await fastNode.connect()
    await fastNode.startSync()
    await sleep(500)

    const oldHeader = await fastNode.getHeader(startHeight - 1)
    const newHeader = await fastNode.getHeader(startHeight + 5)

    assert(!oldHeader, 'Did not expect to see an earlier block than the start height')
    assert(newHeader, 'Expected to be able to retrieve a header later than start point')

    // let's just test that it can reconnect
    // after losing its in-memory chain
    await fastNode.disconnect()
    await resetChain(fastNode, startHeight + 1)
    const tip = await nclient.execute('getblockcount')
    const fastTip = await fastNode.getTip()

    assert.equal(tip, fastTip.height, 'expected tips to be in sync after "restart"')
    fastNode.setCustomCheckpoint()
  })

  xit('should handle a reorg', () => {})

  describe('HTTP/RPC', () => {
    let client
    beforeEach(async () => {
      client = new NodeClient({
        port: ports.header.node,
        apiKey: headerNodeOptions.apiKey
      })
      await client.open()
    })

    afterEach(async () => {
      await client.close()
    })

    it('should be able to return info about the node', async () => {
      const info = await client.getInfo()
      const rpcInfo = await client.execute('getinfo')
      const chain = headerNode.chain
      assert.equal(info.chain.height, chain.height, 'Expected to get back chain height from info endpoint')
      assert(rpcInfo)
    })

    it('should support getting block headers with rpc and http endpoints', async () => {
      const height = Math.floor(headerNode.chain.height / 2)
      const header = await headerNode.getHeader(height)

      // http
      const httpBlockHeader = await client.getBlock(height)
      const httpHeader = await client.get(`/header/${height}`)

      // note that these will be the same (block and header)
      // but we want to maintain support for the block endpoint
      assert(httpBlockHeader, 'Could not get block with http')
      assert(httpHeader, 'Could not get header by height with http')

      assert.equal(
        httpBlockHeader.merkleRoot,
        revHex(header.merkleRoot),
        'Expected merkle root returned by server to match with one from header node'
      )

      // rpc
      const rpcHeader = await client.execute('getblockheader', [height])
      assert(rpcHeader, 'Could not get block by height with rpc')
      assert.equal(
        rpcHeader.merkleroot,
        revHex(header.merkleRoot),
        'Expected merkle root returned by server to match with one from header node'
      )
    })

    it('should support socket subscriptions to new block events', async () => {
      let tip = await client.getTip()
      assert(tip)
      let entry
      client.bind('chain connect', raw => {
        entry = ChainEntry.fromRaw(raw)
      })

      await generateBlocks(1, nclient, coinbase)
      await sleep(500)

      tip = await client.getTip()
      assert(entry, 'Did not get an entry from a chain connect event after mining a block')

      assert.equal(revHex(entry.hash), revHex(ChainEntry.fromRaw(tip).hash))
    })
  })
})

/*
 * Helpers
 */

async function resetChain(node, start = 0) {
  // reset chain to custom start
  // can't always reset to 0 because `chaindb.reset`
  // won't work when there is a custom start point
  // because chain "rewind" won't work

  // need to turn off `targetReset` for pow to avoid unecessary
  // check when resetting the chain for testing purposes
  await node.chain.db.reset(start)
  await node.close()
  await node.open()
  await node.connect()
  await node.startSync()

  // let indexer catch up
  await sleep(500)
}
