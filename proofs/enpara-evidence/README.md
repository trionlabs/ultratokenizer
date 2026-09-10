# Native Enpara quantity extraction candidate

This separate crate extracts a private, exact available-XAU quantity from a
cryptographically selected PDF revision. It is experimental and native-only.
It does not create an issuance proof, authenticate institution allocation, or
modify the reviewed synthetic profile2 guest. Its own workspace and lockfile keep
the existing guest dependency graph and program identity unchanged.

## Interface and privacy

`extract_available_xau(&VerifiedReviewedRevision) -> Result<AvailableXauStatement>`
accepts only the selected bytes returned by the existing CAdES verifier. There is
no amount argument. The result contains integer milligrams, the snapshot date,
and provenance for the amount, XAU row, available-balance column, gram label and
report date. Each field location identifies its page, content object, font object,
decoded-stream operator offset and fixed-point coordinates. Complete-file,
selected-revision and signed-byte-range digests bind these locations to the input.

Statement, date, provenance and text-location types deliberately have no `Debug`
or serialization implementations. Their accessors are for future private claim
composition. The diagnostic emits only booleans; it does not print quantities,
customer fields, certificate subjects or source paths. Once exact issuance is
public, the selected quantity is also public; this parser does not conceal a
public mint amount.

The `ApprovedRevision` input of the signature primitive is a trust boundary. A
caller-computed complete-file digest and selected prefix length do **not** prove
independent approval. A later institution signature or authenticated policy must
authorize the complete digest, revision choice and claim composition. The bank
signature currently authenticates a financial snapshot, not a current reservation,
wallet holder, stable allocation ID or physical-gold delivery entitlement.

## Supported subset

- At most 512 KiB input, two classic-xref revisions and 255 nonzero objects.
  Physical object definitions must match each revision's xref offsets. Duplicate
  definitions/keys, changed root references, unexpected `/Prev`, encryption,
  object streams and xref streams fail closed. Financial object replacement is
  rejected. Only reviewed catalog/page signature additions and specifically
  referenced metadata/info updates are allowed; these cannot alias accepted
  financial streams.
- Exactly two A4 pages with direct, distinct page children and correctly linked
  parents; bounded content arrays and resources. Active actions, optional content,
  arbitrary forms, rotated/cropped pages and inherited graphs are unsupported.
  Signature widgets must have zero rectangles and empty appearances.
- Raw or Flate streams, at most 256 KiB decoded each and 1 MiB cumulative. External
  streams, decode parameters and incomplete/trailing compressed input are rejected.
  `miniz_oxide` is pinned to 0.8.9, and the low-level decoder's consumed-input count
  is checked in addition to completion status.
- Type0 `Identity-H`, one CIDFontType2 descendant, identity CID-to-glyph mapping,
  embedded sfnt container, bounded widths and a strict two-byte ToUnicode CMap
  subset. Duplicate mappings, control/bidirectional characters and unsupported
  CMap operations are rejected. Only the observed horizontal text, graphics-stack,
  simple path and image operators are accepted. Text positioning includes `Tj`
  advancement and the separate `Td` line matrix.
- The selected field must have the recognized available-balance column headers,
  exactly one XAU account row, matching baseline, explicit gram label on the first
  page, and valid report date. A second XAU row, overlapping text, dark/image
  background or later covering paint at required fields is rejected. Ordinary
  balance is parsed separately and cannot substitute for available balance.
  Currency cells in the supported account-table region must each contain one
  complete uppercase three-letter token or the local-currency label `TL`. Split
  tokens, multiple tokens at overlapping row heights and text crossing cell
  boundaries are rejected; the parser does not infer concatenation. Stroke-bound
  expansion uses checked arithmetic and rejects coordinates outside its range.
  A standalone note spanning the currency column is not a currency cell: it must
  begin left of the column, extend beyond it, contain more than three words and
  no `XAU` marker, and share no vertical interval with another account/currency/
  quantity run. Mixed prose and account cells remain unsupported and rejected.
- Quantities use canonical decimal-comma text with exactly two fraction digits;
  valid optional thousands separators are supported. Conversion is integer
  `whole_grams * 1000 + hundredths * 10`. Zero available quantity, available above
  ordinary balance, negatives, excess precision and rounding are rejected.

This is **authenticated logical text**, not recognition of arbitrary glyph
outlines. Signed ToUnicode mappings and font metrics supply character meaning and
layout. The parser bounds the sfnt container and glyph indices; it does not prove
that arbitrary glyph outlines visually represent those characters, fully validate
TrueType programs, or implement a general PDF renderer. The inspected primary
fonts lack their own Unicode cmap. Renderer equivalence and future template/font
trust therefore remain acceptance-policy work, not a guarantee of native success.

## Validation and local use

```sh
cargo fmt --manifest-path proofs/enpara-evidence/Cargo.toml --check
cargo test --manifest-path proofs/enpara-evidence/Cargo.toml --locked
cargo clippy --manifest-path proofs/enpara-evidence/Cargo.toml --locked --all-targets -- -D warnings
cargo run --manifest-path proofs/enpara-evidence/Cargo.toml --locked --example native_inspect -- \
  <local-pdf> <signer-spki-sha256> <complete-pdf-sha256> <selected-revision-bytes>
```

On 2026-09-10, 21 deterministic synthetic tests and clippy passed. Independent
review findings for fragmented currency rows and stroke-bound overflow were
reproduced by failing regression tests, then repaired. The tests cover
exact quantity/column selection, ambiguous rows/cells, unit labels, hidden or
covered text, unsupported rendering operations, page/content cycles, duplicate
keys/objects, financial updates, xref offsets, external streams, decompression
bounds/trailing input, CMap ambiguity and decimal precision. These fixtures are
fabricated logical PDFs, not bank documents or signed evidence fixtures.

Before the currency-cell review repairs, three privately inspected portfolio reports passed the real CAdES primitive
followed by this native extractor. Both user-supplied Downloads reports also
matched an independent Poppler available-cell extraction and integer-mg conversion.
The tightened currency-cell rule initially misclassified a full-width explanatory
note. A synthetic reproduction and negative mixed-layout cases now cover its
repair. Both supplied reports subsequently passed the actual selected-revision
signature and native extraction again; their SHA-256 digests stayed unchanged.
Only booleans and static diagnostic tags were emitted. The user-authorized private
originals are in an ignored owner-only fixture directory; none is committed,
uploaded, or required by CI. CI synthetic tests cannot stand
in for recurring real-template validation.

## Primary references and remaining work

PDF xrefs select the latest object definitions within the selected revision;
incremental updates do not replace earlier bytes. Text showing advances its text
matrix, while text extraction uses ToUnicode mappings. These are distinct from
visual glyph recognition. See ISO 32000-1:2008 sections 7.5.4, 7.5.6, 9.4.2, 9.4.3
and 9.10.2 in [Adobe's published standard](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf).
The low-level decoder interface returns status, consumed input and output length;
the bounded caller validates all three. Source reviewed from the installed
0.8.9 package, whose recorded VCS commit is
[`44e43c7`](https://github.com/Frommi/miniz_oxide/blob/44e43c7786e379b2b1a7fde4aa0e63be719e583d/miniz_oxide/src/inflate/core.rs).

Before a genuine Enpara issuance: review this parser and its template/font/revision
policy; authenticate source trust and the complete-file/revision approval; verify
the issuer's separate holder/allocation/expiry binding; perform extraction and
exact request-amount comparison inside a separately versioned guest; bind its
claim commitment and stable right ID to the canonical permit; then build, identify,
execute and genuinely prove that guest. Native success closes none of these steps.
