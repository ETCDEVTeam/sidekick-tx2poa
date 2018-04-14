
### TLDR

The main idea is that nodes designated as "authorities" by external human consensus and configuration act as "authorized miners," and post a new "proof of authority transaction" for each new block added to the chain. The transaction includes a _signature of the previous block's hash_ made by the authority's private key. If an authorized miner wins the block, the hash of this transaction is included in the 'extraData' field of the mined block and can be used by other nodes to verify.

Minions (non-authority nodes on the sidechain) and authorities validate each new block by confirming that, ultimately, the transaction specified has a valid signature of the previous block's hash as made by the winning miner.

If a block fails this PoA/Tx validation, the block is simply purged.

### TODO
- [x] geth needs a `personal.ecRecover` IPC API point to verify a given signature.

### Run

1. Edit `authorities.js` to include public keys for nodes that should have authority. This list should be identical for each node in the network.
2. Ensure `sidenet/chain.json` configuration specifies `"consensus": "ethash-test"` unless you really like burning electricity.
3. You'll probably want to set up your authority nodes as bootnodes in the config as well.
4. Run:
```
geth --chain=sidenet --ipc-api="personal,miner,eth,web3,debug" --js-path="./tx2poa" --exec="loadScript('tx2poa.js'); delegateAuthorityOrMinion();" console
```

where `delegateAuthorityOrMinion("minion")` will make the node a Minion, otherwise the node will check to see if it holds an authority key at `eth.accounts[0]` (TODO: improve this logic for greater configurability) and can unlock it.

> `personal` and `miner` IPC modules only need to be enabled for authority nodes.

### Notes

1. I'm not sure if this'll actually work.
2. It depends on using `tx.data/input` in a hacky way; instead of using it as compiled contract code it just uses it as a messenging service.
3. Depends on geth making the following IPC modules available `--ipc-apis=personal,miner,eth,web3,debug`.
4. We have to use transactions instead of just header `extraData` because that field is limited to 32 bytes and signature hashes are 65. This is kind of annoying because it would be a lot simpler to just include the signature in the header.
5. It's far faster to use an already-unlocked account for the authorities to sign block hashes. However, this compromises the public `eth` module from being used as a public RPC endpoint. This is a bummer. It means that only Minion nodes are safe to use as RPC endpoints.