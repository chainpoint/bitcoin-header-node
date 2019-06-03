'use strict'

const assert = require('bsert')
const { Chain, protocol, Miner, Headers, ChainEntry, blockstore } = require('bcoin')
// const BlockStore = require('../lib/blockstore/level');
const { sleep, setCustomCheckpoint } = require('./util/common')
const HeaderIndexer = require('../lib/headerindexer')

const { Network } = protocol
const network = Network.get('regtest')

const blocks = new blockstore.LevelBlockStore({
  memory: true,
  network
})

const chain = new Chain({
  memory: true,
  blocks,
  network
})

const miner = new Miner({
  chain,
  version: 4
})

const cpu = miner.cpu
miner.addresses.length = 0
miner.addAddress('muhtvdmsnbQEPFuEmxcChX58fGvXaaUoVt')

async function mineBlocks(count) {
  assert(chain.opened, 'chain not open')
  assert(miner.opened, 'miner not open')

  for (let i = 0; i < count; i++) {
    const block = await cpu.mineBlock()
    assert(block)
    assert(await chain.add(block))
  }
}

describe('HeaderIndexer', () => {
  let indexer, options, count

  before(async () => {
    options = { memory: true, chain, blocks }
    indexer = new HeaderIndexer(options)
    count = 10

    await blocks.open()
    await chain.open()
    await miner.open()
    await indexer.open()
    // need to let the indexer get setup
    // otherwise close happens too early
    await sleep(500)

    // mine some blocks
    await mineBlocks(count)
    console.log('should it?')
  })

  after(async () => {
    if (indexer.opened) await indexer.close()
    await chain.close()
    await miner.close()
  })

  afterEach(() => {
    // in case something failed, reset lastCheckpoint to 0
    if (indexer.network.lastCheckpoint) setCustomCheckpoint(indexer)
  })

  it('should create a new HeaderIndexer', async () => {
    assert(indexer)
  })

  it('should index headers for 10 blocks by height', async () => {
    let prevBlock

    for (let i = 0; i < count; i++) {
      if (i !== 0) {
        let header = await indexer.getHeader(i)
        header = Headers.fromRaw(header.toRaw())
        if (prevBlock) assert.equal(prevBlock, header.prevBlock.toString('hex'))
        prevBlock = header.hash().toString('hex')
      }
    }
  })

  it('should be able to set a custom checkpoint', async () => {
    // first check that we're starting from a fresh
    assert(!indexer.network.lastCheckpoint, 'lastCheckpoint should be zero when using regtest')
    const checkpoint = await chain.getEntryByHeight(5)
    assert(checkpoint)

    setCustomCheckpoint(indexer, checkpoint.height, checkpoint.hash)

    assert.equal(indexer.network.lastCheckpoint, checkpoint.height, `Indexer's network's lastCheckpoint didn't match`)
    assert.equal(indexer.network.checkpointMap[checkpoint.height], checkpoint.hash, `Indexer's network's  didn't match`)

    // reset checkpoints
    setCustomCheckpoint(indexer)
    assert(!network.lastCheckpoint, 'lastCheckpoint should clear when no args are passed to setCustomCheckpoint')
    assert(
      !Object.keys(network.checkpointMap).length,
      'checkpointMap should clear when no args are passed to setCustomCheckpoint'
    )
  })

  describe('getHeader and getEnry', () => {
    let lastCheckpoint, historicalPoint, nonHistoricalPoint
    beforeEach(async () => {
      lastCheckpoint = 5
      indexer.network.pow.retargetInterval = Math.floor(lastCheckpoint / 2)
      setCustomCheckpoint(indexer, lastCheckpoint)
      historicalPoint = await indexer.getHistoricalPoint()
      nonHistoricalPoint = historicalPoint + 1
    })

    afterEach(async () => {
      indexer.network.pow.retargetInterval = 2016
    })

    it('getHeader should return a header for historical entries', async () => {
      let header = await indexer.getHeader(historicalPoint)
      assert(Headers.isHeaders(header), 'Expected to get a header for a historical entry')
    })

    it('getHeader should return entries for non-historical entries', async () => {
      let entry = await indexer.getHeader(nonHistoricalPoint)
      assert(ChainEntry.isChainEntry(entry), `Expected to get a chain entry for height ${nonHistoricalPoint}`)
    })

    it('getEntry should return the same as getHeader for non-historical entries', async () => {
      let header = await indexer.getHeader(nonHistoricalPoint)
      let entry = await indexer.getEntry(nonHistoricalPoint)
      assert.equal(
        entry.rhash(),
        header.rhash(),
        `getEntry to return same entry for non-historical height ${nonHistoricalPoint}`
      )
    })

    it('getEntry should always return a ChainEntry object', async () => {
      let entry = await indexer.getEntry(nonHistoricalPoint)
      let historicalEntry = await indexer.getEntry(historicalPoint - 1)
      assert(ChainEntry.isChainEntry(entry), `Expected to get a chain entry for height ${nonHistoricalPoint}`)
      assert(
        ChainEntry.isChainEntry(historicalEntry),
        `Expected to get a chain entry for height ${historicalPoint - 1}`
      )
    })
  })

  describe('startTip', () => {
    let startHeight, prevEntry, startEntry, checkpointHeight, newIndexer
    beforeEach(async () => {
      startHeight = 10
      checkpointHeight = indexer.network.pow.retargetInterval * 2.5
      prevEntry = await chain.getEntryByHeight(startHeight - 1)
      startEntry = await chain.getEntryByHeight(startHeight)
    })
    afterEach(async () => {
      setCustomCheckpoint(indexer)
      if (newIndexer && newIndexer.db.loaded) {
        await newIndexer.db.close()
        newIndexer = null
      }
    })

    it('should throw if a startTip is between last retarget height and last checkpoint', async () => {
      const {
        pow: { retargetInterval }
      } = indexer.network

      // this is a change that will effect all other tests since they share the same instance bcoin
      // setting this somewhat arbitrarily since this is just testing the initialization of the chain
      // would not sync correctly since the block at this height doesn't exist
      setCustomCheckpoint(indexer, checkpointHeight)

      const maxStart = checkpointHeight - (checkpointHeight % retargetInterval)

      // need to make copies so it doesn't affect rest of tests
      const prevEntryCopy = ChainEntry.fromJSON(prevEntry.toJSON())
      const startEntryCopy = ChainEntry.fromJSON(startEntry.toJSON())

      // doesn't matter that these entries aren't valid, the only test that should be run on initialization is
      // the serialization and the height. The height should be after last retarget and before lastCheckpoint
      prevEntryCopy.height = maxStart + 1
      startEntryCopy.height = maxStart + 2
      const newOptions = { ...options, startTip: [prevEntryCopy.toRaw(), startEntryCopy.toRaw()] }

      let failed = false
      let message
      try {
        let newIndexer = new HeaderIndexer(newOptions)
        await newIndexer.open()
      } catch (e) {
        failed = true
        message = e.message
      }

      assert(failed, 'Expected HeaderIndexer open to fail')
      assert(
        message.includes('retarget') && message.includes(maxStart.toString()),
        `Expected failure message to mention retarget interval and suggest a new height. Instead it was: ${message}`
      )
    })

    it('should throw for a startHeight that is between last retarget and lastCheckpoint to the retarget block when opened', async () => {
      // this is a change that will effect all other tests since they share the same instance bcoin
      // setting this somewhat arbitrarily since this is just testing the initialization of the chain
      // would not sync correctly since the block at this height doesn't exist
      setCustomCheckpoint(indexer, checkpointHeight)

      const {
        pow: { retargetInterval }
      } = indexer.network

      const newOptions = { ...options, startHeight: retargetInterval * 2.25, chain }
      let fastIndexer = new HeaderIndexer(newOptions)
      const { lastCheckpoint } = fastIndexer.network

      // confirm that our various bootstrapping checkpoints are placed correctly
      assert(
        lastCheckpoint - newOptions.startHeight < retargetInterval &&
          lastCheckpoint - (lastCheckpoint % retargetInterval),
        'Problem setting up the test. Expected start height to before the last checkpoint but after a retarget'
      )

      const maxStart = lastCheckpoint - (lastCheckpoint % retargetInterval)

      let failed = false
      let message
      try {
        await fastIndexer.open()
      } catch (e) {
        message = e.message
        failed = true
      }

      assert(
        failed,
        `indexer should have failed to open with a start height ${newOptions.startHeight} that was after ${maxStart}`
      )
      assert(
        message.includes('retarget') && message.includes(maxStart.toString()),
        `Expected failure message to mention retarget interval and suggest a new height. Instead it was: ${message}`
      )
    })

    it('should properly vaidate startHeights', () => {
      // this is a change that will effect all other tests since they share the same instance bcoin
      // setting this somewhat arbitrarily since this is just testing the initialization of the chain
      // would not sync correctly since the block at this height doesn't exist
      setCustomCheckpoint(indexer, checkpointHeight)
      const {
        lastCheckpoint,
        pow: { retargetInterval }
      } = indexer.network
      const maxStart = lastCheckpoint - (lastCheckpoint % retargetInterval)
      assert.equal(maxStart, indexer.getHistoricalPoint(), `getHistoricalPoint should return max start value`)

      let failed = false
      let message

      try {
        indexer.validateStartHeight(new Buffer.from())
      } catch (e) {
        failed = true
      }

      assert(failed, 'Expected validation to fail when not passed a number')

      failed = false

      try {
        indexer.validateStartHeight(lastCheckpoint + 1)
      } catch (e) {
        failed = true
        message = e.message
      }

      assert(failed, 'Expected validation to fail when passed a height higher than lastCheckpoint')
      assert(
        message.includes(lastCheckpoint.toString()) && message.includes('last checkpoint'),
        'Should have failed with correct message'
      )

      failed = false

      try {
        indexer.validateStartHeight(maxStart + 1)
      } catch (e) {
        failed = true
        message = e.message
      }

      assert(failed, 'Expected validation to fail when passed a non-historical block')
      assert(
        message.includes(lastCheckpoint.toString()) &&
          message.includes('retarget') &&
          message.includes(maxStart.toString()),
        'Should have failed with correct message'
      )
    })

    it('should be able to set and get a startTip', async () => {
      // setting a custom checkpoint so we can set the startTip without throwing an error
      // hash (third arg) can be arbitrary for the purposes of this test
      // since a change on one indexer affects all instances that share the same bcoin, module
      // this will serve for creating a new test indexer later in the test
      setCustomCheckpoint(indexer, checkpointHeight, startEntry.hash)

      const newOptions = { ...options, startTip: [prevEntry.toRaw(), startEntry.toRaw()], logLevel: 'error' }
      const newIndexer = new HeaderIndexer(newOptions)
      await newIndexer.setStartTip()
      const [actualPrev, actualStart] = newIndexer.startTip

      assert.equal(ChainEntry.fromRaw(actualPrev).rhash(), prevEntry.rhash(), "prevEntries for tip didn't match")
      assert.equal(ChainEntry.fromRaw(actualStart).rhash(), startEntry.rhash(), "startEntries for tip didn't match")
      await newIndexer.open()
      const [dbPrev, dbStart] = await newIndexer.getStartTip()
      assert.equal(ChainEntry.fromRaw(dbPrev).rhash(), prevEntry.rhash(), "prevEntries for tip from db didn't match")
      assert.equal(ChainEntry.fromRaw(dbStart).rhash(), startEntry.rhash(), "startEntries for tip from db didn't match")
    })

    it('should return null for getStartTip when none is set', async () => {
      newIndexer = new HeaderIndexer(options)
      await newIndexer.db.open()
      const startTip = await newIndexer.getStartTip()
      assert.equal(startTip, null, 'Expected startTip to be null when none was passed')
    })
  })

  describe('getLocator', () => {
    it('should get an array of hashes from header chain tip back to genesis', async () => {
      const locator = await indexer.getLocator()
      const genesis = await chain.network.genesis
      const tip = chain.tip

      assert.equal(
        locator[0].toString('hex'),
        tip.hash.toString('hex'),
        'Expected first locator hash to equal tip hash'
      )
      assert.equal(
        locator[locator.length - 1].toString('hex'),
        genesis.hash.toString('hex'),
        'Expected last locator hash to equal genesis hash'
      )
    })

    it('should not retrieve or return hashes for blocks older than a custom startHeight', async () => {
      // indexer hasn't been initialized with a custom startHeight yet
      // so we'll add one here and remove it at the end so it doesn't interfere with other tests
      indexer.startHeight = count

      await mineBlocks(10)

      const locator = await indexer.getLocator()
      const expected = await chain.getEntryByHeight(indexer.startHeight)

      assert.equal(
        locator[locator.length - 1].toString('hex'),
        expected.hash.toString('hex'),
        'Last item in locator should be hash of entry at startHeight'
      )

      // reset startHeight
      indexer.startHeight = null
    })
  })
})
