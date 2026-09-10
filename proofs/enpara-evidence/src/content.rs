use crate::{
    fonts::Font,
    pdf::{field, named, Document, Id, Parser, Value, SCALE},
    Error, Result, TextLocation,
};
use std::collections::BTreeMap;

pub(crate) struct TextRun {
    pub text: String,
    pub location: TextLocation,
    pub size: i64,
    pub width: i64,
    pub bottom: i64,
    pub top: i64,
    pub black: bool,
    pub sequence: usize,
}
pub(crate) struct Paint {
    pub bounds: [i64; 4],
    pub sequence: usize,
    pub light_background: bool,
}
pub(crate) struct PageText {
    pub runs: Vec<TextRun>,
    pub paints: Vec<Paint>,
}
#[derive(Clone)]
struct Graphics {
    a: i64,
    d: i64,
    x: i64,
    y: i64,
    black: bool,
    light: bool,
    font: Option<String>,
    size: i64,
    line_width: i64,
}
impl Default for Graphics {
    fn default() -> Self {
        Self {
            a: SCALE,
            d: SCALE,
            x: 0,
            y: 0,
            black: true,
            light: false,
            font: None,
            size: 0,
            line_width: SCALE,
        }
    }
}
fn mul(a: i64, b: i64) -> Result<i64> {
    i64::try_from(i128::from(a) * i128::from(b) / i128::from(SCALE)).map_err(|_| Error::Budget)
}
impl Graphics {
    fn point(&self, x: i64, y: i64) -> Result<(i64, i64)> {
        Ok((
            mul(self.a, x)?.checked_add(self.x).ok_or(Error::Budget)?,
            mul(self.d, y)?.checked_add(self.y).ok_or(Error::Budget)?,
        ))
    }
}
fn numbers(args: &[Value], count: usize) -> Result<Vec<i64>> {
    if args.len() != count {
        return Err(Error::Operator);
    }
    args.iter().map(Value::number).collect()
}
fn none(args: &[Value]) -> Result<()> {
    if args.is_empty() {
        Ok(())
    } else {
        Err(Error::Operator)
    }
}
fn add_point(path: &mut Option<[i64; 4]>, point: (i64, i64)) {
    if let Some(b) = path {
        b[0] = b[0].min(point.0);
        b[1] = b[1].min(point.1);
        b[2] = b[2].max(point.0);
        b[3] = b[3].max(point.1);
    } else {
        *path = Some([point.0, point.1, point.0, point.1]);
    }
}

pub(crate) fn read(
    doc: &mut Document<'_>,
    page: u8,
    contents: &[Id],
    font_ids: &BTreeMap<String, Id>,
    images: &BTreeMap<String, Id>,
) -> Result<PageText> {
    let mut fonts = BTreeMap::new();
    for (name, id) in font_ids {
        fonts.insert(name.clone(), Font::read(doc, *id)?);
    }
    let mut g = Graphics::default();
    let mut stack = Vec::new();
    let mut in_text = false;
    let mut fresh = false;
    let mut tx = 0;
    let mut ty = 0;
    let mut line_x = 0;
    let mut line_y = 0;
    let mut path = None;
    let mut output = PageText {
        runs: Vec::new(),
        paints: Vec::new(),
    };
    let mut sequence = 0;
    for content_id in contents {
        if doc
            .dictionary(*content_id)?
            .keys()
            .any(|key| !["Length", "Filter"].contains(&key.as_str()))
        {
            return Err(Error::Stream);
        }
        let bytes = doc.decode(*content_id)?;
        let mut p = Parser::new(&bytes);
        let mut args = Vec::new();
        loop {
            p.space();
            if p.pos == bytes.len() {
                break;
            }
            if p.value_start() {
                if args.len() >= 64 {
                    return Err(Error::Budget);
                }
                args.push(p.value()?);
                continue;
            }
            let offset = p.pos;
            let op = p.word()?;
            sequence += 1;
            if sequence > 10000 {
                return Err(Error::Budget);
            }

            match op {
                b"q" => {
                    none(&args)?;
                    if in_text || stack.len() >= 16 {
                        return Err(Error::Operator);
                    }
                    stack.push(g.clone());
                }
                b"Q" => {
                    none(&args)?;
                    if in_text {
                        return Err(Error::Operator);
                    }
                    g = stack.pop().ok_or(Error::Operator)?;
                }
                b"cm" => {
                    if in_text {
                        return Err(Error::Operator);
                    }
                    let n = numbers(&args, 6)?;
                    if n[1] != 0
                        || n[2] != 0
                        || n[0] <= 0
                        || n[3] <= 0
                        || n.iter()
                            .any(|v| !(-2000 * SCALE..=2000 * SCALE).contains(v))
                    {
                        return Err(Error::Operator);
                    }
                    let (x, y) = g.point(n[4], n[5])?;
                    g.a = mul(g.a, n[0])?;
                    g.d = mul(g.d, n[3])?;
                    g.x = x;
                    g.y = y;
                    if g.a > 2000 * SCALE || g.d > 2000 * SCALE {
                        return Err(Error::Budget);
                    }
                }
                b"BT" => {
                    none(&args)?;
                    if in_text {
                        return Err(Error::Operator);
                    }
                    in_text = true;
                    fresh = false;
                    tx = 0;
                    ty = 0;
                    line_x = 0;
                    line_y = 0;
                }
                b"ET" => {
                    none(&args)?;
                    if !in_text {
                        return Err(Error::Operator);
                    }
                    in_text = false;
                    fresh = false;
                }
                b"Tf" => {
                    if args.len() != 2 || !in_text {
                        return Err(Error::Operator);
                    }
                    let name = args[0].name()?;
                    if !fonts.contains_key(name) {
                        return Err(Error::Font);
                    }
                    g.font = Some(name.to_owned());
                    g.size = args[1].number()?;
                    if !(SCALE..=50 * SCALE).contains(&g.size) {
                        return Err(Error::Operator);
                    }
                }
                b"Tm" => {
                    if !in_text {
                        return Err(Error::Operator);
                    }
                    let n = numbers(&args, 6)?;
                    if n[..4] != [SCALE, 0, 0, SCALE] {
                        return Err(Error::Operator);
                    }
                    tx = n[4];
                    ty = n[5];
                    line_x = tx;
                    line_y = ty;
                    fresh = true;
                }
                b"Td" => {
                    if !in_text {
                        return Err(Error::Operator);
                    }
                    let n = numbers(&args, 2)?;
                    line_x = line_x.checked_add(n[0]).ok_or(Error::Budget)?;
                    line_y = line_y.checked_add(n[1]).ok_or(Error::Budget)?;
                    tx = line_x;
                    ty = line_y;
                    fresh = true;
                }
                b"Tj" => {
                    if !in_text || !fresh || args.len() != 1 {
                        return Err(Error::Operator);
                    }
                    // Financial text must be ordinary unscaled horizontal text. Image
                    // transformations remain supported only around image operations.
                    if g.a != SCALE || g.d != SCALE {
                        return Err(Error::Operator);
                    }
                    let font = fonts
                        .get(g.font.as_deref().ok_or(Error::Font)?)
                        .ok_or(Error::Font)?;
                    let (text, width) = font.decode(args[0].bytes()?, g.size)?;
                    let (x, y) = g.point(tx, ty)?;
                    tx = tx.checked_add(width).ok_or(Error::Budget)?;
                    if x < 0 || y < 0 || x > 600 * SCALE || y > 850 * SCALE || width > 600 * SCALE {
                        return Err(Error::Layout);
                    }
                    if output.runs.len() >= 256 {
                        return Err(Error::Budget);
                    }
                    let (bottom, top) = font.vertical_bounds(g.size)?;
                    if !text.is_empty() {
                        output.runs.push(TextRun {
                            text,
                            width,
                            bottom: y + bottom,
                            top: y + top,
                            size: g.size,
                            black: g.black,
                            sequence,
                            location: TextLocation {
                                page_number: page,
                                content_object: content_id.0,
                                font_object: font.id.0,
                                operator_offset: offset,
                                x_fixed: x,
                                y_fixed: y,
                            },
                        });
                    }
                }
                b"g" => {
                    let n = numbers(&args, 1)?;
                    if !(0..=SCALE).contains(&n[0]) {
                        return Err(Error::Operator);
                    }
                    g.black = n[0] < SCALE * 4 / 5;
                    g.light = n[0] >= SCALE * 4 / 5;
                }
                b"rg" => {
                    let n = numbers(&args, 3)?;
                    if n.iter().any(|n| !(0..=SCALE).contains(n)) {
                        return Err(Error::Operator);
                    }
                    g.black = n.iter().all(|n| *n < SCALE * 4 / 5);
                    g.light = n.iter().all(|n| *n >= SCALE * 4 / 5);
                }
                b"RG" => {
                    let n = numbers(&args, 3)?;
                    if n.iter().any(|n| !(0..=SCALE).contains(n)) {
                        return Err(Error::Operator);
                    }
                }
                b"w" => {
                    let n = numbers(&args, 1)?;
                    if !(0..=10 * SCALE).contains(&n[0]) {
                        return Err(Error::Operator);
                    }
                    g.line_width = n[0];
                }
                b"J" => {
                    let n = numbers(&args, 1)?;
                    if ![0, SCALE, 2 * SCALE].contains(&n[0]) {
                        return Err(Error::Operator);
                    }
                }
                b"d" => {
                    if args.len() != 2 || args[0].array()?.len() > 8 || args[1].number()? < 0 {
                        return Err(Error::Operator);
                    }
                    for n in args[0].array()? {
                        if n.number()? < 0 {
                            return Err(Error::Operator);
                        }
                    }
                }
                b"m" | b"l" => {
                    if in_text {
                        return Err(Error::Operator);
                    }
                    let n = numbers(&args, 2)?;
                    add_point(&mut path, g.point(n[0], n[1])?);
                }
                b"re" => {
                    if in_text {
                        return Err(Error::Operator);
                    }
                    let n = numbers(&args, 4)?;
                    add_point(&mut path, g.point(n[0], n[1])?);
                    add_point(
                        &mut path,
                        g.point(
                            n[0].checked_add(n[2]).ok_or(Error::Budget)?,
                            n[1].checked_add(n[3]).ok_or(Error::Budget)?,
                        )?,
                    );
                }
                b"f" | b"S" => {
                    none(&args)?;
                    if in_text {
                        return Err(Error::Operator);
                    }
                    let mut bounds = path.take().ok_or(Error::Operator)?;
                    if op == b"S" {
                        let margin = mul(g.line_width, g.a.max(g.d))? / 2;
                        bounds[0] = bounds[0].checked_sub(margin).ok_or(Error::Budget)?;
                        bounds[1] = bounds[1].checked_sub(margin).ok_or(Error::Budget)?;
                        bounds[2] = bounds[2].checked_add(margin).ok_or(Error::Budget)?;
                        bounds[3] = bounds[3].checked_add(margin).ok_or(Error::Budget)?;
                    }
                    output.paints.push(Paint {
                        bounds,
                        sequence,
                        light_background: op == b"f" && g.light,
                    });
                }
                b"Do" => {
                    if in_text || args.len() != 1 {
                        return Err(Error::Operator);
                    }
                    let id = images.get(args[0].name()?).ok_or(Error::Operator)?;
                    let d = doc.dictionary(*id)?;
                    if !named(d, "Type", "XObject")
                        || !named(d, "Subtype", "Image")
                        || doc.object(*id)?.stream.is_none()
                    {
                        return Err(Error::Operator);
                    }
                    let width = field(d, "Width")?.integer()?;
                    let height = field(d, "Height")?.integer()?;
                    if width == 0 || height == 0 || width > 4096 || height > 4096 {
                        return Err(Error::Budget);
                    }
                    let a = g.point(0, 0)?;
                    let b = g.point(SCALE, SCALE)?;
                    output.paints.push(Paint {
                        bounds: [a.0, a.1, b.0, b.1],
                        sequence,
                        light_background: false,
                    });
                }
                _ => return Err(Error::Operator),
            }
            args.clear();
        }
        if !args.is_empty() {
            return Err(Error::Operator);
        }
    }
    if in_text || !stack.is_empty() || path.is_some() {
        return Err(Error::Operator);
    }
    Ok(output)
}

pub(crate) fn overlaps(a: [i64; 4], b: [i64; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}
