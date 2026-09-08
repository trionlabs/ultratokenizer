use crate::{EvidenceError, MAX_PDF_BYTES};

pub(crate) struct Coverage {
    pub gap_start: usize,
    pub gap_end: usize,
}

fn positions<'a>(bytes: &'a [u8], token: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
    bytes
        .windows(token.len())
        .enumerate()
        .filter_map(move |(index, value)| (value == token).then_some(index))
}

fn skip_space(bytes: &[u8], mut offset: usize) -> usize {
    while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
        offset += 1;
    }
    offset
}

pub(crate) fn validate(pdf: &[u8]) -> Result<Coverage, EvidenceError> {
    if pdf.is_empty() || pdf.len() > MAX_PDF_BYTES {
        return Err(EvidenceError::InputSize);
    }
    if !pdf.starts_with(b"%PDF-1.") || !pdf.trim_ascii_end().ends_with(b"%%EOF") {
        return Err(EvidenceError::UnsupportedPdf);
    }
    let mut markers = positions(pdf, b"/ByteRange");
    let marker = markers.next().ok_or(EvidenceError::AmbiguousSignature)?;
    if markers.next().is_some() {
        return Err(EvidenceError::AmbiguousSignature);
    }
    let start = skip_space(pdf, marker + b"/ByteRange".len());
    if pdf.get(start) != Some(&b'[') {
        return Err(EvidenceError::InvalidByteRange);
    }
    let mut cursor = start + 1;
    let mut ranges = [0usize; 4];
    for value in &mut ranges {
        cursor = skip_space(pdf, cursor);
        let digit_start = cursor;
        while let Some(digit @ b'0'..=b'9') = pdf.get(cursor) {
            *value = value
                .checked_mul(10)
                .and_then(|number| number.checked_add((digit - b'0') as usize))
                .ok_or(EvidenceError::InvalidByteRange)?;
            cursor += 1;
        }
        if cursor == digit_start
            || !pdf
                .get(cursor)
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b']')
        {
            return Err(EvidenceError::InvalidByteRange);
        }
    }
    cursor = skip_space(pdf, cursor);
    if pdf.get(cursor) != Some(&b']') {
        return Err(EvidenceError::InvalidByteRange);
    }
    let [begin, gap_start, gap_end, tail_length] = ranges;
    let signed_end = gap_end
        .checked_add(tail_length)
        .ok_or(EvidenceError::InvalidByteRange)?;
    if begin != 0 || gap_start >= gap_end || gap_end > pdf.len() || signed_end > pdf.len() {
        return Err(EvidenceError::InvalidByteRange);
    }
    if signed_end != pdf.len() {
        return Err(EvidenceError::UnsignedRevision);
    }
    if !(cursor < gap_start || marker >= gap_end) {
        return Err(EvidenceError::InvalidByteRange);
    }

    // Require the excluded range to be exactly a hex-string Contents value.
    // An arbitrary unsigned object, whitespace prefix or extra delimiter is rejected.
    let gap = &pdf[gap_start..gap_end];
    if gap.len() < 4 || gap.first() != Some(&b'<') || gap.last() != Some(&b'>') {
        return Err(EvidenceError::InvalidSignatureGap);
    }
    let hex = &gap[1..gap.len() - 1];
    let hex_count = hex.iter().filter(|byte| byte.is_ascii_hexdigit()).count();
    if hex_count == 0
        || hex_count % 2 != 0
        || !hex
            .iter()
            .all(|b| b.is_ascii_hexdigit() || b.is_ascii_whitespace())
    {
        return Err(EvidenceError::InvalidSignatureGap);
    }
    let mut signature_contents = positions(pdf, b"/Contents").filter_map(|position| {
        let value = skip_space(pdf, position + b"/Contents".len());
        (pdf.get(value) == Some(&b'<')).then_some(value)
    });
    if signature_contents.next() != Some(gap_start) || signature_contents.next().is_some() {
        return Err(EvidenceError::InvalidSignatureGap);
    }
    Ok(Coverage { gap_start, gap_end })
}
