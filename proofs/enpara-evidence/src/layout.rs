use crate::{
    content::{self, PageText, TextRun},
    pdf::{field, named, Document, Id, Value, SCALE},
    Error, ReportDate, Result, TextLocation,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct Extracted {
    pub amount_mg: u64,
    pub date: ReportDate,
    pub amount_location: TextLocation,
    pub row_location: TextLocation,
    pub unit_location: TextLocation,
    pub column_location: TextLocation,
    pub date_location: TextLocation,
}
fn keys(d: &BTreeMap<String, Value>, allowed: &[&str]) -> Result<()> {
    if d.keys().all(|k| allowed.contains(&k.as_str())) {
        Ok(())
    } else {
        Err(Error::PageGraph)
    }
}
fn ids(value: &Value) -> Result<Vec<Id>> {
    value.array()?.iter().map(Value::reference).collect()
}
fn refs(d: &BTreeMap<String, Value>) -> Result<BTreeMap<String, Id>> {
    d.iter()
        .map(|(n, v)| Ok((n.clone(), v.reference()?)))
        .collect()
}
fn dictionary(doc: &Document<'_>, value: &Value) -> Result<BTreeMap<String, Value>> {
    match value {
        Value::Reference(id) => Ok(doc.dictionary(*id)?.clone()),
        _ => Ok(value.dict()?.clone()),
    }
}

pub(crate) fn extract(bytes: &[u8]) -> Result<Extracted> {
    let mut doc = Document::parse(bytes)?;

    let root = doc
        .dictionary(field(&doc.trailer, "Root")?.reference()?)?
        .clone();
    keys(
        &root,
        &[
            "Type",
            "Pages",
            "Names",
            "ViewerPreferences",
            "Metadata",
            "AcroForm",
            "Version",
        ],
    )?;
    if !named(&root, "Type", "Catalog") {
        return Err(Error::PageGraph);
    }
    if let Some(n) = root.get("Names") {
        let d = dictionary(&doc, n)?;
        keys(&d, &["Dests"])?;
    }
    if let Some(n) = root.get("ViewerPreferences") {
        let d = dictionary(&doc, n)?;
        keys(&d, &["PrintScaling"])?;
        if !named(&d, "PrintScaling", "AppDefault") {
            return Err(Error::PageGraph);
        }
    }

    let pages_id = field(&root, "Pages")?.reference()?;
    let pages = doc.dictionary(pages_id)?.clone();

    keys(&pages, &["Type", "Kids", "Count", "ITXT", "DefaultValue"])?;
    if !named(&pages, "Type", "Pages") || field(&pages, "Count")?.integer()? != 2 {
        return Err(Error::PageGraph);
    }
    let page_ids = ids(field(&pages, "Kids")?)?;
    if page_ids.len() != 2 || page_ids[0] == page_ids[1] || page_ids.contains(&pages_id) {
        return Err(Error::PageGraph);
    }

    let mut texts = Vec::new();
    let mut annotations = BTreeSet::new();
    let mut seen_contents = BTreeSet::new();
    for (index, id) in page_ids.iter().enumerate() {
        let d = doc.dictionary(*id)?.clone();
        keys(
            &d,
            &[
                "Type",
                "Parent",
                "MediaBox",
                "Resources",
                "Contents",
                "Annots",
                "Group",
                "Tabs",
            ],
        )?;
        if !named(&d, "Type", "Page") || field(&d, "Parent")?.reference()? != pages_id {
            return Err(Error::PageGraph);
        }
        let bbox = field(&d, "MediaBox")?.array()?;
        if bbox.iter().map(Value::number).collect::<Result<Vec<_>>>()?
            != [0, 0, 595 * SCALE, 842 * SCALE]
        {
            return Err(Error::PageGraph);
        }
        if let Some(group) = d.get("Group") {
            let g = group.dict()?;
            keys(g, &["Type", "S", "CS"])?;
            if !named(g, "Type", "Group")
                || !named(g, "S", "Transparency")
                || !named(g, "CS", "DeviceRGB")
            {
                return Err(Error::PageGraph);
            }
        }
        if let Some(tabs) = d.get("Tabs") {
            if tabs.name()? != "S" {
                return Err(Error::PageGraph);
            }
        }

        let resources = field(&d, "Resources")?.dict()?;
        keys(resources, &["Font", "XObject", "ProcSet", "ColorSpace"])?;
        if let Some(colors) = resources.get("ColorSpace") {
            let colors = colors.dict()?;
            if colors.len() != 1 || !named(colors, "CS", "DeviceRGB") {
                return Err(Error::PageGraph);
            }
        }
        let fonts = refs(field(resources, "Font")?.dict()?)?;
        if fonts.is_empty() || fonts.len() > 8 {
            return Err(Error::PageGraph);
        }
        let images = resources
            .get("XObject")
            .map(|v| refs(v.dict()?))
            .transpose()?
            .unwrap_or_default();
        if images.len() > 16 {
            return Err(Error::Budget);
        }

        let contents = ids(field(&d, "Contents")?)?;
        if contents.is_empty() || contents.len() > 4 {
            return Err(Error::PageGraph);
        }
        for id in &contents {
            if !seen_contents.insert(*id) {
                return Err(Error::PageGraph);
            }
        }
        if let Some(annots) = d.get("Annots") {
            for annot in ids(annots)? {
                if !annotations.insert(annot) {
                    return Err(Error::PageGraph);
                }
                annotation(&mut doc, annot, *id)?;
            }
        }

        texts.push(content::read(
            &mut doc,
            (index + 1) as u8,
            &contents,
            &fonts,
            &images,
        )?);
    }

    if let Some(form) = root.get("AcroForm") {
        let form = form.dict()?;
        keys(form, &["Fields", "DA", "DR", "SigFlags"])?;
        let fields = ids(field(form, "Fields")?)?;
        if fields.iter().copied().collect::<BTreeSet<_>>() != annotations
            || fields.len() != annotations.len()
        {
            return Err(Error::PageGraph);
        }
        if field(form, "SigFlags")?.integer()? != 3 {
            return Err(Error::PageGraph);
        }
    } else if !annotations.is_empty() {
        return Err(Error::PageGraph);
    }

    select(&texts[0], &texts[1])
}
fn annotation(doc: &mut Document<'_>, id: Id, page: Id) -> Result<()> {
    let a = doc.dictionary(id)?.clone();
    keys(
        &a,
        &[
            "Type", "Subtype", "FT", "T", "V", "F", "Rect", "AP", "P", "DR",
        ],
    )?;
    if !named(&a, "Type", "Annot")
        || !named(&a, "Subtype", "Widget")
        || !named(&a, "FT", "Sig")
        || field(&a, "P")?.reference()? != page
    {
        return Err(Error::PageGraph);
    }
    let rect = field(&a, "Rect")?.array()?;
    if rect.len() != 4 || rect.iter().any(|v| v.number() != Ok(0)) {
        return Err(Error::PageGraph);
    }
    let ap = field(&a, "AP")?.dict()?;
    keys(ap, &["N"])?;
    let appearance = field(ap, "N")?.reference()?;
    let d = doc.dictionary(appearance)?;
    if !named(d, "Type", "XObject")
        || !named(d, "Subtype", "Form")
        || doc
            .decode(appearance)?
            .iter()
            .any(|b| !b.is_ascii_whitespace())
    {
        return Err(Error::PageGraph);
    }
    let sig = doc.dictionary(field(&a, "V")?.reference()?)?;
    if !named(sig, "Type", "Sig") || !named(sig, "SubFilter", "ETSI.CAdES.detached") {
        return Err(Error::PageGraph);
    }
    Ok(())
}
fn within(run: &TextRun, b: [i64; 4]) -> bool {
    let (x, y) = run.location.position_fixed();
    x >= b[0] * SCALE && x <= b[2] * SCALE && y >= b[1] * SCALE && y <= b[3] * SCALE
}
fn one<'a>(page: &'a PageText, text: &str, box_points: [i64; 4]) -> Result<&'a TextRun> {
    let matches = page
        .runs
        .iter()
        .filter(|r| r.text == text)
        .collect::<Vec<_>>();
    if matches.len() != 1 || !within(matches[0], box_points) {
        return Err(Error::Layout);
    }
    safe(page, matches[0])?;
    Ok(matches[0])
}
fn safe(page: &PageText, run: &TextRun) -> Result<()> {
    let (x, _) = run.location.position_fixed();
    let b = [x, run.bottom, x + run.width, run.top];
    if !run.black || !(6 * SCALE..=18 * SCALE).contains(&run.size) || run.width <= 0 {
        return Err(Error::Layout);
    }
    for paint in &page.paints {
        if (paint.sequence > run.sequence || !paint.light_background)
            && content::overlaps(paint.bounds, b)
        {
            return Err(Error::Ambiguous);
        }
    }
    for other in &page.runs {
        if std::ptr::eq(run, other) {
            continue;
        }
        let (ox, _) = other.location.position_fixed();
        let ob = [ox, other.bottom, ox + other.width, other.top];
        if content::overlaps(ob, b) {
            return Err(Error::Ambiguous);
        }
    }
    Ok(())
}
fn location(run: &TextRun) -> TextLocation {
    let r = &run.location;
    TextLocation {
        page_number: r.page_number,
        content_object: r.content_object,
        font_object: r.font_object,
        operator_offset: r.operator_offset,
        x_fixed: r.x_fixed,
        y_fixed: r.y_fixed,
    }
}
fn standalone_spanning_note(page: &PageText, run: &TextRun, right: i64) -> bool {
    let (x, _) = run.location.position_fixed();
    // A standalone full-width note can cross the table's x-coordinates without
    // being a currency cell. It must contain no XAU marker and share no vertical
    // interval with any other account/currency/quantity text. Unsupported mixed
    // layouts still fail closed rather than hiding a row behind prose.
    x < 260 * SCALE
        && right > 292 * SCALE
        && run.text.split_whitespace().count() > 3
        && !run.text.contains("XAU")
        && !page.runs.iter().any(|other| {
            if std::ptr::eq(run, other) {
                return false;
            }
            let (ox, _) = other.location.position_fixed();
            ox < 404 * SCALE
                && ox + other.width > 215 * SCALE
                && run.bottom < other.top
                && other.bottom < run.top
        })
}
fn validate_currency_cells(page: &PageText) -> Result<()> {
    // This profile accepts one complete currency token per cell (including TL).
    // Reject fragmented or crossing text instead of guessing at concatenation.
    // Otherwise a second XAU row encoded as separate X and AU runs is invisible
    // to the exact-token uniqueness check below.
    let mut cells: Vec<&TextRun> = Vec::new();
    for run in &page.runs {
        let (x, y) = run.location.position_fixed();
        let right = x.checked_add(run.width).ok_or(Error::Budget)?;
        if (420 * SCALE..=610 * SCALE).contains(&y) && x < 292 * SCALE && right > 260 * SCALE {
            if standalone_spanning_note(page, run, right) {
                continue;
            }
            if !(260 * SCALE..=280 * SCALE).contains(&x)
                || right > 292 * SCALE
                || (run.text.len() != 3 && run.text != "TL")
                || !run.text.bytes().all(|b| b.is_ascii_uppercase())
            {
                return Err(Error::Ambiguous);
            }
            safe(page, run)?;
            if cells
                .iter()
                .any(|other| run.bottom < other.top && other.bottom < run.top)
            {
                return Err(Error::Ambiguous);
            }
            cells.push(run);
        }
    }
    Ok(())
}
fn select(page1: &PageText, page2: &PageText) -> Result<Extracted> {
    let unit = one(page1, "XAU (gr alt\u{131}n) /TL", [320, 625, 335, 633])?;
    let dates = page1
        .runs
        .iter()
        .filter(|r| {
            r.text
                .ends_with(" Tarihli Varl\u{131}k D\u{f6}k\u{fc}m\u{fc}n\u{fc}z")
        })
        .collect::<Vec<_>>();
    if dates.len() != 1 || !within(dates[0], [180, 710, 260, 719]) {
        return Err(Error::Date);
    }
    safe(page1, dates[0])?;
    let date = parse_date(dates[0].text.split(' ').next().ok_or(Error::Date)?)?;
    one(page2, "Vadesiz ve Vadeli Hesaplar", [18, 650, 25, 659])?;
    one(page2, "Hesap No", [215, 620, 220, 625])?;
    one(page2, "D\u{f6}viz", [260, 625, 270, 630])?;
    let column = one(page2, "Kullan\u{131}labilir", [352, 625, 358, 630])?;
    // The repeated word belongs to two different columns; both exact positions
    // are required, and the selected quantity is always in the latter column.
    let balances = page2
        .runs
        .iter()
        .filter(|r| r.text == "Bakiye")
        .collect::<Vec<_>>();
    if balances.len() != 2
        || balances
            .iter()
            .filter(|r| within(r, [302, 620, 309, 625]))
            .count()
            != 1
        || balances
            .iter()
            .filter(|r| within(r, [362, 616, 369, 621]))
            .count()
            != 1
    {
        return Err(Error::Layout);
    }
    for r in balances {
        safe(page2, r)?;
    }
    validate_currency_cells(page2)?;
    let row = one(page2, "XAU", [260, 420, 280, 610])?;
    let y = row.location.y_fixed;
    let cell = |low: i64, high: i64| -> Result<&TextRun> {
        let matches = page2
            .runs
            .iter()
            .filter(|r| {
                (r.location.y_fixed - y).abs() <= SCALE / 10
                    && r.location.x_fixed >= low * SCALE
                    && r.location.x_fixed < high * SCALE
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 || matches[0].location.x_fixed + matches[0].width > (high + 1) * SCALE
        {
            return Err(Error::Ambiguous);
        }
        safe(page2, matches[0])?;
        Ok(matches[0])
    };
    let ordinary = cell(292, 344)?;
    let amount = cell(350, 404)?;
    let ordinary_mg = parse_grams(&ordinary.text)?;
    let amount_mg = parse_grams(&amount.text)?;
    if amount_mg > ordinary_mg
        || amount_mg == 0
        || ordinary.location.font_object != amount.location.font_object
        || ordinary.size != amount.size
    {
        return Err(Error::Quantity);
    }
    Ok(Extracted {
        amount_mg,
        date,
        amount_location: location(amount),
        row_location: location(row),
        unit_location: location(unit),
        column_location: location(column),
        date_location: location(dates[0]),
    })
}

pub(crate) fn parse_grams(text: &str) -> Result<u64> {
    let (integer, fraction) = text.split_once(',').ok_or(Error::Quantity)?;
    if fraction.len() != 2 || !fraction.bytes().all(|b| b.is_ascii_digit()) || integer.is_empty() {
        return Err(Error::Quantity);
    }
    let groups = integer.split('.').collect::<Vec<_>>();
    if groups.len() > 1
        && (groups[0].is_empty() || groups[0].len() > 3 || groups[1..].iter().any(|g| g.len() != 3))
    {
        return Err(Error::Quantity);
    }
    let digits = groups.concat();
    if digits.len() > 12
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
    {
        return Err(Error::Quantity);
    }
    let whole = digits.parse::<u64>().map_err(|_| Error::Quantity)?;
    let cents = fraction.parse::<u64>().map_err(|_| Error::Quantity)?;
    whole
        .checked_mul(1000)
        .and_then(|mg| mg.checked_add(cents * 10))
        .ok_or(Error::Quantity)
}
fn parse_date(text: &str) -> Result<ReportDate> {
    if text.len() != 10 || text.as_bytes()[2] != b'.' || text.as_bytes()[5] != b'.' {
        return Err(Error::Date);
    }
    let n = |s: &str| -> Result<u16> {
        if !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::Date);
        }
        s.parse().map_err(|_| Error::Date)
    };
    let bytes = text.as_bytes();
    if !bytes.is_ascii() {
        return Err(Error::Date);
    }
    let day = n(&text[..2])?;
    let month = n(&text[3..5])?;
    let year = n(&text[6..])?;
    if !(2000..=2099).contains(&year) || !(1..=12).contains(&month) {
        return Err(Error::Date);
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > max {
        return Err(Error::Date);
    }
    Ok(ReportDate {
        year,
        month: month as u8,
        day: day as u8,
    })
}
