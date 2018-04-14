// load authorities (array)
// sets
//   var authorities = [...];
loadScript("authorities.js");

// TODO: I think this might be slow. Is there a faster way?
function findPoaTxData(block) {
	for (var i = 0; i < block.transactions.length-1; i++) {
		var txH = block.transactions[i];
		// skip if tx hash doesn't match tx hash prefix from blockHeader.extraData field.
		if (block.extraData.substring(0,8) !== txH.substring(0,8)) {
			continue;
		}
		var tx = eth.getTransactionByHash(txH); // assume unlikely tx hash prefix collisions
		if (tx.from !== block.miner) {
			return false; 
		}
		var data;
		try {
			data = JSON.parse(web3.toAscii(tx.data));
		} catch(err) {
			console.log("invalid PoA Tx data for Tx:", tx);
			return false;
		}
		if ((typeof data.sig === "String") && (typeof data.enode === "String")) {
			return data;
		}
	}
	return false;
}

// validateTxAuthority validates the authority of a block
// it returns false if invalid, true if valid
function validateAuthorityByTransaction(block) {
	// gimmes and sanity checks
	// 
	// genesis block is automatically OK
	if (block.number === 0) {
		return true
	}
	// fail if the block miner (etherBase) is not an established authority
	var authorityIndex = authorities.indexOf(block.miner);
	if (authorityIndex < 0) {
		return false;
	}
	// fail if block does not contain a sufficient poa tx
	var txdata = findPoaTxData(block);
	if (txdata === false) {
		return false;
	}
	// here's the real poa; the rest could easily be forged
	var ok = personal.ecRecover(eth.getBlock(block.number-1).hash, block.extraData.substring(8)+txdata.sig) == block.miner;
	if (!ok) {
		// admin.dropPeer(data.enode); // this could be forged easily... hm. There might be a way to be sure of the enode with another signature if it's worth it.
		authorities.splice(authorityIndex, 1);
		return ok; // false
	}
	return ok;
}

// ensureOrIgnoreBlockAuthority validates the current block's authority.
// if validation fails, the block is purged and the function returns false.
// if validation succeeds, the function returns true.
function ensureOrIgnoreCurrentBlockAuthority() {
	var b = eth.getBlock(eth.blockNumber);
	if (!validateAuthorityByTransaction(b)) {
		console.log("tx2poa", "VALIDATE", "FAIL", b);
		debug.setHead(eth.blockNumber-1);
		return false;
	}
	console.log("tx2poa", "VALIDATE", "OK", b.number);
	return true;
}

var txObj = {}; // tx obj of last poa tx
var tx = ""; // hash of last poa tx
function postAuthorityDemonstration() {
	var lastBlockN = 0; // init case as genesis
	if (eth.blockNumber > 0) {
		lastBlockN = eth.blockNumber - 1;
	}
	var lastBlock = eth.getBlock(lastBlockN); // previous block
	var authorityAccount = eth.accounts[0];

	var sig = eth.sign(authorityAccount, lastBlock.hash);

	// This is the important part.
	// Without splitting the signature hash (and, say, including the whole hash in the tx input field),
	// authority could easily be forged by an attacker node that would just watch transactions and set header
	// data from random authorities' transaction data. I guess it could successfully forge 1/authorities.length blocks.
	// However, by splitting the signature between tx and header, the signature beocmes
	// unknowable and thus unforgeable until the block is mined and broadcasted.
	// eg. "0x3f2c6d378852d4e98c823d1d09e89e0ec5fffbe0d615b408b3a5dfcbaaf5a2e71800a98426e181a4e4945a9d910fe7a2471498c16f266bbd6bb3110318dd75601b"
	var sigHeaderChunk = sig.substring(0,8); // firstchunk: "0x3f2c6d", smaller because field size limit
	var sigTxChunk = sig.substring(8) // secondchunk: "378852d4e98c823d1d09e89e0ec5fffbe0d615b408b3a5dfcbaaf5a2e71800a98426e181a4e4945a9d910fe7a2471498c16f266bbd6bb3110318dd75601b"
	// => sigHeaderChunk+sigTxChunk = signature hash

	// post transaction as an authority
	var d = JSON.stringify({
		"sig": sigTxChunk,
		"enode": admin.nodeInfo.enode
	});
	txObj = {
		from: authorityAccount, 
		to: authorityAccount, 
		value: web3.toWei(1, 'wei'),
		// use JSON just because we can and it seems extensible
		data: web3.fromAscii(d)
	};
	tx = eth.sendTransaction();
	// include this tx hash within 'extraData' in block if our authoritative miner wins.
	// prefix sigHeaderChunk with tx hash substring for single-query validation.
	if (!miner.setExtra(tx.substring(0,8)+sigHeaderChunk)) {
		console.log("tx2poa", "AUTHORITY", "ERROR", "failed to set miner extra", tx, "becoming a Minion instead...");
		tx = "err";
		miner.stop(); // TODO: handle me better maybe
	} else {
		console.log("tx2poa", "AUTHORITY", "OK", tx, txObj);
	}
}

// runAuthority runs recursively and continuously asserts the authority of a node
// by sending a transaction to itself per block. If the node's miner wins the block,
// the partial hash of that transaction's poa is included in block's 'extraData' field.
// The function also validates the authority of all incoming blocks.
// FIXME: it might block the normal shutdown mechanism for a geth client
function runAuthority() {
	if (tx === "err") {
		admin.sleepBlocks(1);
		runMinion();
	}
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
			console.log("         ", "resending", txObj);
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
	if (!personal.unlockAccount(authorityAccount)) {
		exit;
	}
	miner.setEtherbase(authorityAccount);	
	console.log("tx2poa", "AUTHORITY", "INIT", authorityAccount);
}

function delegateAuthorityOrMinion(beMinion) {
	if (beMinion === "minion") {
		console.log("Running as Minion...");
		runMinion();
	} else if (authorities.indexOf(eth.accounts[0]) >= 0) {
		console.log("Found authority key, running as Authority...");
		ensureAuthorityAccount();
		miner.start();
		runAuthority();
	} else {
		console.log("Running as Minion...");
		runMinion();
	}
}

