
### TLDR

The main idea is that nodes designated as "authorities" by external human consensus and configuration act as "authorized miners," and post a new "proof of authority transaction" for each new block added to the chain. If an authorized miner wins the block, the hash of this transaction is included in the 'extraData' field of the mined block and can be used by other nodes to verify.

Minions (non-authority nodes on the sidechain) and authorities validate each new block by this pattern.

If a block fails this PoA/Tx validation, the block is simply purged.

### TODO
- [ ] geth needs a `personal.SignWithoutPassphrase` IPC API point. Currently only `personal.Sign` exists, and requires passphrase argument.
- [ ] geth needs a `geth.ecrecover` IPC API point to verify a given signature.

### Run

1. Edit `authorities.js` to include public keys for nodes that should have authority.
2. Ensure `sidenet/chain.json` configuration specifies `"consensus": "ethash-test"`
3. You'll probably want to set up your authority nodes as bootnodes in the config as well.
4. Run:
```
geth --chain=sidenet --ipc-api="personal,miner,eth,web3" --js-path="./ezpoa" --exec="loadScript('expoa.js')" console
```

> `personal` and `miner` IPC modules only need to be enabled for authority nodes.

### Notes

1. I'm not sure if this'll actually work.
2. I'm not sure if there's anything to be gained from the commented code (search: 'overkill?')
3. Depends on geth making the following IPC modules available `--ipc-apis=personal,miner,eth,web3`