use crate::{
    pdf::{field, named, Document, Id, Parser, Value, SCALE},
    Error, Result,
};
use std::collections::BTreeMap;

pub(crate) struct Font {
    pub id: Id,
    map: BTreeMap<u16, char>,
    widths: BTreeMap<u16, i64>,
    default_width: i64,
    ascent: i64,
    descent: i64,
}
impl Font {
    pub fn read(doc: &mut Document<'_>, id: Id) -> Result<Self> {
        let d = doc.dictionary(id)?.clone();
        if !named(&d, "Type", "Font")
            || !named(&d, "Subtype", "Type0")
            || !named(&d, "Encoding", "Identity-H")
        {
            return Err(Error::Font);
        }
        let descendants = field(&d, "DescendantFonts")?.array()?;
        if descendants.len() != 1 {
            return Err(Error::Font);
        }
        let cid = doc.dictionary(descendants[0].reference()?)?.clone();
        if !named(&cid, "Type", "Font")
            || !named(&cid, "Subtype", "CIDFontType2")
            || !named(&cid, "CIDToGIDMap", "Identity")
        {
            return Err(Error::Font);
        }
        let descriptor = doc.dictionary(field(&cid, "FontDescriptor")?.reference()?)?;
        if !named(descriptor, "Type", "FontDescriptor")
            || descriptor.contains_key("FontFile")
            || descriptor.contains_key("FontFile3")
        {
            return Err(Error::Font);
        }
        let file = field(descriptor, "FontFile2")?.reference()?;
        if doc
            .dictionary(file)?
            .keys()
            .any(|key| !["Length", "Length1", "Filter"].contains(&key.as_str()))
        {
            return Err(Error::Font);
        }
        let ascent = field(descriptor, "Ascent")?.number()?;
        let descent = field(descriptor, "Descent")?.number()?;
        if !(500 * SCALE..=1200 * SCALE).contains(&ascent) || !(-500 * SCALE..=0).contains(&descent)
        {
            return Err(Error::Font);
        }

        let glyphs = sfnt_glyph_count(&doc.decode(file)?)?;

        let unicode = field(&d, "ToUnicode")?.reference()?;
        if doc
            .dictionary(unicode)?
            .keys()
            .any(|key| !["Length", "Filter"].contains(&key.as_str()))
        {
            return Err(Error::Font);
        }
        let map = cmap(&doc.decode(unicode)?)?;

        if map.keys().any(|cid| *cid >= glyphs) {
            return Err(Error::Font);
        }
        let mut widths = BTreeMap::new();
        if let Some(w) = cid.get("W") {
            let mut values = w.array()?.iter();
            while let Some(first) = values.next() {
                let first = u16::try_from(first.integer()?).map_err(|_| Error::Font)?;
                match values.next().ok_or(Error::Font)? {
                    Value::Array(list) => {
                        for (offset, w) in list.iter().enumerate() {
                            insert_width(&mut widths, usize::from(first) + offset, w.number()?)?;
                        }
                    }
                    last => {
                        let last = last.integer()?;
                        let width = values.next().ok_or(Error::Font)?.number()?;
                        if last < usize::from(first) || last - usize::from(first) > 1024 {
                            return Err(Error::Font);
                        }
                        for code in usize::from(first)..=last {
                            insert_width(&mut widths, code, width)?;
                        }
                    }
                }
            }
        }
        let default_width = cid
            .get("DW")
            .map(Value::number)
            .transpose()?
            .unwrap_or(1000 * SCALE);
        if !(1..=2000 * SCALE).contains(&default_width) {
            return Err(Error::Font);
        }

        Ok(Self {
            id,
            map,
            widths,
            default_width,
            ascent,
            descent,
        })
    }
    pub fn vertical_bounds(&self, size: i64) -> Result<(i64, i64)> {
        let scaled = |n: i64| {
            i64::try_from(i128::from(n) * i128::from(size) / (1000 * i128::from(SCALE)))
                .map_err(|_| Error::Budget)
        };
        Ok((scaled(self.descent)?, scaled(self.ascent)?))
    }
    pub fn decode(&self, bytes: &[u8], size: i64) -> Result<(String, i64)> {
        if bytes.is_empty() {
            return Ok((String::new(), 0));
        }
        if !bytes.len().is_multiple_of(2) || bytes.len() > 2048 {
            return Err(Error::Font);
        }
        let mut text = String::new();
        let mut width = 0i64;
        for pair in bytes.chunks_exact(2) {
            let cid = u16::from_be_bytes([pair[0], pair[1]]);
            text.push(*self.map.get(&cid).ok_or(Error::Font)?);
            width = width
                .checked_add(*self.widths.get(&cid).unwrap_or(&self.default_width))
                .ok_or(Error::Budget)?;
        }
        let width = i128::from(width) * i128::from(size) / (1000 * i128::from(SCALE));
        Ok((text, i64::try_from(width).map_err(|_| Error::Budget)?))
    }
}
fn insert_width(map: &mut BTreeMap<u16, i64>, code: usize, w: i64) -> Result<()> {
    if !(0..=2000 * SCALE).contains(&w)
        || map.len() > 2048
        || map
            .insert(u16::try_from(code).map_err(|_| Error::Font)?, w)
            .is_some()
    {
        return Err(Error::Font);
    }
    Ok(())
}

// Validate the container and bound identity CIDs. This does not recognize glyph
// outlines or claim that an arbitrary font's visual numeral equals its ToUnicode.
fn sfnt_glyph_count(bytes: &[u8]) -> Result<u16> {
    if bytes.get(..4) != Some(&[0, 1, 0, 0]) {
        return Err(Error::Font);
    }
    let u16at = |at: usize| -> Result<u16> {
        let b = bytes.get(at..at + 2).ok_or(Error::Font)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    };
    let u32at = |at: usize| -> Result<usize> {
        let b = bytes.get(at..at + 4).ok_or(Error::Font)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let count = usize::from(u16at(4)?);
    if count == 0 || count > 32 {
        return Err(Error::Font);
    }
    let mut tables = BTreeMap::new();
    let mut spans = Vec::new();
    for i in 0..count {
        let at = 12 + i * 16;
        let tag = bytes.get(at..at + 4).ok_or(Error::Font)?.to_vec();
        let offset = u32at(at + 8)?;
        let len = u32at(at + 12)?;
        if offset < 12 + count * 16
            || offset.checked_add(len).is_none_or(|end| end > bytes.len())
            || tables.insert(tag, (offset, len)).is_some()
        {
            return Err(Error::Font);
        }
        if len > 0 {
            for (start, end) in &spans {
                if offset < *end && *start < offset + len {
                    return Err(Error::Font);
                }
            }
            spans.push((offset, offset + len));
        }
    }
    for tag in [b"head", b"hhea", b"hmtx", b"loca", b"glyf", b"maxp"] {
        if !tables.contains_key(tag.as_slice()) {
            return Err(Error::Font);
        }
    }
    let (at, len) = tables.get(b"maxp".as_slice()).ok_or(Error::Font)?;
    if *len < 6 {
        return Err(Error::Font);
    }
    let count = u16at(at + 4)?;
    if count == 0 || count > 4096 {
        return Err(Error::Font);
    }
    Ok(count)
}

pub(crate) fn cmap(bytes: &[u8]) -> Result<BTreeMap<u16, char>> {
    if bytes.len() > 16 * 1024 {
        return Err(Error::Budget);
    }
    let mut p = Parser::new(bytes);
    if p.value()?.name()? != "CIDInit" || p.value()?.name()? != "ProcSet" {
        return Err(Error::Font);
    }
    for word in [
        b"findresource".as_slice(),
        b"begin",
        b"12",
        b"dict",
        b"begin",
        b"begincmap",
    ] {
        p.expect(word)?;
    }
    if p.value()?.name()? != "CIDSystemInfo" {
        return Err(Error::Font);
    }
    let system = p.value()?;
    let system = system.dict()?;
    if system.len() != 3
        || field(system, "Registry")?.bytes()? != b"TTX+0"
        || field(system, "Ordering")?.bytes()? != b"T42UV"
        || field(system, "Supplement")?.integer()? != 0
    {
        return Err(Error::Font);
    }
    p.expect(b"def")?;
    if p.value()?.name()? != "CMapName" || p.value()?.name()? != "TTX+0" {
        return Err(Error::Font);
    }
    p.expect(b"def")?;
    if p.value()?.name()? != "CMapType" || p.value()?.integer()? != 2 {
        return Err(Error::Font);
    }
    p.expect(b"def")?;
    if p.uint()? != 1 {
        return Err(Error::Font);
    }
    p.expect(b"begincodespacerange")?;
    if code(p.value()?)? != 0 || code(p.value()?)? != 65535 {
        return Err(Error::Font);
    }
    p.expect(b"endcodespacerange")?;
    let mut map = BTreeMap::new();
    let mut groups = 0;
    while !p.at(b"endcmap") {
        groups += 1;
        let count = p.uint()?;
        if count == 0 || count > 100 || groups > 16 {
            return Err(Error::Font);
        }
        p.expect(b"beginbfrange")?;
        for _ in 0..count {
            let first = code(p.value()?)?;
            let last = code(p.value()?)?;
            let unicode = code(p.value()?)?;
            if first > last || last - first > 1024 {
                return Err(Error::Font);
            }
            for cid in first..=last {
                let scalar = u32::from(unicode) + u32::from(cid - first);
                let ch = char::from_u32(scalar).ok_or(Error::Font)?;
                if ch.is_control()
                    || matches!(scalar,0x200b..=0x200f|0x2028..=0x202e|0x2060..=0x206f)
                    || scalar > 0xffff
                    || map.len() >= 2048
                    || map.insert(cid, ch).is_some()
                {
                    return Err(Error::Font);
                }
            }
        }
        p.expect(b"endbfrange")?;
    }
    for word in [b"endcmap".as_slice(), b"CMapName", b"currentdict"] {
        p.expect(word)?;
    }
    if p.value()?.name()? != "CMap" {
        return Err(Error::Font);
    }
    for word in [b"defineresource".as_slice(), b"pop", b"end", b"end"] {
        p.expect(word)?;
    }
    p.space();
    if p.pos != bytes.len() || map.is_empty() {
        return Err(Error::Font);
    }
    Ok(map)
}
fn code(value: Value) -> Result<u16> {
    let b = value.bytes()?;
    if b.len() != 2 {
        return Err(Error::Font);
    }
    Ok(u16::from_be_bytes([b[0], b[1]]))
}
