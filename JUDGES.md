# Judge walkthrough

Ultratokenizer is a proof-gated token engine deployed on Hedera testnet. The current demo accepts a signed synthetic 1.000 g gold allocation, binds it to one recipient, requests an SP1 Groth16 proof, obtains institution authorization and lets the designated wallet submit the mint. The contract rejects issuance unless every input agrees.

Start at [ultratokenizer.trionlabs.dev/judge](https://ultratokenizer.trionlabs.dev/judge/). The page has two review paths.

## Inspect without a wallet

1. Download the synthetic Demo 08 PDF from the judge page. The same page also
   offers 50 separately signed rights as a signature-and-hash inspection set.
   Only the canonical Demo 08 file is admitted by the live document service.
2. Open **Tokenize**, upload the unchanged Demo 08 PDF and inspect the fixed amount and selected institution.
3. Open **How it works** to follow document authentication, SP1, issuer reservation, the Gate and ATS.
4. Open **Trust** to inspect the Hedera contracts and ERC-8004 Identity records.

Uploading the document does not spend proof funds or mint a token. The PDF is bound to the presenter's test wallet, so another wallet cannot redirect the mint.

The public 50-document archive contains distinct signed rights, their SHA-256
catalog and no witness, private key, proof, permit or mint. It is an offline
inspection corpus, not 50 funded proof jobs. Demo 08 remains the canonical
presenter-led proof attempt.

## Presenter-led live run

1. The presenter connects the designated MetaMask account on Hedera testnet.
2. The wallet signs the complete issuance request. This consent starts proof preparation; it is not a transaction.
3. The UI reports SP1 progress. A completed proof is checked before an issuer permit can be used.
4. The wallet confirms a separate Hedera mint transaction.
5. After confirmation, inspect the recipient balance, supply, consumed right and receipt. Then transfer part of the token as the lifecycle operation.

Never describe an SP1 execution, reservation or wallet signature as a completed proof or mint. The receipt step is complete only after the transaction is confirmed and reconciled.

## What is live

- Hedera testnet Gate: [`0xE1e3…19e3`](https://hashscan.io/testnet/contract/0xE1e3a133335dC0FEeB20397163c16E69F74919e3)
- ATS token contract: [`0xa77e…E64F`](https://hashscan.io/testnet/contract/0.0.10513171)
- SP1 verifier: [`0xC966…c5Be`](https://hashscan.io/testnet/contract/0xC96613d470494347586839B275bFDc56E978c5Be)
- ERC-8004 Identity records: issuer `116`, deployment `117`, auditor declaration `118`
- Public repositories: [Trionlabs](https://github.com/trionlabs/ultratokenizer) and [yamancan](https://github.com/yamancan/ultratokenizer)

The Gate, verifier and ATS graph have exact runtime source matches in Sourcify. Start with the [Gate source](https://repo.sourcify.dev/296/0xE1e3a133335dC0FEeB20397163c16E69F74919e3), [verifier source](https://repo.sourcify.dev/296/0xC96613d470494347586839B275bFDc56E978c5Be) or the key contract links on the live **Trust** page. Source matching is not a security audit.

The ATS graph, Gate and verifier are deployed. The source-matching records are published. A previous proof request exposed a program-identity encoding bug and produced no usable proof; the requester now distinguishes the Succinct network hash from the EVM verifier key. As observed on September 13, 2026 at 19:09 UTC, the corrected Demo 08 request had been submitted and reported executed and assigned, but no proof URI had been returned. Direct Hedera reads showed ATS total supply `0` and designated-holder balance `0`. The honest status is **deployed, with a real proof request in progress and no completed issuance**.

## Prize criteria

| Requirement                               | Evidence                                     | Current status                                  |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Use Asset Tokenization Studio             | Deployed ATS contract graph and Gate adapter | Met for deployment and configuration            |
| Deploy on Hedera testnet                  | HashScan links above and the Trust page      | Met                                             |
| Public repository and source verification | Both repositories and linked source records  | Met                                             |
| Show a lifecycle operation                | Confirmed mint, receipt and transfer         | Must be demonstrated live or in the final video |

The current profile does not claim operational KYC, freeze, redemption or physical custody. It demonstrates proof-gated exact issuance through ATS.

## FAQ

**Does the PDF prove that physical gold exists?** No. It authenticates a synthetic allocation statement. Custody and redemption require a real institutional product design.

**Is the amount private?** No. For this profile, the exact amount and recipient are public. Personal source fields and signing secrets are the protected data.

**Does ERC-8004 authorize the mint or certify a licence?** No. It publishes attributable identity records. The Gate's own registry and checks decide whether issuance is allowed.

**Can a copied PDF mint to another wallet?** No. The signed allocation names the recipient and the Gate also requires that wallet's signature.

**Can one document mint a smaller amount?** No. A 1.000 g allocation can issue exactly 1.000 g once in this Gate, or issue nothing.

**Why are there two wallet prompts?** The first is an off-chain signature that approves the exact request and starts verification. The second submits the on-chain mint after the proof is ready.

**What should a judge trust?** Inspect the deployed code, contract state, proof result, transaction and receipt separately. The UI and ERC-8004 records are navigation and attribution layers; neither can bypass the Gate.

Presenting the project? Follow the timed [presentation runbook](PRESENTATION.md).
