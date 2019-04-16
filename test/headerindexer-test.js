'use strict'

const assert = require('bsert')
const { Chain, protocol, Miner, Headers } = require('bcoin')

const { sleep } = require('./util/common')
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
    // in case something failed, reset lastCheckpoint to 0
    if (indexer.network.lastCheckpoint) indexer.setCustomCheckpoint()
    await indexer.close()
    await chain.close()
    await miner.close()
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

    indexer.setCustomCheckpoint(checkpoint.height, checkpoint.hash)

    assert.equal(indexer.network.lastCheckpoint, checkpoint.height, `Indexer's network's lastCheckpoint didn't match`)
    assert.equal(indexer.network.checkpointMap[checkpoint.height], checkpoint.hash, `Indexer's network's  didn't match`)

    // reset checkpoints
    indexer.setCustomCheckpoint()
    assert(!network.lastCheckpoint, 'lastCheckpoint should clear when no args are passed to setCustomCheckpoint')
    assert(
      !Object.keys(network.checkpointMap).length,
      'checkpointMap should clear when no args are passed to setCustomCheckpoint'
    )
  })

  describe('getLocator', () => {
    it('should get an array of hashes from header chain tip back to genesis', async () => {
      const locator = await indexer.getLocator()
      const genesis = await chain.getEntryByHeight(0)
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
