# Bitcoin Header Node
##### A lightweight node for syncing header data w/ as little data as possible from the Bitcoin network

## Background
A bcoin spv node is already very lightweight, around ~160MB of chain data on mainnet as of block 568,134.
However, it also stores some extra metadata with the headers. This helps for PoW verification but makes the
headers a little heavier than the minimum [80 bytes per header](https://bitcoin.org/en/glossary/block-header)
(in fact bcoin stores the [chainentry](https://github.com/bcoin-org/bcoin/blob/master/lib/blockchain/chainentry.js)
primitive for spv sync rather than just the headers).

This Header Node implementation reduces the size of the data stored on disk for header syncing by using an in-memory
chain to sync with peers and a separate indexer database to store the headers. This brings the db size down to ~76MB
though further optimizations may be possible. The Header Indexer is based on a currently in progress feature
for bcoin that separtes out the indexers (Tx, Address, and Compact Filters) into their own databases and exposes
utilities for custom indexers.

## Usage
Configuration options are the same as with bcoin. See more information
[here](https://github.com/bcoin-org/bcoin/blob/master/docs/configuration.md).

Using from GitHub
```bash
$ git clone https://github.com/bucko13/headernode
$ cd headernode
$ yarn install
$ ./bin/headernode
```

Mainnet should take between 1-2 hours for initial sync.

## Testing
There are tests for the header indexer and the header node.

```bash
$ yarn test
```

## Notes
If the initial sync is interrupted and restarted, you may notice your logs (if they are on)
spitting out a bunch of messages about blocks being re-added to the chain.
This is the in-memory chain getting re-initialized from the headersindex.
This is necessary since the chain is needed for the initial sync, but since
the chain isn't being persisted, it needs to be re-initialized from our header information.
This could be a potential area for future optimizations. You can this being tested in the headernode
tests where the chain is reset to height `0` and recovered from the header index.

You may also see error messages in the log from the `net` module. This is just the network
pool complaining about not finding the historical chain entries for an initial sync or resync.
Luckily the sync doesn't need this (the `locator` can be empty but an error is thrown regardless
when `chain`'s locator returns null).

## TODO:
- [ ] Add HTTP and RPC support for retrieving headers with a bcoin compatible client
- [ ] Add support to start syncing from a _known_ and _trusted_ header checkpoint (this should speed up
initial sync and reduce db size further)
- [ ] Try and get rid of the locator error in `net` (can be fixed if `getLocator` returns array of just start hash)
- [ ] Investigate other performance improvements such as [compressed headers](https://github.com/RCasatta/compressedheaders)
- [ ] A header chain with custom start point currently can't handle a chain db reset.
This should be made more robust, even if just throwing an error.
This weakness can be demonstrated in the fast sync test for headernode,
where the chain is reset. Reset chain db to 0 and the method will throw
because it can't rewind the chain properly.

## License

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