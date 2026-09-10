use crate::{fonts, layout, pdf::Document};
use crate::{layout::parse_grams, Error};
use miniz_oxide::deflate::compress_to_vec_zlib;
use std::collections::BTreeMap;

#[test]
fn exact_decimal_grams_have_no_rounding_path() {
    assert_eq!(parse_grams("1,00"), Ok(1000));
    assert_eq!(parse_grams("1.234,56"), Ok(1_234_560));
    assert_eq!(parse_grams("0,01"), Ok(10));
    for value in [
        "1,001", "1,0", "1.00", "-1,00", "1,000", "1.23,45", "01,00", "1,00 XAU", "1e3", "1,00,00",
    ] {
        assert_eq!(parse_grams(value), Err(Error::Quantity));
    }
}

// These are fabricated logical-text PDFs, never bank evidence or proof fixtures.
// The minimal sfnt container is only for testing this parser's accepted structure.
struct Fixture {
    objects: BTreeMap<u32, Vec<u8>>,
}
impl Fixture {
    fn new() -> Self {
        let mut f = Self {
            objects: BTreeMap::new(),
        };
        f.put(1, "<< /Type /Catalog /Pages 2 0 R >>");
        f.put(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
        for (id, content) in [(3, 10), (4, 11)] {
            f.put(id,&format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents [{content} 0 R] >>"));
        }
        f.put(5,"<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>");
        f.put(6,"<< /Type /Font /Subtype /CIDFontType2 /CIDToGIDMap /Identity /FontDescriptor 7 0 R /DW 500 >>");
        f.put(
            7,
            "<< /Type /FontDescriptor /FontFile2 8 0 R /Ascent 800 /Descent -200 >>",
        );
        f.stream(8, &fake_sfnt(), false);
        f.stream(9, cmap().as_bytes(), false);
        let page1 = format!(
            "{}{}",
            text("XAU (gr alt\u{131}n) /TL", "325", "629.1"),
            text(
                "10.09.2026 Tarihli Varl\u{131}k D\u{f6}k\u{fc}m\u{fc}n\u{fc}z",
                "223.17",
                "714.37"
            )
        );
        f.stream(10, page1.as_bytes(), true);
        f.page2(&page2());
        f
    }
    fn put(&mut self, id: u32, text: &str) {
        self.objects.insert(id, text.as_bytes().to_vec());
    }
    fn stream(&mut self, id: u32, data: &[u8], compressed: bool) {
        let data = if compressed {
            compress_to_vec_zlib(data, 6)
        } else {
            data.to_vec()
        };
        let filter = if compressed {
            " /Filter /FlateDecode"
        } else {
            ""
        };
        let mut object = format!("<< /Length {}{filter} >>\nstream\n", data.len()).into_bytes();
        object.extend_from_slice(&data);
        object.extend_from_slice(b"\nendstream");
        self.objects.insert(id, object);
    }
    fn page2(&mut self, text: &str) {
        self.stream(11, text.as_bytes(), true);
    }
    fn bytes(&self) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n% Synthetic parser fixture\n".to_vec();
        let mut entries = BTreeMap::new();
        for (id, value) in &self.objects {
            entries.insert(*id, out.len());
            out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
            out.extend_from_slice(value);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        let size = self.objects.keys().max().copied().unwrap_or(0) + 1;
        out.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \n");
        for (id, offset) in entries {
            out.extend_from_slice(format!("{id} 1\n{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n")
                .as_bytes(),
        );
        out
    }
}
fn text(s: &str, x: &str, y: &str) -> String {
    let data = s
        .encode_utf16()
        .flat_map(u16::to_be_bytes)
        .collect::<Vec<_>>();
    format!(
        "BT /F1 8 Tf 1 0 0 1 {x} {y} Tm <{}> Tj ET\n",
        hex::encode(data)
    )
}
fn page2() -> String {
    let mut s = String::new();
    for (label, x, y) in [
        ("Vadesiz ve Vadeli Hesaplar", "20", "654.1"),
        ("Hesap No", "217.06", "623.1"),
        ("D\u{f6}viz", "262.34", "627.7"),
        ("Bakiye", "305.11", "623.1"),
        ("Kullan\u{131}labilir", "354.03", "627.7"),
        ("Bakiye", "365.11", "618.5"),
        ("XAU", "266.81", "558.46"),
        ("9,87", "311.19", "558.46"),
        ("1,23", "371.19", "558.46"),
    ] {
        s.push_str(&text(label, x, y));
    }
    s
}
fn cmap() -> String {
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (TTX+0) /Ordering (T42UV) /Supplement 0 >> def\n/CMapName /TTX+0 def\n/CMapType 2 def\n1 begincodespacerange\n<0000><FFFF>\nendcodespacerange\n4 beginbfrange\n<0020><007e><0020>\n<00f6><00f6><00f6>\n<00fc><00fc><00fc>\n<0131><0131><0131>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end\n".to_owned()
}
fn fake_sfnt() -> Vec<u8> {
    let mut data = vec![0; 12 + 6 * 16];
    data[..4].copy_from_slice(&[0, 1, 0, 0]);
    data[4..6].copy_from_slice(&6u16.to_be_bytes());
    for (i, tag) in [b"head", b"hhea", b"hmtx", b"loca", b"glyf", b"maxp"]
        .iter()
        .enumerate()
    {
        let at = 12 + i * 16;
        let offset = data.len() as u32;
        data[at..at + 4].copy_from_slice(*tag);
        data[at + 8..at + 12].copy_from_slice(&offset.to_be_bytes());
        data[at + 12..at + 16].copy_from_slice(&6u32.to_be_bytes());
        data.extend_from_slice(&[0, 1, 0, 0, 4, 0]);
    }
    data
}
fn rejects(f: Fixture) {
    assert!(layout::extract(&f.bytes()).is_err());
}

#[test]
fn full_available_column_is_selected_and_ordinary_balance_is_not() {
    let f = Fixture::new();
    let got =
        layout::extract(&f.bytes()).unwrap_or_else(|e| panic!("synthetic fixture rejected: {e}"));
    assert_eq!(got.amount_mg, 1230);
    assert_eq!(got.date.year(), 2026);
    assert_eq!(got.amount_location.page_number(), 2);
    assert_eq!(got.amount_location.content_object(), 11);
    assert_eq!(got.amount_location.font_object(), 5);
    assert!(got.amount_location.operator_offset() > got.row_location.operator_offset());
}

#[test]
fn quantity_precision_zero_and_available_above_balance_are_rejected() {
    for value in ["1,234", "0,00", "9,88", "-1,23"] {
        let mut f = Fixture::new();
        f.page2(&page2().replace(
            &text("1,23", "371.19", "558.46"),
            &text(value, "371.19", "558.46"),
        ));
        rejects(f);
    }
}
#[test]
fn wrong_or_missing_available_column_is_rejected() {
    let mut f = Fixture::new();
    f.page2(&page2().replace(
        &text("Kullan\u{131}labilir", "354.03", "627.7"),
        &text("Kullan\u{131}labilir", "420", "627.7"),
    ));
    rejects(f);
    let mut f = Fixture::new();
    f.page2(&page2().replace(&text("1,23", "371.19", "558.46"), ""));
    rejects(f);
}
#[test]
fn ticker_without_authenticated_gram_label_is_rejected() {
    let mut f = Fixture::new();
    f.stream(10, text("XAU /TL", "325", "629.1").as_bytes(), true);
    rejects(f);
}
#[test]
fn a_second_xau_account_or_same_cell_text_is_ambiguous() {
    let mut f = Fixture::new();
    f.page2(&(page2() + &text("XAU", "266.81", "528.46")));
    rejects(f);
    let mut f = Fixture::new();
    f.page2(&(page2() + &text("7,77", "371.19", "558.46")));
    rejects(f);
}
#[test]
fn fragmented_currency_rows_are_rejected() {
    for pieces in [
        vec![("X", "266.81"), ("AU", "270.81")],
        vec![("XA", "266.81"), ("U", "274.81")],
        vec![("X", "266.81"), ("A", "270.81"), ("U", "274.81")],
    ] {
        let mut f = Fixture::new();
        let mut content = page2();
        for (label, x) in pieces {
            content.push_str(&text(label, x, "528.46"));
        }
        f.page2(&content);
        rejects(f);
    }
    // An ordinary, complete non-XAU currency cell remains supported.
    for currency in ["USD", "TL"] {
        let mut f = Fixture::new();
        f.page2(&(page2() + &text(currency, "266.81", "528.46")));
        assert!(layout::extract(&f.bytes()).is_ok());
    }
}

#[test]
fn separate_complete_currency_tokens_in_one_cell_are_ambiguous() {
    let mut f = Fixture::new();
    let content = page2().replace(
        &text("XAU", "266.81", "558.46"),
        &text("XAU", "260", "558.46"),
    ) + &text("USD", "276", "558.46");
    f.page2(&content);
    rejects(f);
}

#[test]
fn standalone_spanning_note_is_not_a_currency_cell() {
    let note = "Synthetic informational notice spans the account table and does not represent a currency cell.";
    let mut f = Fixture::new();
    f.page2(&(page2() + &text(note, "20", "480")));
    let got = layout::extract(&f.bytes()).unwrap_or_else(|e| panic!("spanning note rejected: {e}"));
    assert_eq!(got.amount_mg, 1230);
}

#[test]
fn spanning_notes_cannot_hide_currency_or_account_cells() {
    let note = "Synthetic informational notice spans the account table and does not represent a currency cell.";
    for extra in [
        text(note, "20", "558.46"),
        text(&note.replace("informational", "XAU"), "20", "480"),
        text(note, "20", "480") + &text("X", "266.81", "480"),
        text(note, "20", "480") + &text("1,00", "311.19", "480"),
    ] {
        let mut f = Fixture::new();
        f.page2(&(page2() + &extra));
        rejects(f);
    }
}

#[test]
fn stroke_bounds_outside_integer_range_return_a_budget_error() {
    for point in ["92233720368547", "-92233720368547"] {
        for path in [format!("{point} 0 m"), format!("0 {point} m")] {
            let mut f = Fixture::new();
            f.page2(&(page2() + &format!("2 w {path} S\n")));
            assert!(matches!(layout::extract(&f.bytes()), Err(Error::Budget)));
        }
    }
}
#[test]
fn invisible_text_and_opaque_cover_are_rejected() {
    let mut f = Fixture::new();
    f.page2(&("0 g 365 554 35 12 re f\n".to_owned() + &page2()));
    rejects(f);
    let mut f = Fixture::new();
    f.page2(
        &(page2().replace(
            &text("1,23", "371.19", "558.46"),
            &format!("1 g\n{}", text("1,23", "371.19", "558.46")),
        )),
    );
    rejects(f);
    let mut f = Fixture::new();
    f.page2(&(page2() + "1 g 365 554 35 12 re f\n"));
    rejects(f);
    let mut f = Fixture::new();
    f.page2(&("3 Tr\n".to_owned() + &page2()));
    rejects(f);
}
#[test]
fn unsupported_transparency_clipping_rotation_and_text_arrays_are_rejected() {
    for op in [
        "/Unknown gs\n",
        "0 0 10 10 re W n\n",
        "0 1 -1 0 0 0 cm\n",
        "BT /F1 8 Tf 1 0 0 1 1 1 Tm [<0031>] TJ ET\n",
    ] {
        let mut f = Fixture::new();
        f.page2(&(op.to_owned() + &page2()));
        rejects(f);
    }
}
#[test]
fn page_cycles_duplicate_pages_and_content_reuse_are_rejected() {
    for kids in ["2 0 R 4 0 R", "3 0 R 3 0 R", "4 0 R 3 0 R"] {
        let mut f = Fixture::new();
        f.put(2, &format!("<< /Type /Pages /Kids [{kids}] /Count 2 >>"));
        rejects(f);
    }
    let mut f = Fixture::new();
    f.put(4,"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents [10 0 R] >>");
    rejects(f);
}
#[test]
fn duplicate_dictionary_key_and_physical_object_are_rejected() {
    let mut f = Fixture::new();
    f.put(1, "<< /Type /Catalog /Pages 2 0 R /Pages 2 0 R >>");
    rejects(f);
    let f = Fixture::new();
    let bytes = f.bytes();
    let at = bytes.windows(5).position(|w| w == b"xref\n").unwrap_or(0);
    let mut duplicated = bytes[..at].to_vec();
    duplicated.extend_from_slice(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
    duplicated.extend_from_slice(&bytes[at..]);
    assert!(matches!(
        Document::parse(&duplicated),
        Err(Error::DuplicateObject)
    ));
}
fn append_update(
    mut bytes: Vec<u8>,
    id: u32,
    value: &[u8],
    prev_override: Option<usize>,
) -> Vec<u8> {
    let prior = bytes.windows(5).position(|w| w == b"xref\n").unwrap_or(0);
    let at = bytes.len();
    bytes.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
    bytes.extend_from_slice(value);
    bytes.extend_from_slice(b"\nendobj\n");
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n{id} 1\n{at:010} 00000 n \ntrailer\n<< /Root 1 0 R /Size 12 /Prev {} >>\nstartxref\n{xref}\n%%EOF\n",prev_override.unwrap_or(prior)).as_bytes());
    bytes
}
#[test]
fn updated_financial_stream_and_prev_cycle_are_rejected() {
    let f = Fixture::new();
    let bytes = append_update(f.bytes(), 11, b"<< /Length 0 >>\nstream\n\nendstream", None);
    assert!(matches!(Document::parse(&bytes), Err(Error::UpdatedObject)));
    let bytes = append_update(f.bytes(), 1, b"<< /Type /Catalog /Pages 2 0 R >>", Some(0));
    assert!(matches!(Document::parse(&bytes), Err(Error::Xref)));
}
#[test]
fn xref_offsets_and_external_streams_are_rejected() {
    let f = Fixture::new();
    let mut bytes = f.bytes();
    let at = bytes.windows(5).position(|w| w == b"xref\n").unwrap_or(0);
    let pos = bytes[at..]
        .windows(8)
        .position(|w| w == b"00000 n ")
        .unwrap_or(0)
        + at;
    bytes[pos - 2] = b'9';
    assert!(Document::parse(&bytes).is_err());
    let mut f = Fixture::new();
    f.put(11, "<< /Length 0 /F (external) >>\nstream\n\nendstream");
    rejects(f);
}
#[test]
fn decompression_budget_and_trailing_compressed_data_are_rejected() {
    let mut f = Fixture::new();
    f.stream(11, &vec![b' '; 256 * 1024 + 1], true);
    let bytes = f.bytes();
    let mut doc = Document::parse(&bytes).unwrap_or_else(|e| panic!("fixture: {e}"));
    assert!(matches!(doc.decode((11, 0)), Err(Error::Stream)));
    let mut compressed = compress_to_vec_zlib(b"q Q", 6);
    compressed.extend_from_slice(b"unconsumed");
    let mut object = format!(
        "<< /Length {} /Filter /FlateDecode >>\nstream\n",
        compressed.len()
    )
    .into_bytes();
    object.extend(compressed);
    object.extend_from_slice(b"\nendstream");
    f.objects.insert(11, object);
    let bytes = f.bytes();
    let mut doc = Document::parse(&bytes).unwrap_or_else(|e| panic!("fixture: {e}"));
    assert!(matches!(doc.decode((11, 0)), Err(Error::Stream)));
}
#[test]
fn duplicate_and_bidirectional_cmap_mappings_are_rejected() {
    let duplicate = cmap()
        .replace("4 beginbfrange", "5 beginbfrange")
        .replace("endbfrange", "<0031><0031><0039>\nendbfrange");
    assert!(fonts::cmap(duplicate.as_bytes()).is_err());
    let bidi = cmap().replace("<0131><0131><0131>", "<0131><0131><202e>");
    assert!(fonts::cmap(bidi.as_bytes()).is_err());
    let mut f = Fixture::new();
    f.stream(
        9,
        cmap()
            .replace("<0131><0131><0131>", "<0131><0131><0132>")
            .as_bytes(),
        false,
    );
    rejects(f);
}

#[test]
fn permitted_metadata_updates_cannot_alias_a_financial_cmap() {
    let mut f = Fixture::new();
    f.put(1, "<< /Type /Catalog /Pages 2 0 R /Metadata 9 0 R >>");
    let data = cmap();
    let object = format!(
        "<< /Type /Metadata /Subtype /XML /Length {} >>\nstream\n{data}\nendstream",
        data.len()
    )
    .into_bytes();
    f.objects.insert(9, object.clone());
    let bytes = append_update(f.bytes(), 9, &object, None);
    assert!(Document::parse(&bytes).is_ok());
    assert!(matches!(layout::extract(&bytes), Err(Error::Font)));
}

#[test]
fn invalid_calendar_date_and_changed_date_label_are_rejected() {
    for date in ["31.02.2026", "29.02.2025", "00.09.2026", "10.13.2026"] {
        let mut f = Fixture::new();
        let content = text("XAU (gr alt\u{131}n) /TL", "325", "629.1")
            + &text(
                &format!("{date} Tarihli Varl\u{131}k D\u{f6}k\u{fc}m\u{fc}n\u{fc}z"),
                "223.17",
                "714.37",
            );
        f.stream(10, content.as_bytes(), true);
        rejects(f);
    }
}
