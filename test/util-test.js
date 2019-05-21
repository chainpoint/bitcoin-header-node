'use strict'

const assert = require('bsert')
const { ChainEntry } = require('bcoin')
const utils = require('../lib/util')

describe('utils', () => {
  describe('getRemoteBlockEntries', () => {
    let heights, blockMetaTest, blockMetaMain, expectedMain, expectedTest

    beforeEach(() => {
      heights = [294322, 294323]
      blockMetaMain = [
        {
          hash: utils.fromRev('0000000000000000189bba3564a63772107b5673c940c16f12662b3e8546b412'),
          version: 2,
          prevBlock: utils.fromRev('0000000000000000ced0958bd27720b71d32c5847e40660aaca39f33c298abb0'),
          merkleRoot: utils.fromRev('359d624d37aee1efa5662b7f5dbc390e996d561afc8148e8d716cf6ad765a952'),
          time: 1396684158,
          bits: 419486617,
          nonce: 1225187768,
          height: 294322
        },
        {
          hash: utils.fromRev('00000000000000003883bd7de39066462154e28c6dbf5ecb90d356b7d8910ddc'),
          version: 2,
          prevBlock: utils.fromRev('0000000000000000189bba3564a63772107b5673c940c16f12662b3e8546b412'),
          merkleRoot: utils.fromRev('7bec36b9ee4c8114755f21188ebc7fad7da6144e147918a6326c79bb7a2015a6'),
          time: 1396685483,
          bits: 419486617,
          nonce: 1301373755,
          height: 294323
        }
      ]
      blockMetaTest = [
        {
          hash: utils.fromRev('00000000001be2d75acc520630a117874316c07fd7a724afae1a5d99038f4f4a'),
          version: 2,
          prevBlock: utils.fromRev('000000000024f2b5690d852116dce43768c9c38922e94a5d7e848f7c2514e517'),
          merkleRoot: utils.fromRev('9c66b31403a26d737a7408d00d242fc99761d1c2cc9f2f3f205c79804f22848f'),
          time: 1412364679,
          bits: 457179072,
          nonce: 3733494575,
          height: 294322
        },
        {
          hash: utils.fromRev('00000000002143762d6db1abc355661005947947eb6117ce8bd1e03b2904a2d0'),
          version: 2,
          prevBlock: utils.fromRev('00000000001be2d75acc520630a117874316c07fd7a724afae1a5d99038f4f4a'),
          merkleRoot: utils.fromRev('e3cba7ae7244085266c9f8d3c8221ae3d3e775d58700eb3c51d56c9bb0a23303'),
          time: 1412364681,
          bits: 457179072,
          nonce: 3262081148,
          height: 294323
        }
      ]

      expectedMain = blockMetaMain.map(meta => ChainEntry.fromOptions(meta).toRaw())
      expectedTest = blockMetaTest.map(meta => ChainEntry.fromOptions(meta).toRaw())
    })

    it('should return an array of block entries for each height requested', async () => {
      try {
        let actualMain = await utils.getRemoteBlockEntries('main', ...heights)

        assert(actualMain.length === heights.length)
        actualMain.forEach((raw, index) => assert(raw.toString('hex') === expectedMain[index].toString('hex')))
      } catch (e) {
        if (e.message.includes('Bad response'))
          console.log('The current IP has reached the blockcypher api limit. Cannot complete test.')
        else throw e
      }
    })

    it('should support mainnet and testnet block requests', async () => {
      try {
        let actualTest = await utils.getRemoteBlockEntries('testnet', ...heights)

        assert(actualTest.length === heights.length)
        actualTest.forEach((raw, index) => {
          assert(raw.toString('hex') === expectedTest[index].toString('hex'))
        })
      } catch (e) {
        if (e.message.includes('Bad response'))
          console.log('The current IP has reached the blockcypher api limit. Cannot complete test.')
        else throw e
      }
    })
  })
})
