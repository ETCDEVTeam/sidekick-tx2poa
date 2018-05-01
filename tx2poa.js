// global variable settings
var minerThreads = 1;
var minerDebounceSleep = 5; // Seconds. Prevent "stuckness" when authority miners create blocks too closely. FIXME: use elective candidacy for miner/sealing authority ordering.

// global cache values
var lastValidBlockNumber = 0;
var cacheAuthorityOrMinion = "";

// convenience loggers
function mustAmMinionOrAuthority() {
	if (cacheAuthorityOrMinion !== "") {return cacheAuthorityOrMinion; }
	cacheAuthorityOrMinion = (eth.accounts.length > 0 && authorities.indexOf(eth.accounts[0]) >= 0) ? "AUTHORITY" : "MINION";
	return cacheAuthorityOrMinion;
}
function logWithPrefix(s) {
	console.log("\n" + mustAmMinionOrAuthority() + "@[" + admin.nodeInfo.id.substring(0,6)+admin.nodeInfo.listenAddr +"]\n", s);
}
function logStatus(action, state, reason, detailsObj) {
	var s = "\n    " + action + ": " + state;
	if (reason !== null) {s += " (" + reason + ")"; }
	s += "\n";
	for (k in detailsObj) {
		if (detailsObj.hasOwnProperty(k)) {
			var v = detailsObj[k];
			if (typeof v === Array) {
				v = v.join(", ");
			}
			if (typeof v === Object) {
				v = JSON.stringify(v);
			}
			s += "\n    " + k + ": " + v;
		}
	}
	logWithPrefix(s);
}

// findPoaTxData finds the relevant "incomplete proof of authority" transaction in a block and returns it's associated data. 
// This is called as a part of the block verification function.
function findPoaTxData(block) {
	var out = {
		ok: false,
		error: "",
		data: {}
	};
	for (var i = 0; i < block.transactions.length; i++) {
		var txH = block.transactions[i];
		// skip if tx hash doesn't match tx hash prefix from blockHeader.extraData field.
		var bed = block.extraData.substring(0,8);
		var txsub = txH.substring(0,8);
		if (bed !== txsub) {
			continue;
		}

		var tx = eth.getTransaction(txH); // assume unlikely tx hash prefix collisions

		if (tx["from"] !== block["miner"]) {
			out.error = "tx.from != block.miner";
			return out;
		}

		var data;
		try {
			data = JSON.parse(web3.toAscii(tx.input));
		} catch(err) {
			out.error = "invalid PoA Tx data";
			return out;
		}
		// Extra sanity checks disabled for now because Javascript.
		// if ((typeof data.sig === "String") && (typeof data.enode === "String")) {
			out.ok = true;
			out.data = data;
			return out;
		// }
	}
	out.error = "no matching tx from header";
	return out;
}

// validateTxAuthority validates the authority of a block
// it returns false if invalid, true if valid
function validateAuthorityByTransaction(block) {
	// gimmes and sanity checks
	//
	// genesis block is automatically OK
	if (block.number === 0) {
		logStatus("VALIDATE", "SUCCESS", "genesis", {
			"block_number": block.number,
			"block_hash": block.hash.substring(0,8)+"..."
		});
		return true
	}

	if (block.transactions.length < 1) {
		logStatus("VALIDATE", "FAIL", "no transactions", {
			"block_number": block.number,
			"block_hash": block.hash.substring(0,8)+"..."
		});
		return false;
	}

	// fail if the block miner (etherBase) is not an established authority
	var authorityIndex = authorities.indexOf(block.miner);
	if (authorityIndex < 0) {
		logStatus("VALIDATE", "FAIL", "miner not authorized", {
			"eth_blockNumber": eth.blockNumber,
			"block_number": block.number,
			"block_hash": block.hash.substring(0,8)+"...",
			"block_miner": block.miner,
			"authorities": authorities
		});
		return false;
	}

	// fail if block does not contain a sufficient poa tx
	var poaTxData = findPoaTxData(block);
	if (!poaTxData.ok) {
		logStatus("VALIDATE", "FAIL", poaTxData.error, {
			"eth_blockNumber": eth.blockNumber,
			"block_number": block.number,
			"block_hash": block.hash,
			"block_transactions": block.transactions,
			"block_miner": block.miner,
		});
		return false;
	}

	// here's the real poa; the rest could easily be forged
	var sig = "0x"+block.extraData.substring(8)+poaTxData.data.sig;
	var rec = personal.ecRecover(eth.getBlock(poaTxData.data.block_number).hash, sig);

	var ok = rec === block.miner;
	if (!ok) {
		logStatus("VALIDATE", "FAIL", "invalid signature", {
			"eth_blockNumber": eth.blockNumber,
			"block_number": block.number,
			"block_hash": block.hash.substring(0,8)+"...",
			"signature": sig,
			"recovered": rec,
			"miner": block.miner
		});
		// admin.dropPeer(data.enode); // this could be forged easily... hm. There might be a way to be sure of the enode with another signature if it's worth it.
		// authorities.splice(authorityIndex, 1);
		return ok; // false
	}
	logStatus("VALIDATE", "SUCCESS", null, {
		"eth_blockNumber": eth.blockNumber,
		"block_number": block.number,
		"block_hash": block.hash.substring(0,8)+"...",
		"signature": sig,
		"recovered": rec,
		"miner": block.miner
	});
	// TODO/NOTE: given a verified block, the associated trusted JSON data could be used to transfer arbitrary
	// network or state data. For example, current authority nodes, dropped nodes, a next-elected authority-sealer candidate address,
	// checkpoint data, etc...
	return ok;
}

// handleValidateAuthority delegates block validation logic.
// It accepts two arguments to be used as callbacks in case of invalid or valid block states,
// each of which receives the block number in question.
function handleValidateAuthority(onInvalid, onValid) {
	var bn = eth.blockNumber;
	var b = eth.getBlock(bn);
	if (!validateAuthorityByTransaction(b)) {
		if (onInvalid !== null) {
				onInvalid(bn);
		}
	} else if (onValid !== null) {
		onValid(bn);
	}
}

// postAuthorityDemonstration is the function an authority node uses to post it's "incomplete proof of authority"
// transaction to the network. Mining is paused while the transaction is created and broadcasted, ensuring
// that the node always includes it's own transaction in it's (maybe winning) block.
function postAuthorityDemonstration(resendableTxObj) {

	// pause miner
	miner.stop();

	function upauseMining() {
		admin.sleep(minerDebounceSleep);
		// A hacky kind of round robin for next-authority miner candidacy.
		// This may not be necessary, and AFAIInteded is just a workaround for
		// preventing a "bouncing" between "competing" authority mining and block validation issue.
		// This only works when there are only two authority nodes.
		// Other, more sophisticated, systems of elegibility for authority mining are easily within reach
		// using the data included in a poatx.
		var i = authorities.indexOf(eth.accounts[0]);
		if (eth.blockNumber % (i+1) === i) {
				miner.start(minerThreads);
		}
	}

	if (resendableTxObj !== null && typeof resendableTxObj !== "undefined" && resendableTxObj.hasOwnProperty("from")) {
		logStatus("AUTHORITY", "RESEND", null, {
			"tx": resendableTxObj,
			"eth_blockNumber": eth.blockNumber,
			"authority": authorityAccount,
			"tx_hash": resendableTxObj.hash.substring(0,8)+"...",
			"data": rawData,
			"signature": sig
		});
		resendableTxObj.nonce++;

		eth.sendTransaction(resendableTxObj);
		upauseMining();
		return resendableTxObj;
	}

	// initialize status pessimistically
	var status = "fail";

	// get the last valid block
	var lastBlockN = 0; // init case as genesis
	if (eth.blockNumber > 0) {
		lastBlockN = eth.blockNumber - 1;
	}
	var lastBlock = eth.getBlock(lastBlockN); // previous block

	// sign the last block hash
	var authorityAccount = eth.accounts[0];
	var sig = eth.sign(authorityAccount, lastBlock.hash);

	// This is the important part.
	// Without splitting the signature hash (and, say, including the whole hash in the tx input field),
	// authority could easily be forged by an attacker node that would just watch transactions and set header
	// data from random authorities' transaction data. I guess it could successfully forge 1/authorities.length blocks.
	// However, by splitting the signature between tx and header, the signature beocmes
	// unknowable and thus unforgeable until the block is mined and broadcasted.
	// eg. "0x3f2c6d378852d4e98c823d1d09e89e0ec5fffbe0d615b408b3a5dfcbaaf5a2e71800a98426e181a4e4945a9d910fe7a2471498c16f266bbd6bb3110318dd75601b"
	var sig_part1 = sig.substring(2,8); // firstchunk: "3f2c6d", smaller because field size limit
	var sig_part2 = sig.substring(8) // secondchunk: "378852d4e98c823d1d09e89e0ec5fffbe0d615b408b3a5dfcbaaf5a2e71800a98426e181a4e4945a9d910fe7a2471498c16f266bbd6bb3110318dd75601b"
	// => sig_part1+sig_part2 = signature hash

	// assemble data to include in poaTx
	var rawData = {
		"sig": sig_part2,
		"block_number": lastBlock.number,
		"enode": admin.nodeInfo.enode
	};
	var d = JSON.stringify(rawData);

	var txObj = {
		"from": authorityAccount,
		"to": authorityAccount,
		"value": web3.toWei(1, 'wei'),

		// use JSON just because we can and it seems extensible
		"data": web3.fromAscii(d).substring(2) // strip 0x
	};

	// broadcast the poa transactions
	var txh = eth.sendTransaction(txObj);
	txObj = eth.pendingTransactions[0];
	logStatus("AUTHORITY", "POST", null, {
		"eth_blockNumber": eth.blockNumber,
		"authority": authorityAccount,
		"tx_hash": txh.substring(0,8)+"...",
		"tx": txObj,
		"data": rawData,
		"signature": sig
	});

	// set tx hash as miner.ExtraData, relevant in case our miner wins
	// the tx substring part aids precision of validation by enabling QueryN=1 eth.getTransaction query 
	// instead of QueryN <= block.transactions.length
	if (!miner.setExtra(txh.substring(0,8)+sig_part1)) {
		logStatus("AUTHORITY", "ERROR", "failed to set miner extra data", {
			"eth_blockNumber": eth.blockNumber,
			"authority": authorityAccount,
			"tx_hash": txh.substring(0,8)+"...",
			"currentBlockNumber": eth.blockNumber
		});

		miner.stop(); // TODO: handle me better maybe
	} else {
		status = "success";
	}

	if (status === "success") {
		upauseMining();
	}

	return txObj;
}

// ensureAuthorityAccount ensures there is an account and that it is unlocked.
// It's a convenience and nice-to-have only.
function ensureAuthorityAccount() {
	var authorityAccount;

	if (eth.accounts.length === 0) {
		// FIXME: method undefined error
			// exit; // sanity check
			logStatus("AUTHORITY", "ERROR", "no accounts exist", {
				"eth_blockNumber": eth.blockNumber
			});
			runMinion();
	} else {
		// Could improve so authority accounts could arbitrary account A from n accounts
		authorityAccount = eth.accounts[0];
	}
	// FIXME: simpler to use --password and --unlock flags. #mvp
	// if (!personal.unlockAccount(authorityAccount)) {
	// 		console.log(admin.nodeInfo.id.substring(0,6)+admin.nodeInfo.listenAddr, "tx2poa", "AUTHORITY", "ERROR", "unlock account", "running minion...")
	// 		runMinion();
	// 	// exit;
	// }
  var ok = miner.setEtherbase(authorityAccount);
	// console.log(admin.nodeInfo.id.substring(0,6)+admin.nodeInfo.listenAddr, "tx2poa", "AUTHORITY", "INIT", authorityAccount, ok);
	if (ok) {
		logStatus("AUTHORITY", "SUCCESS", "initialized", {
			"eth_blockNumber": eth.blockNumber,
			"etherbase": authorityAccount
		});
	} else {
		logStatus("AUTHORITY", "ERROR", "could not set etherbase", {
			"eth_blockNumber": eth.blockNumber,
			"etherbase": authorityAccount
		});
	}

	return ok;
}

// runAuthority runs recursively and continuously asserts the authority of a node
// by sending a transaction to itself per block. If the node's miner wins the block,
// the partial hash of that transaction's poa is included in block's 'extraData' field.
// The function also validates the authority of all incoming blocks.
// FIXME: it might block the normal shutdown mechanism for a geth client
function runAuthority(txo) {
	handleValidateAuthority(
		function onFail(bn) {
				debug.setHead(bn-1);
				txo = postAuthorityDemonstration();
		},
		function onOk(bn) {
			defaultValidCallback(bn);
			txo = postAuthorityDemonstration();
			admin.sleepBlocks(1);
		}
	)

	runAuthority(txo);
}

// defaultInvalidCallback sets the head to the last known valid block number in case 
// an incoming block is determined to be invalid.
var defaultInvalidCallback = function(invalidBlockNumber) {
	debug.setHead(lastValidBlockNumber);
}

// defaultValidCallback is called after a newly-inserted block is determined to have been actually authored by an authority.
var defaultValidCallback = function(validBlockNumber) {
	if (lastValidBlockNumber < validBlockNumber) {
		lastValidBlockNumber = validBlockNumber;
	}
}

// runMinion validates the authority of all incoming blocks.
function runMinion() {
	handleValidateAuthority(defaultInvalidCallback, defaultValidCallback);
	admin.sleepBlocks(1);
	runMinion();
}
