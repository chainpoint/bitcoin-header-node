'use strict'

const assert = require('bsert')
const { Chain, protocol, Miner, Headers, ChainEntry } = require('bcoin')

const { sleep, setCustomCheckpoint } = require('./util/common')
const HeaderIndexer = require('../lib/headerindexer')

const { Network } = protocol
const network = Network.get('regtest')

const chain = new Chain({
  memory: true,
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
  assert(chain.opened)
  assert(miner.opened)

  for (let i = 0; i < count; i++) {
    const block = await cpu.mineBlock()
    assert(block)
    assert(await chain.add(block))
  }
}

describe('HeaderIndexer', () => {
  let indexer, options, count

  before(async () => {
    options = { memory: true, chain }
    indexer = new HeaderIndexer(options)
    count = 10

    await chain.open()
    await miner.open()
    await indexer.open()
    // need to let the indexer get setup
    // otherwise close happens too early
    await sleep(500)

    // mine some blocks
    await mineBlocks(count)
  })

  after(async () => {
    await indexer.close()
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

  it('should move a startHeight that is between last retarget and lastCheckpoint to the retarget block', async () => {
    const checkpoint = await chain.getEntryByHeight(5)
    const {
      pow: { retargetInterval }
    } = indexer.network

    // this is a change that will effect all other tests since they share the same instance bcoin
    // setting this somewhat arbitrarily since this is just testing the initialization of the chain
    // would not sync correctly since the block at this height doesn't exist
    setCustomCheckpoint(indexer, retargetInterval * 2.5, checkpoint.hash)

    const newOptions = { ...options, startHeight: retargetInterval * 2.25, chain }
    let fastIndexer = new HeaderIndexer(newOptions)
    const { lastCheckpoint } = fastIndexer.network

    // confirm that our various bootstrapping checkpoints are placed correctly
    assert(
      lastCheckpoint - newOptions.startHeight < retargetInterval &&
        lastCheckpoint - (lastCheckpoint % retargetInterval),
      'Problem setting up the test. Expected start height to before the last checkpoint but after a retarget'
    )

    const expectedStart = lastCheckpoint - (lastCheckpoint % retargetInterval)
    assert.equal(
      fastIndexer.startHeight,
      expectedStart,
      'indexer start height should have been adjusted back to the last retargetInterval'
    )
  })

  describe('startTip', () => {
    let startHeight, checkpoint, prevEntry, startEntry
    beforeEach(async () => {
      startHeight = 10
      checkpoint = startHeight + 10
      prevEntry = await chain.getEntryByHeight(startHeight - 1)
      startEntry = await chain.getEntryByHeight(startHeight)
    })
    afterEach(() => {
      indexer.network.pow.retargetInterval = 2016
      setCustomCheckpoint(indexer)
    })

    it('should throw if a startTip is between last retarget height and last checkpoint', async () => {
      // somewhat arbitrary, just need block data for testing, will be updated
      // and not valid blocks
      const checkpoint = await chain.getEntryByHeight(5)
      const prevEntry = await chain.getEntryByHeight(6)

      const {
        pow: { retargetInterval }
      } = indexer.network

      // this is a change that will effect all other tests since they share the same instance bcoin
      // setting this somewhat arbitrarily since this is just testing the initialization of the chain
      // would not sync correctly since the block at this height doesn't exist
      setCustomCheckpoint(indexer, retargetInterval * 2.5, checkpoint.hash)

      const { lastCheckpoint } = indexer.network
      // doesn't matter that this block isn't valid, the only test that should be run on initialization is
      // the serialization and the height. The height should be after last retarget and before lastCheckpoint
      const maxStart = lastCheckpoint - (lastCheckpoint % retargetInterval)
      prevEntry.height = maxStart + 1
      const secondBlock = ChainEntry.fromRaw(prevEntry.toRaw())
      secondBlock.height = prevEntry.height + 1

      const newOptions = { ...options, startTip: [prevEntry.toRaw(), secondBlock.toRaw()] }

      let failed = false
      let message
      try {
        new HeaderIndexer(newOptions)
      } catch (e) {
        failed = true
        message = e.message
      }

      assert(failed, 'Expected HeaderIndexer initialization to fail')
      assert(
        message.includes('retarget') && message.includes(maxStart.toString()),
        `Expected failure message to mention retarget interval and suggest a new height. Instead it was: ${message}`
      )
    })

    it('should be able to set and get a startTip', async () => {
      // setting a custom checkpoint so we can set the startTip without throwing an error
      // hash (third arg) can be arbitrary for the purposes of this test
      // since a change on one indexer affects all instances that share the same bcoin, module
      // this will serve for creating a new test indexer later in the test
      setCustomCheckpoint(indexer, checkpoint, startEntry.hash)
      // also need to change retargetInterval for other startTip sanity checks
      indexer.network.pow.retargetInterval = 2
      const newOptions = { ...options, startTip: [prevEntry.toRaw(), startEntry.toRaw()], logLevel: 'error' }
      const newIndexer = new HeaderIndexer(newOptions)
      await newIndexer.setStartTip()
      const [actualPrev, actualStart] = newIndexer.startTip

      assert.equal(ChainEntry.fromRaw(actualPrev).rhash(), prevEntry.rhash(), "prevEntries for tip didn't match")
      assert.equal(ChainEntry.fromRaw(actualStart).rhash(), startEntry.rhash(), "startEntries for tip didn't match")

      const [dbPrev, dbStart] = await newIndexer.getStartTip()
      assert.equal(ChainEntry.fromRaw(dbPrev).rhash(), prevEntry.rhash(), "prevEntries for tip from db didn't match")
      assert.equal(ChainEntry.fromRaw(dbStart).rhash(), startEntry.rhash(), "startEntries for tip from db didn't match")
    })

    it('should return null for getStartTip when none is set', async () => {
      const newIndexer = new HeaderIndexer(options)
      await newIndexer.setStartTip()

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
