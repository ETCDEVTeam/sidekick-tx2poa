// load authorities (array)
// sets
//   var authorities = [...];
loadScript("authorities.js");

// validateTxAuthority validates the authority of a block
// it returns false if invalid, true if valid
function validateAuthorityByTransaction(block) {
	// genesis block is automatically OK
	if (block.number === 0) {
		return true
	}
	// fail if the block miner (etherBase) is not an established authority
	if (authorities.indexOf(block.miner) < 0) {
		return false;
	}
	// fail if block does not contain the transaction specified in it's extra data
	var i = block.transactions.indexOf(block.extraData);
	if (i < 0) {
		return false;
	}
	// fail if the specified transaction is not actually from the mining account
	var tx = eth.getTransactionByHash(block.transactions[i]);
	if (tx.from !== block.miner) {
		return false;
	}
	// // this might be overkill?
	// \x19Ethereum Signed Message:\n%d%s", len(data), data
	return geth.verifySigned(tx.from, tx.input, eth.getBlock(block.number-1).hash) // FIXME: strip hash 0x prefix
}

// ensureOrIgnoreBlockAuthority validates the current block's authority.
// if validation fails, the block is purged and the function returns false.
// if validation succeeds, the function returns true.
function ensureOrIgnoreCurrentBlockAuthority() {
	if (!validateAuthorityByTransaction(eth.getBlock(eth.blockNumber))) {
		debug.setHead(eth.blockNumber-1);
		return false;
	}
	return true;
}

var txObj = {}; // tx obj of last poa tx
var tx = ""; // hash of last poa tx
function postAuthorityDemonstration() {
	var lastBlockN = 0; // init case as genesis
	if (eth.blockNumber > 0) {
		lastBlockN = eth.blockNumber - 1;
	}
	var lastBlock = eth.getBlock(lastBlockN);
	var authorityAccount = eth.accounts[0];
	// post transaction as an authority
	txObj = {
		from: authorityAccount, 
		to: authorityAccount, 
		value: web3.toWei(1, 'wei'),
		data: txpool.sign(authorityAccount, lastBlock.hash) // FIXME strip 0x prefix
	};
	tx = eth.sendTransaction();
	// include this tx hash as 'extraData' in block if our authoritative miner wins
	miner.setExtra(tx);
}

// runAuthority runs recursively and continuously asserts the authority of a node
// by sending a transaction to itself per block. If the node's miner wins the block,
// the hash of that transaction is included in block's 'extraData' field.
// The function also validates the authority of all incoming blocks.
// FIXME: it might block the normal shutdown mechanism for a geth client
function runAuthority() {
	if (ensureOrIgnoreCurrentBlockAuthority()) {
		postAuthorityDemonstration();
	} else {
		// most recent block was invalid and was purged
		// check if latest poa tx is still pending or was included in the block that was purged
		var pending = eth.pendingTransactions();
		var reuseTx = false;
		if (pending.length > 0) {
			for (var i = 0; i < pending.length-1; i++) {
				if (pending[i].hash === tx) {
					reuseTx = true;
					break;
				}
			}	
		}
		// if poa tx was not included and thus removed with the purged invalid block, resend it
		if (reuseTx) {
			eth.resend(txObj);
		} else {
			// otherwise just post a new poa tx
			postAuthorityDemonstration();
		}
	}
	admin.sleepBlocks(1);
	runAuthority();
}

// runMinion validates the authority of all incoming blocks.
function runMinion() {
	ensureOrIgnoreCurrentBlockAuthority();
	admin.sleepBlocks(1);
	runMinion();
}

// ensure there is an account and that it is unlocked
function ensureAuthorityAccount() {
	var authorityAccount;
	if (eth.accounts.length === 0) {
	    exit; // sanity check
	} else {
		// Could improve so authority accounts could arbitrary account A from n accounts
		authorityAccount = eth.accounts[0];
	}

	miner.setEtherbase(authorityAccount);	
}

function delegateAuthorityOrMinion() {
	// If primary account exists as a designated authority (defined in authorities.js), then
	// run authority-proving script.
	if (authorities.indexOf(eth.accounts[0]) >= 0) {
		ensureAuthorityAccount();
		miner.start();
		runAuthority();
	} else {
		runMinion();
	}
}

