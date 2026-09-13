/**
 * Single source of truth for page identity: titles, descriptions, canonical
 * paths and the machine-readable summaries used by `/llms.txt`, `/sitemap.xml`
 * and the per-route Markdown mirrors. Svelte pages and the build-time generator
 * both read this file, so a new route cannot appear in one and not the other.
 */

export const SITE_ORIGIN = 'https://ultratokenizer.trionlabs.dev';
export const SITE_NAME = 'Ultratokenizer';
export const SITE_TAGLINE = 'zkPDF-backed token issuance on Hedera';

/**
 * The network this project targets. This is a public network fact, not operator
 * configuration: the pinned addresses live in the Git-ignored `deployment.json`.
 */
export const SITE_CHAIN = { name: 'Hedera testnet', id: '296' };
export const SITE_REPOSITORIES = [
  'https://github.com/trionlabs/ultratokenizer',
  'https://github.com/yamancan/ultratokenizer',
];

/**
 * @typedef {object} SitePage
 * @property {string} route Canonical path, always with a trailing slash.
 * @property {string} markdown Path of the Markdown mirror for this route.
 * @property {string} title Document title.
 * @property {string} description Meta description and llms.txt summary.
 * @property {string} priority Sitemap priority.
 * @property {string[]} facts Short factual lines for the Markdown mirror.
 */

/** @type {SitePage[]} */
export const SITE_PAGES = [
  {
    route: '/',
    markdown: '/index.md',
    title: 'Provable tokenization — Ultratokenizer',
    description:
      'Issue the exact approved gold quantity with proof verification, issuer authorization, wallet consent, and a receipt you can inspect independently.',
    priority: '1.0',
    facts: [
      'The token engine: upload a signed gold-right document, verify and mint, then review the result.',
      'The amount is fixed by the document. A 1.000 g allocation issues exactly 1.000 g, once, or nothing.',
      'Two wallet prompts: an off-chain EIP-712 consent signature, then a separate on-chain Hedera mint transaction.',
      'Transfers move the minted token in 0.001 g units as the ATS lifecycle operation.',
      'Network configuration loads from same-origin /deployment.json; nothing is simulated and no sample success state exists.',
    ],
  },
  {
    route: '/demo/',
    markdown: '/demo.md',
    title: 'How it works · Ultratokenizer',
    description:
      'How a signed gold document becomes a token on Hedera: prove it, authorise the amount, mint on chain, then check the result.',
    priority: '0.9',
    facts: [
      'Step 1 — Authenticate: the document service checks the signed allocation and prepares a request-bound public bundle.',
      'Step 2 — Prove: SP1 recomputes the canonical request digest in Rust and commits 224 bytes of ABI-encoded public values with a Groth16 proof.',
      'Step 3 — Authorize: the institution reserves the exact declared capacity on chain and signs a short-lived issuer permit.',
      'Step 4 — Mint: IssuanceGate re-derives the same digest in Solidity and checks proof, holder signature, permit, registry versions, reservation capacity and single-use claim id atomically.',
      'Step 5 — Review: the receipt is reconciled against the confirmed transaction and the exact Gate event.',
      'The same digest is computed independently in TypeScript, Rust and Solidity. A cross-language parity gate runs on adversarial inputs.',
    ],
  },
  {
    route: '/judge/',
    markdown: '/judge.md',
    title: 'Judge walkthrough · Ultratokenizer',
    description:
      'A guided, evidence-first review of the Ultratokenizer Hedera testnet demo: inspect the document, the deployed contracts and the proof path without a wallet.',
    priority: '0.9',
    facts: [
      'Two review paths: inspect the evidence and chain without a wallet, or watch the presenter-led live run.',
      'Wallet-free path: download the synthetic Demo 08 PDF, upload it unchanged, and inspect the fixed amount and bound recipient.',
      'Uploading the document does not request a proof, spend funds or mint anything.',
      'The signed allocation names the recipient, so a copied PDF cannot redirect the mint to another wallet.',
      'Every claim on this page resolves to a HashScan contract, a Sourcify source record or an ERC-8004 identity entry.',
    ],
  },
  {
    route: '/trust/',
    markdown: '/trust.md',
    title: 'Trust and provenance — Ultratokenizer',
    description:
      'Inspect the Gate, SP1 verifier, ATS token graph, issuer roles and ERC-8004 identity records behind this Hedera testnet deployment.',
    priority: '0.8',
    facts: [
      'Reads live chain state for the Gate, the SP1 Groth16 verifier, the ATS token graph and the registered adapter.',
      'Every address is pinned by runtime code hash in /deployment.json, so a swapped contract fails the check instead of passing silently.',
      'ERC-8004 Identity records publish attributable issuer, deployment and auditor declarations. They are attribution, not authorization.',
      'Source-matching records are published in Sourcify. Source matching is not a security audit.',
    ],
  },
  {
    route: '/verify/',
    markdown: '/verify.md',
    title: 'Independent receipt verifier — Ultratokenizer',
    description:
      'Check an issuance receipt against a trust policy obtained separately. Verify local signatures and bindings in a Web Worker, with an optional online SP1 proof check.',
    priority: '0.8',
    facts: [
      'Runs in the browser in an isolated Web Worker. No wallet is required and no receipt data leaves the page for offline checks.',
      'The receipt and the trust policy are two separate files on purpose: a receipt cannot choose who you trust.',
      'Accepts ultratokenizer.issuance-receipt.v1. Historical sample-receipt payloads are rejected.',
      'The optional online check shares public proof inputs with an RPC URL you enter yourself.',
      'Offline checks validate fields, bindings and signatures. They do not authenticate historical authority, token configuration or inclusion.',
    ],
  },
  {
    route: '/institution/',
    markdown: '/institution.md',
    title: 'Institution console — Ultratokenizer',
    description:
      'Review a test issuance, reserve a complete allocation and authorize its mint with an institution wallet.',
    priority: '0.7',
    facts: [
      'The issuer side of the flow: review the authenticated request, reserve the exact allocation, sign the permit.',
      'Allocations are all or nothing. A reservation covers the complete declared quantity or fails.',
      'The permit is short-lived and bound to the canonical request digest and the single-use claim id.',
      'The console never holds the proof or the holder signature. It cannot issue on its own.',
    ],
  },
];

/**
 * @param {string} route
 * @returns {SitePage}
 */
export function sitePage(route) {
  const page = SITE_PAGES.find((entry) => entry.route === route);
  if (!page) throw new Error(`Unknown site route: ${route}`);
  return page;
}
