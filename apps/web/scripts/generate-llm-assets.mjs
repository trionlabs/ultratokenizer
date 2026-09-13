/**
 * Generates the machine-readable layer of the static site: `sitemap.xml`,
 * `llms.txt`, `llms-full.txt` and one Markdown mirror per route. It runs before
 * `vite build` and writes into `static/`, so the dev server, the prerenderer and
 * the deployed build all serve the same files.
 *
 * Every deployed address, code hash and version is read from the same
 * `static/deployment.json` and `static/discovery.json` the application loads, so
 * the published corpus cannot drift from the configuration under test. Those two
 * files are operator-provided and Git-ignored: a clean checkout still builds,
 * and the corpus then omits the pinned sections rather than inventing them.
 * Page titles, descriptions and canonical paths come from `src/lib/site-meta.js`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_NAME,
  SITE_ORIGIN,
  SITE_CHAIN,
  SITE_PAGES,
  SITE_REPOSITORIES,
  SITE_TAGLINE,
} from '../src/lib/site-meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

/**
 * A single lifecycle claim that is only true after a confirmed and reconciled
 * Hedera transaction. Flip this to `true` once the live mint and transfer are
 * confirmed on chain; nothing else in the corpus asserts a completed issuance.
 */
const LIFECYCLE_DEMONSTRATED = false;

const HASHSCAN = 'https://hashscan.io/testnet';
const SOURCIFY = 'https://repo.sourcify.dev/296';

/** @param {string} address */
const contractLink = (address) => `${HASHSCAN}/contract/${address}`;
/** @param {string} address */
const sourceLink = (address) => `${SOURCIFY}/${address}`;

/**
 * The Hedera "Tokenization of Anything" qualification requirements, each bound
 * to evidence a reviewer can open without trusting this page.
 *
 * @param {Record<string, any>} deployment
 * @param {Record<string, any>} discovery
 */
function trackMatrix(deployment, discovery) {
  const policy = deployment.auditPolicy;
  const backend = deployment.backend;
  return [
    {
      requirement:
        'Use the Asset Tokenization Studio (SDK, contracts, web application, or a combination) to issue or manage a tokenised asset.',
      status: 'Met',
      evidence: [
        `The tokenised asset is an ATS token graph deployed on Hedera testnet at ${policy.token}, profile \`${backend.profile}\`, built from upstream commit \`${backend.upstreamCommit}\` of hashgraph/asset-tokenization-studio.`,
        `The deployed graph is a full diamond: ${Object.keys(backend.facets).join(', ')}, with the ${Object.keys(backend.libraries).join(', ')} libraries.`,
        `Issuance authority over that token belongs to \`AtsGateMintAdapter\` at ${backend.adapter.address}, not to a private key. The Studio contracts are extended, not wrapped: the mint role is held by a proof-gated contract.`,
        `The ATS sources are compiled in-repo under \`contracts/ats\` against a pinned solc and checksum-locked sources, and \`npm run check:ats\` performs a fresh pinned build, verification and local EVM acceptance run on every CI run.`,
      ],
    },
    {
      requirement: 'Deploy and demonstrate on Hedera testnet.',
      status: LIFECYCLE_DEMONSTRATED
        ? 'Met'
        : 'Deployment met; live issuance pending',
      evidence: [
        `Chain ID ${policy.chainId} (Hedera testnet), RPC ${deployment.rpcUrl}.`,
        `IssuanceGate ${policy.gate}, SP1 Groth16 verifier ${policy.verifierAddress}, ATS token ${policy.token}.`,
        `The ATS graph was admitted by a reviewed atomic creation transaction, pinned at block ${backend.admission.blockNumber}, transaction ${backend.admission.transactionHash}.`,
        `The live Trust page reads this state from chain on every visit rather than from a fixture.`,
      ],
    },
    {
      requirement:
        'Public GitHub repo, with contracts verified on HashScan where applicable.',
      status: 'Met',
      evidence: [
        `Public repositories: ${SITE_REPOSITORIES.join(' and ')}.`,
        `The Gate, the SP1 verifier and the ATS graph have exact runtime source matches published in Sourcify, which is the verification source HashScan reads: ${sourceLink(policy.gate)} and ${sourceLink(policy.verifierAddress)}.`,
        `Beyond source matching, every address in the deployment is pinned by runtime code hash in /deployment.json, so a swapped implementation fails the client check instead of passing silently. Source matching is not a security audit.`,
      ],
    },
    {
      requirement:
        'Demo video of five minutes or less showing issuance, configuration, and at least one lifecycle operation such as a transfer, compliance check, or distribution.',
      status: LIFECYCLE_DEMONSTRATED
        ? 'Met'
        : 'Pending confirmed mint and transfer',
      evidence: [
        'Configuration: the Trust page shows the live Gate, verifier, ATS token graph, cap, reserved amount and ERC-8004 records, read from chain.',
        'Issuance: the token engine at / implements document authentication, holder consent, SP1 Groth16 proof preparation, issuer reservation and permit, and a separate Gate-enforced Hedera mint. This criterion is not complete until one current-program proof and mint are confirmed.',
        'Lifecycle operation: the Transfer view implements 0.001 g ATS transfers through the transfer and balance-tracker facets. This criterion is not complete until a transaction is recorded after the mint.',
        'The final recording must use these deployed pages and show the resulting public transaction evidence; an animation, local verifier or submitted proof request is insufficient.',
      ],
    },
  ];
}

/**
 * Extra-credit items, split honestly into what the deployed topology actually
 * contains and what this profile deliberately does not claim.
 *
 * @param {Record<string, any>} deployment
 */
function extraCredit(deployment) {
  const backend = deployment.backend;
  return {
    present: [
      `Compliance controls are part of the deployed graph, not a description: \`ControlListFacet\` at ${backend.facets.ControlListFacet.address} enforces transfer restrictions, \`CapFacet\` at ${backend.facets.CapFacet.address} enforces the ${backend.maxSupply} base-unit supply cap, and \`PartitionsFacet\` at ${backend.facets.PartitionsFacet.address} provides the ERC-1400 partition model.`,
      `Scheduled-transaction plumbing is deployed with the graph: \`ScheduledTasksOps\` at ${backend.libraries.ScheduledTasksOps.address} and \`ScheduledTasksDispatchOps\` at ${backend.libraries.ScheduledTasksDispatchOps.address}.`,
      `A compliance control the Studio does not have today: issuance itself is gated by a zero-knowledge proof of an authenticated off-chain right. \`IssuanceGate\` re-derives the EIP-712 request digest in Solidity and refuses to mint unless an SP1 Groth16 proof, the holder signature, the issuer permit, the registry versions, the reserved capacity and a single-use claim id all agree in one atomic transaction.`,
      `Independent verifiability as a first-class feature: every issuance emits a receipt that a third party can re-check offline at /verify/ against a trust policy obtained separately, in an isolated Web Worker, with an optional online SP1 proof check against an RPC endpoint the reviewer chooses.`,
      `The same canonical request digest is computed independently in three languages — TypeScript, Rust and Solidity — and a cross-language parity gate runs on adversarial inputs in CI.`,
    ],
    notClaimed: [
      'Operational KYC onboarding, freeze administration, redemption and physical custody are not claimed. The control-list and cap facets are deployed; this profile does not present a staffed compliance operation.',
      'No secondary market, coupon distribution, royalty flow or price/NAV oracle is claimed for this submission.',
      'The signed gold-right document and the issuing institution are synthetic and self-signed. There is no bank or regulatory endorsement.',
    ],
  };
}

/**
 * @param {Record<string, any>} deployment
 * @param {Record<string, any>} discovery
 */
function architectureSection(deployment, discovery) {
  const policy = deployment.auditPolicy;
  const backend = deployment.backend;
  const registry = discovery.identityRegistry;
  return `## Architecture

The canonical **issuance request** is the spine. Everything else binds to its EIP-712 digest.

1. **Domain.** A versioned issuance request and a distinct issuer permit are normalised — checksummed addresses, lowercase bytes32, integer-only quantities — and reduced to an EIP-712 digest plus a derived single-use \`claimUsageId\`.
2. **Proof.** An SP1 guest program authenticates the signed document capsule, recomputes the same request digest **independently in Rust**, requires the full exact quantity and commits 224 bytes of ABI-encoded public values. Proof system \`${policy.proofSystem}\`, outer version \`${policy.outerVersion}\`, program verification key \`${policy.programVKey}\`.
3. **Gate.** \`IssuanceGate\` at ${policy.gate} re-derives the same digests in Solidity and is the only authority. It checks the SP1 proof against the verifier at ${policy.verifierAddress}, the holder signature, the issuer permit, registry versions, reservation capacity and the single-use \`claimUsageId\`, then mints atomically through the registered adapter.
4. **ATS backend.** \`AtsGateMintAdapter\` at ${backend.adapter.address} mints through the admitted ATS token graph at ${policy.token} (resolver ${backend.resolver.address}, configuration \`${backend.configuration.id}\` version ${backend.configuration.version}). Every facet and library address carries a pinned runtime code hash.
5. **Observation.** A Cloudflare Durable Object groups requests per tenant for read-only reconciliation. It never signs, submits or authorizes anything.
6. **Audit.** An exported receipt is re-checked offline against caller-supplied trust pins, using the same domain definitions and event ABI.
7. **Identity.** ERC-8004 Identity records at ${registry.address} publish attributable issuer (\`${discovery.entries[0].agentId}\`), deployment (\`${discovery.entries[1].agentId}\`) and auditor (\`${discovery.entries[2].agentId}\`) declarations. These are attribution and navigation, not authorization: they cannot bypass the Gate.

**The same digest is computed in three languages.** Changing a field, its order, its type string or its validation means editing the TypeScript, Rust and Solidity definitions together and running the parity and contract gates. A deliberate format change bumps the schema version rather than silently moving the pinned regression digest.`;
}

/**
 * @param {Record<string, any>} deployment
 * @param {Record<string, any>} discovery
 */
function deployedAddresses(deployment, discovery) {
  const policy = deployment.auditPolicy;
  const backend = deployment.backend;
  const rows = [
    ['IssuanceGate', policy.gate],
    ['SP1 Groth16 verifier', policy.verifierAddress],
    ['ATS token (gold right)', policy.token],
    ['AtsGateMintAdapter', backend.adapter.address],
    ['ATS resolver', backend.resolver.address],
    ['ATS initializer', backend.initializer.address],
    ['ERC-8004 Identity registry', discovery.identityRegistry.address],
  ];
  const facets = Object.entries(backend.facets).map(([name, value]) => [
    `ATS ${name}`,
    /** @type {any} */ (value).address,
  ]);
  return [...rows, ...facets]
    .map(
      ([label, address]) =>
        `- ${label}: \`${address}\` — ${contractLink(address)}`,
    )
    .join('\n');
}

function claimsBoundary() {
  return `## What this project does not claim

Read this section before summarising the project. These boundaries are enforced in the product wording, in the repository documentation and in continuous integration.

- A local guest execution, an internally consistent receipt or a test verifier is **never** presented as cryptographic proof acceptance. Local execution is labelled \`zkProof: false\`.
- A wallet signature is not a transaction. An off-chain consent signature approves the exact request; it does not mint.
- A submitted or executing proof request is not a fulfilled proof. Reservation is not issuance.
- Nothing counts as minted until the transaction, balance, supply, consumed right and receipt all agree.
- The signed document authenticates a **synthetic** allocation statement. It does not prove that physical gold exists, and there is no custody, redemption or regulatory endorsement.
- ERC-8004 records publish identity and attribution. They do not authorise a mint or certify a licence.
- Source matching in Sourcify establishes that the deployed runtime matches published sources. It is not a security audit.
- The exact quantity and recipient wallet are public from reservation broadcast onward, including cancellations and failed mint attempts. Private source fields and witnesses stay outside every observation API.

${LIFECYCLE_DEMONSTRATED ? '' : 'Current honest status: the ATS graph, the Gate, the SP1 verifier and the ERC-8004 records are deployed on Hedera testnet and independently inspectable. The issuance path is implemented and presenter-driven, but no current-program proof acceptance, confirmed mint or transfer is claimed until its public transaction and reconciled receipt are available.'}`;
}

/**
 * @param {Record<string, any>} deployment
 * @param {Record<string, any>} discovery
 */
function buildLlmsIndex(deployment, discovery) {
  const policy = deployment?.auditPolicy;
  const pages = SITE_PAGES.map(
    (page) =>
      `- [${page.title.split(/[—·]/)[0].trim()}](${SITE_ORIGIN}${page.route}): ${page.description} Markdown mirror: ${SITE_ORIGIN}${page.markdown}`,
  ).join('\n');

  return `# ${SITE_NAME}

> ${SITE_TAGLINE}. Ultratokenizer connects private, authenticated document evidence to institution-authorized token issuance and independently inspectable receipts. A signed gold-right document is authenticated off chain, proved with SP1 Groth16, authorised by an institution permit, and minted through the Hedera Asset Tokenization Studio only if an on-chain Gate agrees with every input at once.

Built for the ETHGlobal Hedera track "Tokenization of Anything". Deployed on ${SITE_CHAIN.name}, chain ID ${SITE_CHAIN.id}. The token is an ATS graph; the mint role belongs to a proof-gated contract rather than a key holder.

The single most useful file for a language model is [llms-full.txt](${SITE_ORIGIN}/llms-full.txt): it contains the complete deployed address set, the architecture, the qualification-requirement mapping and the explicit claim boundaries.

## Automated review boundary

An unauthorised agent can reproduce the repository tests, inspect deployment and discovery data, compare contract bytecode, and audit a published receipt. It cannot create a new live issuance from public files alone: Demo 08 is bound to the designated presenter wallet, issuer and wallet signing keys are not published, and remote proof fulfillment is an external dependency. Read ${SITE_ORIGIN}/api/config for current readiness; \`readiness.canStart\` is only permission to begin, never evidence of a completed proof or mint.

For a fresh reviewer-led SP1 run, contact [\`@yamanc\` on Telegram](https://t.me/yamanc) and provide only the public EVM recipient address. The operator can prepare a new wallet-bound synthetic allocation and bounded PROVE budget when the prover is available. Never send a private key, seed phrase or wallet export. Funding permits proving; it does not prove completion.

## Pages

${pages}

## Machine-readable deployment data

- [deployment.json](${SITE_ORIGIN}/deployment.json): the exact deployment the application loads — chain, RPC, Gate, verifier, program key, ATS facet graph, and a pinned runtime code hash for every address.
- [discovery.json](${SITE_ORIGIN}/discovery.json): ERC-8004 Identity registry and the issuer, deployment and auditor records.
- [sitemap.xml](${SITE_ORIGIN}/sitemap.xml): canonical URL set.

${
  policy
    ? `## Live contracts on ${SITE_CHAIN.name}

- IssuanceGate: \`${policy.gate}\` — ${contractLink(policy.gate)}
- ATS token: \`${policy.token}\` — ${contractLink(policy.token)}
- SP1 Groth16 verifier: \`${policy.verifierAddress}\` — ${contractLink(policy.verifierAddress)}
- ATS mint adapter: \`${deployment.backend.adapter.address}\` — ${contractLink(deployment.backend.adapter.address)}
- ERC-8004 Identity registry: \`${discovery.identityRegistry.address}\` — ${contractLink(discovery.identityRegistry.address)}`
    : `## Live contracts

This build carries no deployment configuration, so no address is asserted here. The published site serves the pinned set at ${SITE_ORIGIN}/deployment.json and ${SITE_ORIGIN}/discovery.json.`
}

## Source

${SITE_REPOSITORIES.map((url) => `- [${url.replace('https://github.com/', '')}](${url}): public repository, polyglot monorepo — Solidity contracts, Rust SP1 programs, TypeScript domain and audit packages, SvelteKit application.`).join('\n')}${
    policy
      ? `
- [Gate source record](${sourceLink(policy.gate)}): exact runtime source match in Sourcify.
- [Verifier source record](${sourceLink(policy.verifierAddress)}): exact runtime source match in Sourcify.`
      : ''
  }

## Optional

- [Full corpus](${SITE_ORIGIN}/llms-full.txt): everything above plus architecture, the Hedera track requirement mapping, and the claim boundaries.
`;
}

/**
 * @param {Record<string, any>} deployment
 * @param {Record<string, any>} discovery
 */
function buildLlmsFull(deployment, discovery) {
  const pinned = Boolean(deployment && discovery);
  const policy = deployment?.auditPolicy;
  const matrix = pinned ? trackMatrix(deployment, discovery) : [];
  const extras = pinned
    ? extraCredit(deployment)
    : { present: [], notClaimed: [] };

  const matrixText = pinned
    ? matrix
        .map(
          (entry) =>
            `### ${entry.requirement}\n\n**Status: ${entry.status}.**\n\n${entry.evidence.map((line) => `- ${line}`).join('\n')}`,
        )
        .join('\n\n')
    : `This build carries no deployment configuration, so the requirement mapping is not asserted here with addresses. The published site serves it in full at ${SITE_ORIGIN}/llms-full.txt, and the repositories carry it as JUDGES.md.`;

  const pageText = SITE_PAGES.map(
    (page) =>
      `### ${page.title.split(/[—·]/)[0].trim()} — ${SITE_ORIGIN}${page.route}\n\n${page.description}\n\n${page.facts.map((fact) => `- ${fact}`).join('\n')}`,
  ).join('\n\n');

  return `# ${SITE_NAME} — full corpus

> ${SITE_TAGLINE}. This file is the complete, canonical description of the project for language models and automated reviewers.${pinned ? ' Every address and version below is generated from the same deployment configuration the live application loads.' : ''}

Canonical site: ${SITE_ORIGIN}/
Chain: ${SITE_CHAIN.name}, chain ID ${SITE_CHAIN.id}
Repositories: ${SITE_REPOSITORIES.join(' , ')}

## What it is

Ultratokenizer is a proof-gated token engine. It connects private, authenticated document evidence to institution-authorized token issuance and to receipts anyone can inspect independently.

A holder brings a signed gold-right document. The document is authenticated off chain and reduced to a canonical issuance request. An SP1 zero-knowledge program recomputes that request independently in Rust and produces a Groth16 proof committing 224 bytes of public values. The institution reserves the exact declared allocation on chain and signs a short-lived permit. The holder signs the exact request off chain. Only then does \`IssuanceGate\` on Hedera re-derive the same digest in Solidity and mint — through the Asset Tokenization Studio token graph — if and only if the proof, the holder signature, the issuer permit, the registry versions, the reserved capacity and a single-use claim identifier all agree in one atomic transaction.

The amount is all or nothing. A 1.000 g allocation issues exactly 1.000 g, once, or issues nothing. There is no amount editor, because the amount is not an input — it is a consequence of the authenticated document.

## Why it is built this way

Institutional tokenisation fails on the evidence leg, not the token leg. Minting a token is easy; showing an auditor, months later, exactly which authenticated right produced exactly which supply — and letting them re-check it without trusting the issuer's own dashboard — is the hard part. Ultratokenizer puts that check in the contract and then hands out a receipt that a third party can replay offline.

## Hedera "Tokenization of Anything" — qualification requirements

${matrixText}

${
  pinned
    ? `## Extra-credit items present in the deployed system

${extras.present.map((line) => `- ${line}`).join('\n')}

## Extra-credit items deliberately not claimed

${extras.notClaimed.map((line) => `- ${line}`).join('\n')}

${architectureSection(deployment, discovery)}

## Deployed addresses on ${SITE_CHAIN.name}

${deployedAddresses(deployment, discovery)}

Pinned protocol values:

- Proof system: \`${policy.proofSystem}\`, outer version \`${policy.outerVersion}\`
- Program verification key: \`${policy.programVKey}\`
- Issuer id: \`${policy.issuerId}\`, issuer address \`${policy.issuerAddress}\`, key version ${policy.issuerKeyVersion}
- Policy version ${policy.policyVersion}, rights version ${policy.rightsVersion}, profile version ${policy.profileVersion}
- Source id: \`${policy.sourceId}\`
- ATS profile \`${deployment.backend.profile}\`, upstream commit \`${deployment.backend.upstreamCommit}\`, max supply ${deployment.backend.maxSupply} base units
- ATS admission: \`${deployment.backend.admission.kind}\`, block ${deployment.backend.admission.blockNumber}, transaction \`${deployment.backend.admission.transactionHash}\``
    : `## Deployed addresses

This build carries no deployment configuration. The published site serves the complete pinned set — Gate, SP1 verifier, ATS facet graph, adapter and ERC-8004 registry, each with a runtime code hash — at ${SITE_ORIGIN}/deployment.json and ${SITE_ORIGIN}/discovery.json.`
}

## Pages

${pageText}

## How to review this project without trusting it

1. Open ${SITE_ORIGIN}/judge/ and download the synthetic Demo 08 PDF.
2. Upload it unchanged at ${SITE_ORIGIN}/ and read the fixed amount, the selected institution and the bound recipient. Uploading requests no proof and spends nothing.
3. Open ${SITE_ORIGIN}/trust/ and follow the HashScan and Sourcify links for the Gate, the verifier and the ATS graph. Compare them with /deployment.json.
4. Open ${SITE_ORIGIN}/verify/ and re-check an exported receipt against a trust policy you obtained separately. The receipt cannot choose who you trust.
5. Clone either repository and run the gates: \`npm run check\`, \`npm run check:contracts\`, \`npm run check:ats\`, \`npm run check:evidence\`, \`npm run check:parity\`.

## Automated reviewer boundary

A wallet-free agent can reproduce the build and test gates, read \`/deployment.json\`
and \`/discovery.json\`, inspect the pinned Hedera bytecode and state, resolve the
ERC-8004 records, and audit a published receipt. It cannot initiate a new live
issuance from public materials alone. Demo 08 names the designated presenter
wallet, signing keys are intentionally not published, and a remote prover must
return the current program's Groth16 artifact. Read \`/api/config\` for the current
readiness signal. A value of \`readiness.canStart: true\` permits a run to begin;
it does not prove completion.

An automated reviewer with a transaction-signing wallet can request a fresh
reviewer-bound synthetic allocation and bounded PROVE budget for the SP1 job from
[\`@yamanc\` on Telegram](https://t.me/yamanc). It should provide only its public
EVM recipient address and must never transmit a private key, seed phrase or wallet
export. The result is valid only after proof acceptance, the Hedera transaction
and receipt reconciliation all agree.

## Frequently asked questions

**Does the PDF prove that physical gold exists?** No. It authenticates a synthetic allocation statement. Custody and redemption require a real institutional product design.

**Is the amount private?** No. For this profile the exact amount and recipient are public. Personal source fields and signing secrets are the protected data.

**Does ERC-8004 authorise the mint?** No. It publishes attributable identity records. The Gate's own registry and checks decide whether issuance is allowed.

**Can a copied PDF mint to another wallet?** No. The signed allocation names the recipient and the Gate also requires that wallet's signature.

**Can one document mint a smaller amount?** No. A 1.000 g allocation issues exactly 1.000 g once in this Gate, or issues nothing.

**Why are there two wallet prompts?** The first is an off-chain signature approving the exact request, which starts verification. The second submits the on-chain Hedera mint after the proof is ready.

**What should a reviewer trust?** The deployed code, the contract state, the proof result, the transaction and the receipt — each checked separately. The application and the ERC-8004 records are navigation and attribution layers; neither can bypass the Gate.

${claimsBoundary()}
`;
}

/**
 * The Trust page's entire body is chain state fetched after hydration, so a
 * crawler reading its HTML sees headings and nothing else. Its mirror carries
 * the pinned set instead, which is what a reviewer actually came for.
 *
 * @param {import('../src/lib/site-meta.js').SitePage} page
 * @param {Record<string, any> | null} deployment
 * @param {Record<string, any> | null} discovery
 */
function pinnedAppendix(page, deployment, discovery) {
  if (page.route !== '/trust/' || !deployment || !discovery) return '';
  return `\n## Deployed contracts this page reads from chain\n\n${deployedAddresses(
    deployment,
    discovery,
  )}\n\nThe complete set, including every runtime code hash, is served as JSON at ${SITE_ORIGIN}/deployment.json and ${SITE_ORIGIN}/discovery.json.\n`;
}

/**
 * @param {import('../src/lib/site-meta.js').SitePage} page
 * @param {Record<string, any> | null} deployment
 * @param {Record<string, any> | null} discovery
 */
function buildPageMarkdown(page, deployment, discovery) {
  return `# ${page.title.split(/[—·]/)[0].trim()}

> ${page.description}

Canonical page: ${SITE_ORIGIN}${page.route}
Project: ${SITE_NAME} — ${SITE_TAGLINE}, ${SITE_CHAIN.name} chain ID ${SITE_CHAIN.id}.

${page.facts.map((fact) => `- ${fact}`).join('\n')}
${pinnedAppendix(page, deployment, discovery)}
## Elsewhere

${SITE_PAGES.filter((other) => other.route !== page.route)
  .map(
    (other) =>
      `- [${other.title.split(/[—·]/)[0].trim()}](${SITE_ORIGIN}${other.route}): ${other.description}`,
  )
  .join('\n')}

Full project corpus for language models: ${SITE_ORIGIN}/llms-full.txt
`;
}

function buildSitemap() {
  const urls = SITE_PAGES.map(
    (page) =>
      `  <url>\n    <loc>${SITE_ORIGIN}${page.route}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * @param {Record<string, any> | null} deployment
 * @param {Record<string, any> | null} discovery
 * @returns {Record<string, string>}
 */
export function buildLlmAssets(deployment, discovery) {
  const pinned = deployment && discovery ? { deployment, discovery } : null;
  /** @type {Record<string, string>} */
  const assets = {
    'sitemap.xml': buildSitemap(),
    'llms.txt': buildLlmsIndex(pinned?.deployment, pinned?.discovery),
    'llms-full.txt': buildLlmsFull(pinned?.deployment, pinned?.discovery),
  };
  for (const page of SITE_PAGES) {
    assets[page.markdown.replace(/^\//, '')] = buildPageMarkdown(
      page,
      pinned?.deployment ?? null,
      pinned?.discovery ?? null,
    );
  }
  return assets;
}

/** @param {string} name */
async function readOptionalJson(name) {
  try {
    return JSON.parse(await readFile(join(webRoot, 'static', name), 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function main() {
  const deployment = await readOptionalJson('deployment.json');
  const discovery = await readOptionalJson('discovery.json');
  const assets = buildLlmAssets(deployment, discovery);
  for (const [name, contents] of Object.entries(assets)) {
    const target = join(webRoot, 'static', name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  process.stdout.write(
    `generated ${Object.keys(assets).length} machine-readable assets in static/` +
      `${deployment && discovery ? '' : ' (without deployment pins)'}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
