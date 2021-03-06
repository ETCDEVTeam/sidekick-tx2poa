# ETCDEVTeam/sidekick-*

> A collection of scripts and documents outlining requirements and initial adhoc solves for a minimum-viable ETC sidechains implementation.

- [github.com/ETCDEVTeam/sidekick-tx2poa](http://github.com/ETCDEVTeam/sidekick-tx2poa). A PoA mechanism implemented through an emphemeral JS console.

- [github.com/ETCDEVTeam/sidekick-liaison](http://github.com/ETCDEVTeam/sidekick-liaison). A bash script that listens to a sidechain node and facilitates communication with an arbitrary mainnet node. As written, relies on [emerald-cli](https://github.com/ETCDEVTeam/emerald-cli).

- [github.com/ETCDEVTeam/sidekick-checkpointer](http://github.com/ETCDEVTeam/sidekick-checkpointer). A checkpointing mechanism implemented through an ephemeral JS console.

# sidekick-tx2poa: Transaction+Header PoA

The main idea is that nodes designated as [./authorities.js](./authorities.js) by configuration act as "authorized miners," and post a new "incomplete proof of authority transaction" for each new block added to the chain. This transaction contains an incomplete chunk of the miner's signature of the previous block's hash, which together with the rest of the signature found in the winning miner's block's `extraData` field can be used to verify that the block was indeed mined by an authoritative miner.

This method of determining a PoA consensus does not require any protocol changes and utilizes only pre-existing tools and methods. Like a protocol-based PoA, it assumes that all nodes in the sidechain network can run equivalent or compatible configurations and agree on a list of pre-configured "authority" nodes described by public key addresses.

### Details

Authority nodes assert a proof of their identity by creating a signature `S` made by the authority's private key `Mpriv` of the previous block's hash `H`.

```
S = eth.sign(Mpub, H)
```

Since signatures are 65 bytes long, they're too big to fit into a block header's `extraData` field limited to 32 bytes. Instead, `S` is "chunked" into `s1` and `s2`, where as a concatenated string `s1+s2 == S`. As-is, `s1` has length of 8 and `s2` has a string length of 124 including the `0x` prefix, but this is a mostly arbitrary number within field size limit bounds.

`s1` is then set by the authority node `M` as it's `extraData` field value, and `s2` is included as transaction `data` in a transaction that is created and broadcasted to the network for each new block.

If miner `M` wins the block, any node on the network can verify it's authority by using `EcRecover` to verify that

```
s1 = currentBlock.extraData.substring(8); // chunk1
s2 = poaTx.sig // chunk2
S = s1 + s2;
personal.ecRecover(H, S) == Mpub == currentBlock.miner == poaTx.From;
```

where together the transaction and block header contain the valid signature for the previous block's hash as made by `Mpriv`.

If a block fails this PoA/Tx validation, the block is simply purged.

### TODO
- [x] geth needs a `personal.ecRecover` IPC API point to verify a given signature. https://github.com/ethereumproject/go-ethereum/pull/566

### Run

> A working configuration for a private network using this Tx2PoA can be found here [github.com/ETCDEVTeam/sidekick-poc](http://github.com/ETCDEVTeam/sidekick-poc).

1. Edit `authorities.js` to include public keys for nodes that should have authority. This list should be identical for each node in the network.
2. Ensure `sidenet/chain.json` configuration specifies `"consensus": "ethash-test"` unless you really like burning electricity.
3. You'll probably want to set up your authority nodes as bootnodes in the config as well.
4. Run:
```
$ geth --chain=sidenet --ipc-api="personal,miner,eth,web3,debug" --js-path="./sidekick-tx2poa" --unlock 0 --password path/to/password.file js path/to/authority.js

OR

$ geth --chain=sidenet --ipc-api="eth,web3,debug" --js-path="./sidekick-tx2poa" js path/to/minion.js
```

### Notes

2. I don't know if it will be very scalable.
3. It depends on using `tx.data[|input]` in a hacky way; instead of using it as compiled contract code it just uses it as a JSON messenging service.
4. Depends on geth making the following IPC modules available `--ipc-apis=personal,miner,eth,web3,debug`.
5. We have to use transactions instead of just header `extraData` because that field is limited to 32 bytes and signature hashes are 65. This is kind of annoying because it would be a lot simpler to just include the signature in the header.
6. It's far faster to use an already-unlocked account for the authorities to sign block hashes. However, this compromises the public `eth` module from being used as a public RPC endpoint. This is a bummer. It means that only Minion nodes are safe to use as RPC endpoints.
7. `personal` and `miner` IPC modules only need to be enabled for authority nodes.
