[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Build Status](https://travis-ci.org/chainpoint/headernode.svg?branch=master)](https://travis-ci.com/chainpoint/headernode)
[![Coverage Status](https://coveralls.io/repos/github/chainpoint/headernode/badge.svg?t=bfNhA9)](https://coveralls.io/github/chainpoint/headernode)

<!---[![npm](https://img.shields.io/npm/l/chainpoint-cli.svg)](https://www.npmjs.com/package/headernode)
[![npm](https://img.shields.io/npm/v/chainpoint-cli.svg)](https://www.npmjs.com/package/headernode)-->

# Bitcoin Header Node

##### A lightweight node for syncing header data w/ as little data as possible from the Bitcoin network

## Background

A bcoin spv node is already very lightweight, around 160MB of chain data on mainnet as of block 568,134.
However, it also stores some extra metadata with the headers. This helps for PoW verification but makes the
headers a little heavier than the minimum [80 bytes per header](https://bitcoin.org/en/glossary/block-header)
(in fact bcoin stores the [chainentry](https://github.com/bcoin-org/bcoin/blob/master/lib/blockchain/chainentry.js)
primitive for spv sync rather than just the headers).

This Header Node implementation reduces the size of the data stored on disk for header syncing by using an in-memory
chain to sync with peers and a separate indexer database to store the headers. This brings the db size down to 76MB
though further optimizations may be possible. The Header Indexer is based on a currently in progress feature
for bcoin that separtes out the indexers (Tx, Address, and Compact Filters) into their own databases and exposes
utilities for custom indexers.

## Installation

Configuration options are the same as with bcoin. See more information
[here](https://github.com/bcoin-org/bcoin/blob/master/docs/configuration.md).

Using from GitHub

```bash
$ git clone https://github.com/chainpoint/headernode
$ cd headernode
$ yarn install
$ ./bin/headernode
```

Mainnet should take between 1-2 hours for initial sync.

## `Fast Sync` with a custom start block

### About Custom Start Blocks

Header Node supports the ability to start syncing from a custom start height rather than syncing a
new header chain from scratch. This can have the advantage of saving space and sync time if you don't need the full history
of previous headers.

This can be a little tricky however since a blockchain by its nature relies on the fact of an unbroken chain
of history connected by hashes going back to the Genesis Block. **Make sure that you trust the block
data you are starting with**. Even if you have an incorrect start block however, unless you're connecting to malicious peers,
the sync will just fail.

### Usage

You need to tell your node you want to start with a custom start point. There are two ways to do this on mainnet: with
the start height or with the raw header data for the start block and _its previous block_ (this is needed for contextual checks).
For other networks, including testnet or regtest, only the raw data will work since the height functionality works by querying
the [btc.com](https://btc.com) API for the target blocks (you can see how this works in the headernode tests for startTip).

Both options, `start-tip` or `start-height`, can be passed as with any
[bcoin Configuration](https://github.com/bcoin-org/bcoin/blob/master/docs/configuration.md).

For example, to start from block 337022, you can pass in the following at runtime:

```bash
$ ./bin/headernode --start-height=337022
```

Alternatively, adding it to a bcoin.conf configuration file in your node's prefix directory or as an environment variable `BCOIN_START_HEIGHT`
will also work. For a start-tip, you must pass in an array of two raw block headers.

## Header Node Client

The Header Node comes with a built-in HTTP server that includes both a REST API and RPC interface (on the backend it uses an
extended instance of the [bweb](https://github.org/bcoin-org/bweb) object used in bcoin)
You can use the `bclient` package to interact with your header node, either installed as a global package with npm and used via CLI
or used directly in a script. Authentication is also supported on the node. A client that wishes to connect will need
an API key if this is enabled.

(Read the [bcoin API docs](http://bcoin.io/api-docs/index.html) for more information on installing and setting up a client).

### Endpoints

#### GET /block/:height

#### GET /header/:height

```js
;(async () => {
  const height = 450000
  // these two requests are equivalent
  await client.getBlock(height)
  await client.get(`/header/${height}`)
})()
```

##### HTTP Response

```json
{
  "hash": "0000000000000000014083723ed311a461c648068af8cef8a19dcd620c07a20b",
  "version": 536870912,
  "prevBlock": "0000000000000000024c4a35f0485bab79ce341cdd5cc6b15186d9b5b57bf3da",
  "merkleRoot": "ff508cf57d57bd086451493f100dd69b6ba7bdab2a0c14254053224d42521925",
  "time": 1485382289,
  "bits": 402836551,
  "nonce": 2972550269,
  "height": 450000,
  "chainwork": "00000000000000000000000000000000000000000036fb5c7c89f1a9eedb191c"
}
```

#### `getblockheader`

The RPC interface is also available

```js
;(async () => {
  const height = 450000
  await client.execute('getblockheader', [height])
})()
```

##### Response

```json
{
  "hash": "0000000000000000014083723ed311a461c648068af8cef8a19dcd620c07a20b",
  "confirmations": 121271,
  "height": 450000,
  "version": 536870912,
  "versionHex": "20000000",
  "merkleroot": "ff508cf57d57bd086451493f100dd69b6ba7bdab2a0c14254053224d42521925",
  "time": 1485382289,
  "mediantime": 1485382289,
  "bits": 402836551,
  "difficulty": 392963262344.37036,
  "chainwork": "00000000000000000000000000000000000000000036fb5c7c89f1a9eedb191c",
  "previousblockhash": "0000000000000000024c4a35f0485bab79ce341cdd5cc6b15186d9b5b57bf3da",
  "nextblockhash": null
}
```

## Testing

There are tests for the header indexer and the header node.

```bash
$ yarn test
```

## Notes

- If the initial sync is interrupted and restarted, you may notice your logs (if they are on and set to level "spam")
  spitting out a bunch of messages about blocks being re-added to the chain.
  This is the in-memory chain getting re-initialized from the headersindex. This is necessary
  for blocks after the network's lastCheckpoint since the chain db is used for certain contextual checks
  when syncing a node, for example handling re-orgs and orphan blocks. We take the header index data that is persisted
  and add these to the chain db so that they are available for these operations.

- The HeaderIndexer takes the place of the chain in several places for the Header Node to avoid some of this
  reliance on the chain which we are not persisting. The custom `HeaderPool` is extended from bcoin's default `Pool` object
  to replace calls to methods normally done by the chain that won't work given that there is no chain (or in the case
  of a custom start point, not even a proper genesis block). The best example is `getLocator` which normally gets block hashes
  all the way back to genesis on the chain, but in our case will run the checks on the header index, and stop early if using
  a custom start point.

- In the unlikely case that you are using a header node on regtest or simnet (such as in the unit tests),
  it is not recommended to use a custom start height. The reason is that there are some different PoW checks that are done
  for testing networks to account for variance in mining hash power. So in a situation where there are no checkpoints or you're
  starting your node _after_ the lastCheckpoint (which is zero for regtest/simnet), the chain will search backwards for old blocks
  to confirm proof of work even if not in a new retargeting interval. Start height initialization will typically account for this
  on testnet and mainnet for example, but since regtest does not have a lastCheckpoint, this can make behavior a little weird.
  For the tests, to confirm that the start height functionality works with checkpoints, we adjust the retarget interval down and
  set a custom lastCheckpoint rather than having to mine over 2k blocks which would slow the tests down.

## TODO:

- [x] Add HTTP and RPC support for retrieving headers with a bcoin compatible client
- [x] Add support to start syncing from a _known_ and _trusted_ header checkpoint (this should speed up
      initial sync and reduce db size further)
- [x] Try and get rid of the locator error in `net` (can be fixed if `getLocator` returns array of just start hash)
- [ ] Investigate other performance improvements such as [compressed headers](https://github.com/RCasatta/compressedheaders)
- [ ] A header chain with custom start point currently can't handle a chain db reset.
      This should be made more robust, even if just throwing an error.
      This weakness can be demonstrated in the fast sync test for headernode,
      where the chain is reset. Reset chain db to 0 and the method will throw
      because it can't rewind the chain properly.
- [ ] Fix or avoid tedious process of re-initializing chain from headers index when past lastCheckpoint
- [ ] Non-deterministic problem where the node gets caught in an infinite loop resolving orphans
      after having synced to tip and the node restarts.

## License

[Apache License, Version 2.0](https://opensource.org/licenses/Apache-2.0)

```txt
Copyright (C) 2019 Tierion

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

See LICENSE for more info.
