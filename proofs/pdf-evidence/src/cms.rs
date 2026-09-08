//! A bounded, deliberately narrow shape check before the upstream CMS parser.
//!
//! The upstream parser has unchecked indexing and accepts the first signer. This
//! boundary rejects malformed structures and ambiguous choices before calling it.
//! It does not validate a certificate chain or give an embedded key authority.

use crate::EvidenceError;

const MAX_CMS_BYTES: usize = 64 * 1024;
const MAX_DER_DEPTH: usize = 16;
const MAX_DER_NODES: usize = 2048;
const SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 7, 2];
const DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 7, 1];
const RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1];
const RSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 11];
const SHA256: &[u8] = &[0x60, 0x86, 0x48, 1, 0x65, 3, 4, 2, 1];
const CONTENT_TYPE: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 9, 3];
const MESSAGE_DIGEST: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 9, 4];

struct Element<'a> {
    tag: u8,
    body: &'a [u8],
    encoded: &'a [u8],
    children: Vec<Element<'a>>,
}

type Result<T> = std::result::Result<T, EvidenceError>;

fn require(condition: bool) -> Result<()> {
    condition.then_some(()).ok_or(EvidenceError::InvalidCms)
}

fn element<'a>(input: &mut &'a [u8], depth: usize, budget: &mut usize) -> Result<Element<'a>> {
    require(depth <= MAX_DER_DEPTH && *budget > 0)?;
    *budget -= 1;
    let original = *input;
    let (&tag, rest) = input.split_first().ok_or(EvidenceError::InvalidCms)?;
    // This profile uses only single-byte tags and definite DER lengths.
    require(tag != 0 && tag & 0x1f != 0x1f)?;
    let (&first_length, mut rest) = rest.split_first().ok_or(EvidenceError::InvalidCms)?;
    let length = if first_length < 0x80 {
        usize::from(first_length)
    } else {
        let count = usize::from(first_length & 0x7f);
        require(count > 0 && count <= 4 && rest.len() >= count && rest[0] != 0)?;
        let mut length = 0usize;
        for byte in &rest[..count] {
            length = length
                .checked_mul(256)
                .and_then(|value| value.checked_add(usize::from(*byte)))
                .ok_or(EvidenceError::InvalidCms)?;
        }
        require(length >= 128)?;
        rest = &rest[count..];
        length
    };
    let body = rest.get(..length).ok_or(EvidenceError::InvalidCms)?;
    *input = &rest[length..];
    let encoded = &original[..original.len() - input.len()];
    let mut children = Vec::new();
    if tag & 0x20 != 0 {
        let mut remaining = body;
        while !remaining.is_empty() {
            children.push(element(&mut remaining, depth + 1, budget)?);
        }
        // Empty SEQUENCEs are unsafe in several upstream extraction paths.
        require(tag != 0x30 || !children.is_empty())?;
    }
    // Reject primitive encodings of constructed types, and vice versa.
    if tag & 0xc0 == 0 {
        require((tag & 0x20 != 0) == matches!(tag & 0x1f, 0x10 | 0x11))?;
    }
    Ok(Element {
        tag,
        body,
        encoded,
        children,
    })
}

fn fields(value: &Element<'_>, tag: u8, count: usize) -> Result<()> {
    require(value.tag == tag && value.children.len() == count)
}

fn oid(value: &Element<'_>, expected: &[u8]) -> bool {
    value.tag == 0x06 && value.body == expected
}

fn algorithm(value: &Element<'_>, expected: &[u8]) -> Result<()> {
    require(value.tag == 0x30 && (1..=2).contains(&value.children.len()))?;
    require(oid(&value.children[0], expected))?;
    if let Some(parameters) = value.children.get(1) {
        require(parameters.tag == 0x05 && parameters.body.is_empty())?;
    }
    Ok(())
}

fn positive_integer(value: &Element<'_>) -> Result<()> {
    require(value.tag == 0x02 && !value.body.is_empty())?;
    require(value.body[0] & 0x80 == 0)?;
    require(value.body.len() == 1 || value.body[0] != 0 || value.body[1] & 0x80 != 0)
}

/// Decode exactly the already-validated signature gap, with zero padding only.
pub(crate) fn decode_and_validate(hex_value: &[u8]) -> Result<Vec<u8>> {
    let compact: Vec<u8> = hex_value
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    require(compact.len() <= MAX_CMS_BYTES * 2)?;
    let raw = hex::decode(compact).map_err(|_| EvidenceError::InvalidCms)?;
    let mut remaining = raw.as_slice();
    let mut budget = MAX_DER_NODES;
    let root = element(&mut remaining, 0, &mut budget)?;
    require(remaining.iter().all(|byte| *byte == 0))?;
    validate_content(&root, &mut budget)?;
    Ok(root.encoded.to_vec())
}

fn validate_content(root: &Element<'_>, budget: &mut usize) -> Result<()> {
    fields(root, 0x30, 2)?;
    require(oid(&root.children[0], SIGNED_DATA))?;
    let wrapper = &root.children[1];
    fields(wrapper, 0xa0, 1)?;
    let signed = &wrapper.children[0];
    fields(signed, 0x30, 5)?;
    let data = &signed.children;
    require(data[0].tag == 0x02 && data[0].body == [1])?;
    fields(&data[1], 0x31, 1)?;
    algorithm(&data[1].children[0], SHA256)?;
    fields(&data[2], 0x30, 1)?;
    require(oid(&data[2].children[0], DATA))?;

    // A single embedded certificate removes serial-only selection ambiguity.
    fields(&data[3], 0xa0, 1)?;
    let certificate = &data[3].children[0];
    fields(certificate, 0x30, 3)?;
    let tbs = &certificate.children[0];
    require(tbs.tag == 0x30 && (7..=10).contains(&tbs.children.len()))?;
    let cert = &tbs.children;
    fields(&cert[0], 0xa0, 1)?;
    require(cert[0].children[0].tag == 0x02 && cert[0].children[0].body == [2])?;
    positive_integer(&cert[1])?;
    algorithm(&cert[2], RSA_SHA256)?;
    algorithm(&certificate.children[1], RSA_SHA256)?;
    require(certificate.children[2].tag == 0x03)?;
    for name in [&cert[3], &cert[5]] {
        require(name.tag == 0x30 && name.children.iter().all(|part| part.tag == 0x31))?;
    }
    fields(&cert[4], 0x30, 2)?;
    require(
        cert[4]
            .children
            .iter()
            .all(|date| matches!(date.tag, 0x17 | 0x18)),
    )?;
    require(
        cert[7..]
            .iter()
            .all(|extra| matches!(extra.tag, 0x81 | 0x82 | 0xa3)),
    )?;
    let spki = &cert[6];
    fields(spki, 0x30, 2)?;
    algorithm(&spki.children[0], RSA)?;
    let bits = &spki.children[1];
    require(bits.tag == 0x03 && bits.body.first() == Some(&0))?;
    let mut key_bytes = &bits.body[1..];
    let key = element(&mut key_bytes, 0, budget)?;
    require(key_bytes.is_empty())?;
    fields(&key, 0x30, 2)?;
    positive_integer(&key.children[0])?;
    positive_integer(&key.children[1])?;

    fields(&data[4], 0x31, 1)?;
    let signer = &data[4].children[0];
    fields(signer, 0x30, 6)?;
    let info = &signer.children;
    require(info[0].tag == 0x02 && info[0].body == [1])?;
    fields(&info[1], 0x30, 2)?;
    positive_integer(&info[1].children[1])?;
    require(info[1].children[1].body == cert[1].body)?;
    require(info[1].children[0].encoded == cert[3].encoded)?;
    algorithm(&info[2], SHA256)?;
    require(info[3].tag == 0xa0 && (2..=32).contains(&info[3].children.len()))?;
    require(info[3].body.len() <= u16::MAX as usize)?;
    let mut attribute_oids = Vec::new();
    let mut content_type = false;
    let mut message_digest = false;
    for attribute in &info[3].children {
        fields(attribute, 0x30, 2)?;
        let id = &attribute.children[0];
        require(id.tag == 0x06 && !attribute_oids.contains(&id.body))?;
        attribute_oids.push(id.body);
        let values = &attribute.children[1];
        fields(values, 0x31, 1)?;
        if oid(id, CONTENT_TYPE) {
            require(oid(&values.children[0], DATA))?;
            content_type = true;
        }
        if oid(id, MESSAGE_DIGEST) {
            require(values.children[0].tag == 0x04 && values.children[0].body.len() == 32)?;
            message_digest = true;
        }
    }
    require(content_type && message_digest)?;
    algorithm(&info[4], RSA).or_else(|_| algorithm(&info[4], RSA_SHA256))?;
    require(info[5].tag == 0x04 && info[5].body.len() == 256)
}
