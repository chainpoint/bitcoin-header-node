'use strict'
const assert = require('bsert')

const { Network, ChainEntry, networks, Headers } = require('bcoin')
const { NodeClient } = require('bclient')

const HeaderNode = require('../lib/headernode')
const { rimraf, sleep, setCustomCheckpoint } = require('./util/common')
const { revHex, fromRev } = require('../lib/util')
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
  let lastCheckpoint,
    retargetInterval = null
  let node = null
  let headerNode = null
  let fastNode = null
  let wallet = null
  let nclient,
    wclient = null
  let coinbase, headerNodeOptions

  before(async () => {
    await rimraf(testPrefix)
    await rimraf(headerTestPrefix)

    node = await initFullNode({
      ports,
      prefix: testPrefix,
      logLevel: 'error'
    })

    nclient = await initNodeClient({ ports: ports.full })
    wclient = await initWalletClient({ ports: ports.full })
    wallet = await initWallet(wclient)

    await wclient.execute('selectwallet', ['test'])
    coinbase = await wclient.execute('getnewaddress', ['blue'])

    // lastCheckpoint and retargetInterval need to be set smaller for testing the behavior of
    // of checkpoints and custom startHeights so that the tests don't have to mine an unreasonable
    // number of blocks to test effectively
    // NOTE: since the functionality to start at a later height and changing retarget interval involves
    // mutating the `networks` module's lastCheckpoint this will impact all other nodes involved in tests
    // since they all share the same bcoin instance
    retargetInterval = 25
    lastCheckpoint = Math.floor(retargetInterval * 2.5)
    node.network.pow.retargetInterval = retargetInterval

    await generateInitialBlocks({
      nclient,
      wclient,
      coinbase,
      genesisTime
    })

    const checkpoint = await nclient.execute('getblockbyheight', [lastCheckpoint])
    setCustomCheckpoint(node, lastCheckpoint, fromRev(checkpoint.hash))

    headerNodeOptions = {
      prefix: headerTestPrefix,
      network: network.type,
      port: ports.header.p2p,
      httpPort: ports.header.node,
      apiKey: 'iamsatoshi',
      logLevel: 'error',
      nodes: [`127.0.0.1:${ports.full.p2p}`],
      memory: false,
      workers: true,
      listen: true
    }

    headerNode = new HeaderNode(headerNodeOptions)

    await headerNode.ensure()
    await headerNode.open()
    await headerNode.connect()
    await headerNode.startSync()

    await sleep(500)
  })

  after(async () => {
    // reset the retargetInterval
    networks.regtest.pow.retargetInterval = 2016
    // clear checkpoint information on bcoin module
    if (node.network.lastCheckpoint) setCustomCheckpoint(node)

    await wallet.close()
    await wclient.close()
    await nclient.close()
    await node.close()
    await headerNode.close()
    await rimraf(testPrefix)
    await rimraf(headerTestPrefix)

    if (fastNode && fastNode.opened) await fastNode.close()
  })

  it('should create a new HeaderNode', async () => {
    assert(headerNode)
  })

  it('should sync a chain of block headers from peers', async () => {
    for (let i = 0; i < 10; i++) {
      // first block doesn't have valid headers
      if (i === 0) continue

      const entry = await node.chain.getEntry(i)
      const header = await headerNode.getHeader(i)

      if (!header) throw new Error(`No header in the index for block ${i}`)

      assert.equal(header.rhash(), entry.rhash())
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

    assert.equal(headerTip.height, tip, 'Expected chain tip and header tip to be the same')
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

    assert.equal(headerTip.height, tip - count, 'Headers tip before sync should be same as before blocks were mined')

    // reset the chain in case in-memory chain not picked up by GC
    await resetChain(headerNode, 0, false)

    headerTip = await headerNode.getTip()
    const header = await headerNode.getHeader(headerTip.height)

    assert.equal(headerTip.height, tip, 'Expected chain tip and header tip to be the same')
    assert(header, 'Expected to get a header for the latest tip after restart')

    // now check subscriptions are still working for new blocks
    await generateBlocks(count, nclient, coinbase)
    await sleep(250)
    tip = await nclient.execute('getblockcount')

    headerTip = await headerNode.getTip()
    assert.equal(headerTip.height, tip, 'Expected chain tip and header tip to be the same after new blocks mined')

    assert(header, 'Expected to get a header for the latest tip after blocks mined')
  })

  it('should support checkpoints', async () => {
    // header index needs to maintain chain entries for all non-historical blocks
    // this test will confirm that only the non-historical blocks were
    // restored on the chain, i.e. blocks newer than lastCheckpoint
    // in addition to a set of historical block entries between the last retarget height
    // and the lastCheckpoint
    const count = 10
    const historicalHeight = lastCheckpoint - (lastCheckpoint % retargetInterval)
    await headerNode.disconnect()

    // mine some blocks while header node is offline
    await generateBlocks(count, nclient, coinbase)
    await sleep(500)

    // resetting chain db to clear from memory
    await resetChain(headerNode, historicalHeight)
    const testHeight = historicalHeight - retargetInterval
    const historicalHeader = await headerNode.getHeader(testHeight)

    assert(Headers.isHeaders(historicalHeader), `Expected header for height ${testHeight} to be returned as a header`)
    assert(
      !ChainEntry.isChainEntry(historicalHeader),
      `Expected header for height ${testHeight} to not be a valid chain entry`
    )

    let entry = await headerNode.getHeader(lastCheckpoint + count - 1)
    assert(ChainEntry.isChainEntry(entry), 'Expected there to be a chain entry for non-historical heights')
  })

  it('should support custom starting header where startHeight is less than lastCheckpoint and at least 1 retarget', async () => {
    // in order to test that pow checks will work, we need to mine past a retarget interval
    // to test that the start point is adjusted accordingly. If we don't have at least one retarget
    // block then it will adjust back to genesis
    // await generateBlocks(retargetInterval, nclient, coinbase)
    const chainHeight = await nclient.execute('getblockcount')

    // set a custom lastCheckpoint for testing since regtest has none
    let checkpointEntry = await node.chain.getEntryByHeight(lastCheckpoint)
    assert(checkpointEntry, 'Problem finding checkpoint block')
    assert(
      checkpointEntry.height < chainHeight && checkpointEntry.height - retargetInterval > 0,
      'Problem setting up the test. Checkpoint height should be less than the chain tip and after at least 1 retarget'
    )

    // starting block must less than lastCheckpoint and less than or equal to a retargeting interval
    // this sets the starting height to the last retargeting interval before the lastCheckpoint
    const startHeight = checkpointEntry.height - (checkpointEntry.height % retargetInterval) - 1
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

    fastNode = new HeaderNode(options)

    // startup and sync our fastNode with custom start height
    await fastNode.ensure()
    await fastNode.open()
    await fastNode.connect()
    await fastNode.startSync()
    await sleep(500)

    const beforeStartHeight = await fastNode.getHeader(startHeight - 1)
    const afterStartHeight = await fastNode.getHeader(startHeight + 5)

    assert(!beforeStartHeight, 'Did not expect to see an earlier block than the start height')
    assert(afterStartHeight, 'Expected to be able to retrieve a header later than start point')

    // let's just test that it can reconnect
    // after losing its in-memory chain
    const startTipHeight = ChainEntry.fromRaw(startTip[1]).height
    await fastNode.disconnect()
    await resetChain(fastNode, startTipHeight + 1)

    const tip = await nclient.execute('getblockcount')
    const fastTip = await fastNode.getTip()

    assert.equal(fastTip.height, tip, 'expected tips to be in sync after "restart"')
    setCustomCheckpoint(fastNode)
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
      headerNode.headerindex.startHeight = 0
      await client.close()
    })

    it('should be able to return info about the node', async () => {
      // just want to set it to confirm that it is returned in info
      headerNode.headerindex.startHeight = 10
      const info = await client.getInfo()
      const rpcInfo = await client.execute('getinfo')
      const chain = headerNode.chain
      assert.equal(info.chain.height, chain.height, 'Expected to get back chain height from info endpoint')
      assert(rpcInfo)
      assert.equal(
        rpcInfo.startheight,
        headerNode.headerindex.startHeight,
        'Expected to get back start height from rpc info endpoint'
      )
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
      const rpcHeader = await client.execute('getblockheader', [header.rhash()])
      const rpcHeaderByHeight = await client.execute('getheaderbyheight', [height])

      assert.equal(
        rpcHeader.merkleroot,
        revHex(header.merkleRoot),
        'Expected merkle root returned by server to match with one from header node'
      )
      assert(rpcHeaderByHeight, 'Could not get block by height with rpc')
      assert.equal(
        rpcHeaderByHeight.merkleroot,
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

async function resetChain(node, start = 0, replay = true) {
  // reset chain to custom start
  // can't always reset to 0 because `chaindb.reset`
  // won't work when there is a custom start point
  // because chain "rewind" won't work
  if (replay) await node.chain.replay(start)
  await node.close()
  await node.open()
  await node.connect()
  await node.startSync()

  // let indexer catch up
  await sleep(750)
}
