//! Bounded classic-xref subset; no scanning for a convenient text substring.
use crate::{Error, Result};
use miniz_oxide::inflate::{
    core::{decompress, inflate_flags, DecompressorOxide},
    TINFLStatus,
};
use std::collections::BTreeMap;

pub(crate) const SCALE: i64 = 100_000;
const MAX_OBJECTS: usize = 256;
const MAX_NODES: usize = 32_768;
const MAX_STREAM: usize = 256 * 1024;
pub(crate) type Id = (u32, u16);

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Value {
    Number(i64),
    Name(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Dict(BTreeMap<String, Value>),
    Reference(Id),
    Bool(bool),
    Null,
}
impl Value {
    pub fn integer(&self) -> Result<usize> {
        match self {
            Self::Number(n) if *n >= 0 && n % SCALE == 0 => {
                usize::try_from(n / SCALE).map_err(|_| Error::Structure)
            }
            _ => Err(Error::Structure),
        }
    }
    pub fn number(&self) -> Result<i64> {
        if let Self::Number(n) = self {
            Ok(*n)
        } else {
            Err(Error::Structure)
        }
    }
    pub fn name(&self) -> Result<&str> {
        if let Self::Name(n) = self {
            Ok(n)
        } else {
            Err(Error::Structure)
        }
    }
    pub fn reference(&self) -> Result<Id> {
        if let Self::Reference(n) = self {
            Ok(*n)
        } else {
            Err(Error::Structure)
        }
    }
    pub fn array(&self) -> Result<&[Value]> {
        if let Self::Array(n) = self {
            Ok(n)
        } else {
            Err(Error::Structure)
        }
    }
    pub fn dict(&self) -> Result<&BTreeMap<String, Value>> {
        if let Self::Dict(n) = self {
            Ok(n)
        } else {
            Err(Error::Structure)
        }
    }
    pub fn bytes(&self) -> Result<&[u8]> {
        if let Self::Bytes(n) = self {
            Ok(n)
        } else {
            Err(Error::Structure)
        }
    }
}
pub(crate) fn field<'a>(d: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a Value> {
    d.get(key).ok_or(Error::Structure)
}
pub(crate) fn named(d: &BTreeMap<String, Value>, key: &str, name: &str) -> bool {
    d.get(key).and_then(|v| v.name().ok()) == Some(name)
}
fn delimiter(b: u8) -> bool {
    b.is_ascii_whitespace() || b"()<>[]{}/%".contains(&b)
}

pub(crate) struct Parser<'a> {
    pub data: &'a [u8],
    pub pos: usize,
    nodes: usize,
}
impl<'a> Parser<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            nodes: 0,
        }
    }
    pub fn space(&mut self) {
        loop {
            while self.data.get(self.pos).is_some_and(u8::is_ascii_whitespace) {
                self.pos += 1;
            }
            if self.data.get(self.pos) != Some(&b'%') {
                break;
            }
            while self
                .data
                .get(self.pos)
                .is_some_and(|b| !matches!(b, b'\r' | b'\n'))
            {
                self.pos += 1;
            }
        }
    }
    pub fn at(&mut self, word: &[u8]) -> bool {
        self.space();
        self.data[self.pos..].starts_with(word)
    }
    pub fn word(&mut self) -> Result<&'a [u8]> {
        self.space();
        let start = self.pos;
        while self.data.get(self.pos).is_some_and(|b| !delimiter(*b)) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(Error::Structure);
        }
        Ok(&self.data[start..self.pos])
    }
    pub fn expect(&mut self, word: &[u8]) -> Result<()> {
        if self.word()? == word {
            Ok(())
        } else {
            Err(Error::Structure)
        }
    }
    pub fn uint(&mut self) -> Result<usize> {
        let s = self.word()?;
        if s.len() > 10 || s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
            return Err(Error::Structure);
        }
        s.iter().try_fold(0usize, |n, b| {
            n.checked_mul(10)
                .and_then(|n| n.checked_add(usize::from(b - b'0')))
                .ok_or(Error::Structure)
        })
    }
    pub fn value_start(&mut self) -> bool {
        self.space();
        self.data
            .get(self.pos)
            .is_some_and(|b| b"/<([+-.0123456789".contains(b))
    }
    pub fn value(&mut self) -> Result<Value> {
        self.read_value(0)
    }
    fn read_value(&mut self, depth: usize) -> Result<Value> {
        self.nodes += 1;
        if depth > 16 || self.nodes > MAX_NODES {
            return Err(Error::Budget);
        }
        self.space();
        let byte = *self.data.get(self.pos).ok_or(Error::Structure)?;
        if byte == b'/' {
            self.pos += 1;
            let mut name = Vec::new();
            while let Some(&b) = self.data.get(self.pos) {
                if delimiter(b) {
                    break;
                }
                self.pos += 1;
                if b == b'#' {
                    let part = self
                        .data
                        .get(self.pos..self.pos + 2)
                        .ok_or(Error::Structure)?;
                    let raw = hex::decode(part).map_err(|_| Error::Structure)?;
                    name.push(raw[0]);
                    self.pos += 2;
                } else {
                    name.push(b);
                }
                if name.len() > 128 {
                    return Err(Error::Budget);
                }
            }
            return Ok(Value::Name(
                String::from_utf8(name).map_err(|_| Error::Structure)?,
            ));
        }
        if byte == b'(' {
            self.pos += 1;
            let mut out = Vec::new();
            let mut nesting = 1;
            while nesting > 0 {
                let b = *self.data.get(self.pos).ok_or(Error::Structure)?;
                self.pos += 1;
                match b {
                    b'\\' => {
                        let b = *self.data.get(self.pos).ok_or(Error::Structure)?;
                        self.pos += 1;
                        match b {
                            b'0'..=b'7' => {
                                let mut n = u16::from(b - b'0');
                                for _ in 0..2 {
                                    if let Some(b @ b'0'..=b'7') = self.data.get(self.pos) {
                                        n = n * 8 + u16::from(b - b'0');
                                        self.pos += 1;
                                    } else {
                                        break;
                                    }
                                }
                                out.push((n & 255) as u8);
                            }
                            b'\r' => {
                                if self.data.get(self.pos) == Some(&b'\n') {
                                    self.pos += 1;
                                }
                            }
                            b'\n' => {}
                            _ => out.push(match b {
                                b'n' => b'\n',
                                b'r' => b'\r',
                                b't' => b'\t',
                                b'b' => 8,
                                b'f' => 12,
                                _ => b,
                            }),
                        }
                    }
                    b'(' => {
                        nesting += 1;
                        if nesting > 16 {
                            return Err(Error::Budget);
                        }
                        out.push(b);
                    }
                    b')' => {
                        nesting -= 1;
                        if nesting > 0 {
                            out.push(b);
                        }
                    }
                    _ => out.push(b),
                }
                if out.len() > 64 * 1024 {
                    return Err(Error::Budget);
                }
            }
            return Ok(Value::Bytes(out));
        }
        if self.data[self.pos..].starts_with(b"<<") {
            self.pos += 2;
            let mut out = BTreeMap::new();
            while !self.at(b">>") {
                let key = self.read_value(depth + 1)?.name()?.to_owned();
                let value = self.read_value(depth + 1)?;
                if out.len() >= 64 || out.insert(key, value).is_some() {
                    return Err(Error::Structure);
                }
            }
            self.pos += 2;
            return Ok(Value::Dict(out));
        }
        if byte == b'<' {
            self.pos += 1;
            let start = self.pos;
            while self.data.get(self.pos).is_some_and(|b| *b != b'>') {
                self.pos += 1;
            }
            if self.data.get(self.pos) != Some(&b'>') {
                return Err(Error::Structure);
            }
            let raw = self.data[start..self.pos]
                .iter()
                .copied()
                .filter(|b| !b.is_ascii_whitespace())
                .collect::<Vec<_>>();
            self.pos += 1;
            if raw.len() > 128 * 1024 || raw.len() % 2 != 0 {
                return Err(Error::Budget);
            }
            return Ok(Value::Bytes(
                hex::decode(raw).map_err(|_| Error::Structure)?,
            ));
        }
        if byte == b'[' {
            self.pos += 1;
            let mut out = Vec::new();
            while !self.at(b"]") {
                if out.len() >= 1024 {
                    return Err(Error::Budget);
                }
                out.push(self.read_value(depth + 1)?);
            }
            self.pos += 1;
            return Ok(Value::Array(out));
        }
        let word = self.word()?;
        if word == b"true" {
            return Ok(Value::Bool(true));
        }
        if word == b"false" {
            return Ok(Value::Bool(false));
        }
        if word == b"null" {
            return Ok(Value::Null);
        }
        let number = fixed(word)?;
        if word.iter().all(u8::is_ascii_digit) {
            let saved = self.pos;
            if let Ok(generation) = self.uint() {
                if self.word().is_ok_and(|word| word == b"R") {
                    return Ok(Value::Reference((
                        u32::try_from(number / SCALE).map_err(|_| Error::Structure)?,
                        u16::try_from(generation).map_err(|_| Error::Structure)?,
                    )));
                }
            }
            self.pos = saved;
        }
        Ok(Value::Number(number))
    }
}
fn fixed(raw: &[u8]) -> Result<i64> {
    if raw.is_empty() || raw.len() > 16 {
        return Err(Error::Structure);
    }
    let negative = raw[0] == b'-';
    let raw = if matches!(raw[0], b'-' | b'+') {
        &raw[1..]
    } else {
        raw
    };
    let mut parts = raw.split(|b| *b == b'.');
    let whole = parts.next().ok_or(Error::Structure)?;
    let fraction = parts.next().unwrap_or(&[]);
    if parts.next().is_some()
        || fraction.len() > 5
        || whole.len() + fraction.len() == 0
        || !whole.iter().chain(fraction).all(u8::is_ascii_digit)
    {
        return Err(Error::Structure);
    }
    let parse = |s: &[u8]| {
        s.iter().try_fold(0i64, |n, b| {
            n.checked_mul(10)
                .and_then(|n| n.checked_add(i64::from(b - b'0')))
                .ok_or(Error::Structure)
        })
    };
    let n = parse(whole)?
        .checked_mul(SCALE)
        .and_then(|n| {
            parse(fraction)
                .ok()
                .and_then(|f| n.checked_add(f * 10i64.pow((5 - fraction.len()) as u32)))
        })
        .ok_or(Error::Structure)?;
    Ok(if negative { -n } else { n })
}

pub(crate) struct Object<'a> {
    pub value: Value,
    pub stream: Option<&'a [u8]>,
    pub offset: usize,
}
pub(crate) struct Document<'a> {
    pub objects: BTreeMap<Id, Object<'a>>,
    pub trailer: BTreeMap<String, Value>,
    pub decoded: usize,
}
impl<'a> Document<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() > 512 * 1024 || !bytes.starts_with(b"%PDF-1.") {
            return Err(Error::Budget);
        }
        let mut p = Parser::new(bytes);
        let mut objects: BTreeMap<Id, Object<'a>> = BTreeMap::new();
        let mut current: BTreeMap<Id, Object<'a>> = BTreeMap::new();
        let mut previous_xref = None;
        let mut latest: Option<BTreeMap<String, Value>> = None;
        let mut revisions = 0;
        loop {
            p.space();
            if p.pos == bytes.len() {
                break;
            }
            if p.at(b"xref") {
                let offset = p.pos;
                p.expect(b"xref")?;
                let mut entries = BTreeMap::new();
                while !p.at(b"trailer") {
                    let first = p.uint()?;
                    let count = p.uint()?;
                    if first.checked_add(count).is_none_or(|n| n > MAX_OBJECTS) || count == 0 {
                        return Err(Error::Xref);
                    }
                    for id in first..first + count {
                        let at = p.uint()?;
                        let generation = p.uint()?;
                        let kind = p.word()?;
                        if kind == b"f" {
                            if id != 0 || generation != 65535 {
                                return Err(Error::Xref);
                            }
                            continue;
                        }
                        if kind != b"n"
                            || generation != 0
                            || entries.insert((id as u32, 0), at).is_some()
                        {
                            return Err(Error::Xref);
                        }
                    }
                }
                p.expect(b"trailer")?;
                let trailer = p.value()?.dict()?.clone();
                if trailer.contains_key("Encrypt")
                    || trailer.contains_key("XRefStm")
                    || trailer.get("Prev").map(Value::integer).transpose()? != previous_xref
                {
                    return Err(Error::Xref);
                }
                if let Some(prior) = &latest {
                    if field(prior, "Root")? != field(&trailer, "Root")?
                        || prior.get("Info") != trailer.get("Info")
                    {
                        return Err(Error::UpdatedObject);
                    }
                }
                if current.len() != entries.len() {
                    return Err(Error::Xref);
                }
                for (id, object) in &current {
                    if entries.get(id) != Some(&object.offset) {
                        return Err(Error::Xref);
                    }
                }
                let root_id = field(&trailer, "Root")?.reference()?;
                let metadata_id = objects
                    .get(&root_id)
                    .and_then(|o| o.value.dict().ok())
                    .and_then(|d| d.get("Metadata"))
                    .and_then(|v| v.reference().ok());
                for (id, object) in current {
                    if let Some(old) = objects.get(&id) {
                        check_update(id, old, &object, &trailer, metadata_id)?;
                    }
                    objects.insert(id, object);
                }
                current = BTreeMap::new();
                p.expect(b"startxref")?;
                if p.uint()? != offset {
                    return Err(Error::Xref);
                }
                while p.data.get(p.pos).is_some_and(u8::is_ascii_whitespace) {
                    p.pos += 1;
                }
                if !p.data[p.pos..].starts_with(b"%%EOF") {
                    return Err(Error::Xref);
                }
                p.pos += 5;
                previous_xref = Some(offset);
                latest = Some(trailer);
                revisions += 1;
                if revisions > 2 {
                    return Err(Error::Xref);
                }
            } else {
                p.space();
                let offset = p.pos;
                let id = u32::try_from(p.uint()?).map_err(|_| Error::Structure)?;
                let generation = p.uint()?;
                if id == 0 || id as usize >= MAX_OBJECTS || generation != 0 {
                    return Err(Error::Structure);
                }
                p.expect(b"obj")?;
                let value = p.value()?;
                let stream = if p.at(b"stream") {
                    p.expect(b"stream")?;
                    if p.data.get(p.pos) == Some(&b'\r') {
                        p.pos += 1;
                    }
                    if p.data.get(p.pos) != Some(&b'\n') {
                        return Err(Error::Structure);
                    }
                    p.pos += 1;
                    let length = field(value.dict()?, "Length")?.integer()?;
                    let data = p
                        .data
                        .get(p.pos..p.pos.checked_add(length).ok_or(Error::Budget)?)
                        .ok_or(Error::Structure)?;
                    p.pos += length;
                    p.expect(b"endstream")?;
                    Some(data)
                } else {
                    None
                };
                p.expect(b"endobj")?;
                if current
                    .insert(
                        (id, 0),
                        Object {
                            value,
                            stream,
                            offset,
                        },
                    )
                    .is_some()
                {
                    return Err(Error::DuplicateObject);
                }
            }
        }
        if !current.is_empty() {
            return Err(Error::Xref);
        }
        let trailer = latest.ok_or(Error::Xref)?;
        if field(&trailer, "Size")?.integer()?
            != objects
                .keys()
                .map(|id| id.0 as usize)
                .max()
                .ok_or(Error::Xref)?
                + 1
        {
            return Err(Error::Xref);
        }
        Ok(Self {
            objects,
            trailer,
            decoded: 0,
        })
    }
    pub fn object(&self, id: Id) -> Result<&Object<'a>> {
        self.objects.get(&id).ok_or(Error::Structure)
    }
    pub fn dictionary(&self, id: Id) -> Result<&BTreeMap<String, Value>> {
        self.object(id)?.value.dict()
    }
    pub fn decode(&mut self, id: Id) -> Result<Vec<u8>> {
        let o = self.object(id)?;
        let d = o.value.dict()?;
        let raw = o.stream.ok_or(Error::Structure)?;
        if ["DecodeParms", "F", "FFilter", "FDecodeParms"]
            .iter()
            .any(|k| d.contains_key(*k))
        {
            return Err(Error::Stream);
        }
        let out = if d.get("Filter").is_none() {
            if raw.len() > MAX_STREAM {
                return Err(Error::Budget);
            }
            raw.to_vec()
        } else {
            if !named(d, "Filter", "FlateDecode") {
                return Err(Error::Stream);
            }
            let mut out = vec![0; MAX_STREAM];
            let mut state = Box::<DecompressorOxide>::default();
            let (status, used, written) = decompress(
                &mut state,
                raw,
                &mut out,
                0,
                inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER
                    | inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
            );
            if status != TINFLStatus::Done || used != raw.len() {
                return Err(Error::Stream);
            }
            out.truncate(written);
            out
        };
        self.decoded = self.decoded.checked_add(out.len()).ok_or(Error::Budget)?;
        if self.decoded > 1024 * 1024 {
            return Err(Error::Budget);
        }
        Ok(out)
    }
}
fn check_update(
    id: Id,
    old: &Object<'_>,
    new: &Object<'_>,
    trailer: &BTreeMap<String, Value>,
    metadata_id: Option<Id>,
) -> Result<()> {
    let mut a = old.value.dict()?.clone();
    let mut b = new.value.dict()?.clone();
    if named(&a, "Type", "Page")
        && named(&b, "Type", "Page")
        && old.stream.is_none()
        && new.stream.is_none()
    {
        a.remove("Annots");
        b.remove("Annots");
    } else if named(&a, "Type", "Catalog") && named(&b, "Type", "Catalog") {
        for key in ["AcroForm", "Version"] {
            a.remove(key);
            b.remove(key);
        }
    } else if (Some(id) == metadata_id
        && named(&a, "Type", "Metadata")
        && named(&b, "Type", "Metadata"))
        || (trailer.get("Info").and_then(|v| v.reference().ok()) == Some(id)
            && a.keys().all(|k| {
                ["Author", "CreationDate", "Creator", "ModDate", "Producer"].contains(&k.as_str())
            })
            && b.keys().all(|k| {
                ["Author", "CreationDate", "Creator", "ModDate", "Producer"].contains(&k.as_str())
            }))
    {
        return Ok(());
    } else {
        return Err(Error::UpdatedObject);
    }
    if a != b {
        return Err(Error::UpdatedObject);
    }
    Ok(())
}
