// Copyright 2018 ConsenSys AG
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// -------------------------------------------------------------------------------------------------
// AZTEC library imports
const {	proofs, constants: { ERC20_SCALING_FACTOR } } = require("@aztec/dev-utils");
const devUtils = require('@aztec/dev-utils');
const { JOIN_SPLIT_PROOF, MINT_PROOF } = devUtils.proofs;
const { note, MintProof, JoinSplitProof } = require("aztec.js");
const bn128 = require('@aztec/bn128');
const secp256k1 = require('@aztec/secp256k1');


const lineBreak = "________________________________________________________________________\n";

// -------------------------------------------------------------------------------------------------
// Instantiate contracts: CryptoEngine, proof systems, factories, zkAsset[...]
async function instantiate(besu, txOptions) {
	var instances = {};

	console.log(lineBreak);
	console.log("deploying AZTEC contracts...")

  // get contracts schemas
  let ACE;
  let JOINSPLIT;
  let JOINSPLIT_FLUID;
  let ERC20_MINTABLE;
  let BASE_FACTORY;
  let ADJUSTABLE_FACTORY;
  let ZKASSET_MINTABLE;
  let ZKASSET;

  try {
  ACE                 = await besu.readContract("ACE.json");
	JOINSPLIT           = await besu.readContract("JoinSplit.json");
	JOINSPLIT_FLUID     = await besu.readContract("JoinSplitFluid.json");
	ERC20_MINTABLE	    = await besu.readContract("ERC20Mintable.json");
	BASE_FACTORY        = await besu.readContract("FactoryBase201907.json");
	ADJUSTABLE_FACTORY  = await besu.readContract("FactoryAdjustable201907.json");
	ZKASSET_MINTABLE    = await besu.readContract("ZkAssetMintable.json");
  ZKASSET			        = await besu.readContract("ZkAsset.json");
  } catch (e) {
    console.log(e)
  }

  // deploy crypto engine contract, proof systems and factories
  try {
  instances.ace             = await ACE.new(txOptions);
	instances.joinSplit       = await JOINSPLIT.new(txOptions);
	instances.joinSplitFluid  = await JOINSPLIT_FLUID.new(txOptions);
	instances.erc20			      = await ERC20_MINTABLE.new(txOptions);
  instances.baseFactory		  = await BASE_FACTORY.new(instances.ace.address, txOptions);
  instances.adjustableFactory		  = await ADJUSTABLE_FACTORY.new(instances.ace.address, txOptions);
  } catch (e) {
    console.log(e)
  }

  // Set factories addresses to crypto engine contract 
  try {
  await instances.ace.setFactory(1 * 256 ** 2 + 1 * 256 ** 1 + 1 * 256 ** 0, instances.baseFactory.address, txOptions);
  await instances.ace.setFactory(1 * 256 ** 2 + 1 * 256 ** 1 + 2 * 256 ** 0, instances.adjustableFactory.address, txOptions);
  await instances.ace.setFactory(1 * 256 ** 2 + 1 * 256 ** 1 + 3 * 256 ** 0, instances.adjustableFactory.address, txOptions);
  } catch(e) {
    console.log(e)
  }

  // Deploy Zk Assets
  try {
	instances.zkAssetMintable = await ZKASSET_MINTABLE.new(
		instances.ace.address, 
		instances.erc20.address, 	                      // ERC20 linked address (cannot be none)
		ERC20_SCALING_FACTOR, 				           			 // scaling factor for ERC20 tokens
		0, 										                        	// canMint
		[],  									                        	// canConvert
		txOptions
	);
	instances.zkAsset         = await ZKASSET.new(
		instances.ace.address, 
		instances.erc20.address, 						// ERC20 linked address
		1, 										              // scaling factor for ERC20 tokens
		txOptions
  );
  } catch(e) {
    console.log(e)
  }

  // set CRS and proof systems addresses
	await instances.ace.setCommonReferenceString(bn128.CRS, txOptions);
	await instances.ace.setProof(proofs.JOIN_SPLIT_PROOF, instances.joinSplit.address, txOptions);
  await instances.ace.setProof(proofs.MINT_PROOF, instances.joinSplitFluid.address, txOptions);
	
	console.log("deployed ace at:                " + instances.ace.address);
	console.log("deployed joinSplit at:          " + instances.joinSplit.address);
	console.log("deployed joinSplitFluid at:     " + instances.joinSplitFluid.address);
	console.log("deployed erc20 at:              " + instances.erc20.address);
	console.log("deployed baseFactory at:        " + instances.baseFactory.address);
	console.log("deployed adjustableFactory at:  " + instances.adjustableFactory.address);
	console.log("deployed zkAssetMintable at:    " + instances.zkAssetMintable.address);
	console.log("deployed zkAsset at:            " + instances.zkAsset.address);
	console.log(lineBreak);

	return instances;
};

// -------------------------------------------------------------------------------------------------
// Mint initial supply for a zkAssetMintable
async function mintConfidentialAsset(notes, zkAssetMintable, aztecAccount, txOptions) {
	// sum the value of notes to compute the total supply to mint
 	var totalMintedValue = 0;
	for (i = 0; i < notes.length; i++) { 
  		totalMintedValue += notes[i].k.toNumber();
  }

	// note representing new total supply
	const zeroMintCounterNote = await note.createZeroValueNote(); // old total minted
  const newMintCounterNote = await note.create(aztecAccount.publicKey, totalMintedValue);
  const adjustedNotes  = notes.map(x => x);

  // construct proof
  const sender = txOptions.from;
  const proof = new MintProof(zeroMintCounterNote, newMintCounterNote, adjustedNotes, sender);
  const proofData = proof.encodeABI()

  // sending the transaction on the blockchain
	try {
		let receipt = await zkAssetMintable.confidentialMint(MINT_PROOF, proofData, txOptions)
		console.log("confidentialMint success. events:");
		logNoteEvents(receipt.logs);
		console.log(lineBreak);
	} catch (error) {
		console.log("confidentialMint failed: " + error);
		process.exit(-1);
	}
}

// -------------------------------------------------------------------------------------------------
// Confidential transfer. Destroy inputNotes, creates outputNotes through a joinSplit transaction
async function confidentialTransfer(inputNotes, inputNoteOwners, outputNotes, zkAssetMintable, publicOwner, txOptions, display=true) {
	// compute kPublic, portion of tokens that will be minted from the linked ERC20 token
	var kPublic = 0;
	for (i = 0; i < outputNotes.length; i++) { 
  		kPublic -= outputNotes[i].k.toNumber();
	}
	for (i = 0; i < inputNotes.length; i++) { 
  		kPublic += inputNotes[i].k.toNumber();
  }

  // construct proof
  const proof = new JoinSplitProof(inputNotes, outputNotes, txOptions.from, kPublic, publicOwner);
  const proofData = proof.encodeABI(zkAssetMintable.address);
  const signatures = proof.constructSignatures(zkAssetMintable.address, inputNoteOwners);

	// send the transaction to the blockchain
	try {
    let receipt = await zkAssetMintable.confidentialTransfer(JOIN_SPLIT_PROOF, proofData, signatures, txOptions);
		if(display==true){
			console.log("confidentialTransfer success. events:");
			logNoteEvents(receipt.logs);
			console.log(lineBreak);
		}
		
	} catch (error) {
		console.log("confidentialTransfer failed: " + error);
		process.exit(-1);
	}
}

// -------------------------------------------------------------------------------------------------
// Convert some ERC20 to zkassets
async function shieldsERC20toZkAsset(inputNotes, inputNoteOwners, outputNotes, zkAsset, ace, publicOwner, txOptions) {
	// compute kPublic
	var kPublic = 0;
	for (i = 0; i < outputNotes.length; i++) { 
		kPublic -= outputNotes[i].k.toNumber();
  	}
  for (i = 0; i < inputNotes.length; i++) { 
  kPublic += inputNotes[i].k.toNumber();
  }

  // construct the joinsplit proof
  const proof = new JoinSplitProof(inputNotes, outputNotes, txOptions.from, kPublic, publicOwner);
  const proofData = proof.encodeABI(zkAsset.address);
  const signatures = proof.constructSignatures(zkAsset.address, inputNoteOwners);

  // 2. ace allows proof.hash to spend erc20 tokens on behalf ethereumAccounts[0]
	await ace.publicApprove(
		zkAsset.address,
		proof.hash,
    -kPublic, 
    txOptions
  )
  
	try {
    let receipt = await zkAsset.confidentialTransfer(JOIN_SPLIT_PROOF, proofData, signatures, txOptions);
    logNoteEvents(receipt.logs);
	} catch (error) {
		console.log("deposit failed: " + error);
		process.exit(-1);
	}
	
}

// utility function to display Create and Destroy note event generated by ZkAsset.sol
function logNoteEvents(logs) {
	for (i = 0; i < logs.length; i++) {
		var e = logs[i];
		var toPrint = {event: e.event};
		if (e.event === "CreateNote" || e.event === "DestroyNote") {
			toPrint.owner = e.args.owner;
			toPrint.hash  = e.args.noteHash;
			console.log(JSON.stringify(toPrint, null, 2));	
		} 
	}
}

module.exports = {
	instantiate,
	mintConfidentialAsset,
	confidentialTransfer,
	shieldsERC20toZkAsset,
	secp256k1,
	note
};