# Five-minute presentation runbook

Use this runbook for the current Hedera testnet demo. Keep the boundary clear: the document and institution are synthetic, ERC-8004 provides attribution, and the Gate alone enforces issuance.

## Before the presentation

1. Open [the judge page](https://ultratokenizer.trionlabs.dev/judge/) and confirm the document service is reachable. **Live service ready** means a new request may start; **Proof request in progress** means the existing request must be resumed instead.
2. Download **Demo 08 PDF** from that page. Do not edit or re-export it.
3. Open three tabs: **Tokenize**, **How it works** and **Trust**.
4. Select the designated recipient account in MetaMask and switch to Hedera testnet, chain ID `296`.
5. Keep this computer awake. The current document-service bridge is supervised from it.

## Live walkthrough

### 0:00 — State the product

> Ultratokenizer turns an authenticated right into a programmable token. A contract on Hedera refuses to mint unless the document proof, holder consent, issuer permit, reservation and exact amount all agree.

Open the **Judge walkthrough**. Point out the two paths: judges can inspect the evidence and chain without a wallet; the designated holder controls the live issuance.

### 0:40 — Upload the document

Open **Tokenize** and upload Demo 08. Show the fixed `1.000 g` amount, selected synthetic institution and bound recipient.

> The amount is all or nothing. This one-gram allocation can mint exactly one gram once in this Gate. The amount and recipient are public; personal source fields are not placed on chain.

### 1:30 — Start verification

Connect the designated wallet. If no request exists, approve the exact request to start verification. If Demo 08 already reports an existing request, approve the same request only to resume its status; do not create another proof request.

> This first prompt is off-chain consent for the exact request. The signature itself does not mint or spend HBAR from the holder wallet. It lets the issuer service reserve capacity on chain and start paid proof work. SP1 checks the signed structured allocation and produces 224 bytes of public values plus a Groth16 proof.

Leave the status visible. Proof generation is remote and may outlast the presentation, so continue with the architecture while it runs.

### 2:20 — Show enforcement

Open **How it works**.

> Proof generation happens off chain. The service checks a returned proof before creating the mint package, and the Gate repeats and enforces proof verification in the Hedera mint transaction. The issuer reserves the exact declared capacity and signs a short-lived permit. The Gate then checks the proof, wallet, authority, reservation, amount and replay state atomically.

Do not describe program execution, assignment or reservation as a completed proof.

### 3:20 — Show Hedera, ATS and ERC-8004

Open **Trust**, refresh chain state and follow the HashScan and Sourcify links.

> The token uses Hedera Asset Tokenization Studio. Its issuance role belongs to the Gate adapter. ERC-8004 publishes attributable issuer, deployment and auditor declarations. Those records help a reviewer find the parties and pins; they do not grant a licence or bypass the Gate.

Show the current cap, reserved amount, Gate, verifier, token contract and records `116`, `117`, `118`. A visible pending reservation proves only that capacity is set aside. It is not evidence that SP1 returned a proof or that ATS supply increased.

### 4:20 — Complete or report the real state

Return to **Tokenize** and use the status control once.

If the proof is ready, confirm the separate mint transaction in MetaMask. Then show the confirmed transaction, receipt, recipient balance and consumed right. Transfer a small amount from the **Transfer** page as the lifecycle operation.

If the proof is still running or failed, say:

> The contracts and identity records are live, and the request reached the proof path. No token is counted as issued until a verified proof and confirmed Hedera transaction exist. We keep that failure boundary visible instead of substituting a mock proof.

## Claims to avoid

- Do not call the synthetic institution a bank, regulator or independent auditor.
- Do not claim physical backing, custody, redemption, KYC or freeze controls.
- Do not call ERC-8004 an authorization registry.
- Do not call a submitted or executed proof request fulfilled.
- Do not call a wallet signature a transaction.
- Do not claim a mint until the transaction, balance, supply, consumed right and receipt agree.

The technical evidence and current completion status are in [JUDGES.md](JUDGES.md).
