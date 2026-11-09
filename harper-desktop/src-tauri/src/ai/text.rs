//! Range helpers for choosing what the AI rewrites. All offsets are `char` indexes, like Harper spans.

const TERMINATORS: &[char] = &['.', '!', '?'];
const CLOSERS: &[char] = &['"', '\'', ')', ']', '\u{201d}', '\u{2019}', '*', '_'];

/// True when the character at `i` can begin a sentence, so "pp. 34" or "e.g. this" do not split.
fn starts_sentence(chars: &[char], i: usize) -> bool {
    match chars.get(i) {
        None | Some('\n') => true,
        Some(c) => !(c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '('),
    }
}

/// Finds the sentence containing `[start, end)`, bounded by sentence punctuation or line breaks.
pub fn sentence_around(chars: &[char], start: usize, end: usize) -> (usize, usize) {
    let len = chars.len();
    let mut from = start.min(len);
    while from > 0 {
        let prev = chars[from - 1];
        if prev == '\n' {
            break;
        }
        if prev.is_whitespace() && from >= 2 && starts_sentence(chars, from) {
            let mut k = from as isize - 2;
            while k >= 0 && CLOSERS.contains(&chars[k as usize]) {
                k -= 1;
            }
            if k >= 0 && TERMINATORS.contains(&chars[k as usize]) {
                break;
            }
        }
        from -= 1;
    }
    // Skip list and quote markers.
    let mut i = from;
    while i < start && chars[i] == ' ' {
        i += 1;
    }
    if i < start {
        let marker_end = if matches!(chars[i], '-' | '*' | '+' | '>') {
            Some(i + 1)
        } else {
            let mut j = i;
            while j < start && chars[j].is_ascii_digit() {
                j += 1;
            }
            (j > i && j < start && matches!(chars[j], '.' | ')')).then_some(j + 1)
        };
        if let Some(m) = marker_end
            && m < start
            && chars[m] == ' '
        {
            from = m + 1;
        }
    }
    while from < start && chars[from].is_whitespace() {
        from += 1;
    }

    let mut to = end.max(from).min(len);
    while to < len {
        let ch = chars[to];
        if ch == '\n' {
            break;
        }
        to += 1;
        if TERMINATORS.contains(&ch) {
            while to < len && CLOSERS.contains(&chars[to]) {
                to += 1;
            }
            if to >= len {
                break;
            }
            if chars[to].is_whitespace() {
                let mut k = to;
                while k < len && chars[k] == ' ' {
                    k += 1;
                }
                if starts_sentence(chars, k) {
                    break;
                }
            }
        }
    }
    while to > from && chars[to - 1].is_whitespace() {
        to -= 1;
    }
    (from, to)
}

/// The line (paragraph in most editors) containing `pos`.
pub fn line_around(chars: &[char], pos: usize) -> (usize, usize) {
    let pos = pos.min(chars.len());
    let from = chars[..pos]
        .iter()
        .rposition(|c| *c == '\n')
        .map_or(0, |i| i + 1);
    let to = chars[pos..]
        .iter()
        .position(|c| *c == '\n')
        .map_or(chars.len(), |i| pos + i);
    (from, to)
}

/// A paragraph worth sending to the AI scan.
pub struct Paragraph {
    pub start: usize,
    pub text: String,
}

/// Prose paragraphs: skips code fences, headings, tables, and short lines.
pub fn prose_paragraphs(chars: &[char]) -> Vec<Paragraph> {
    let mut out = Vec::new();
    let mut in_code = false;
    let mut start = 0;
    for line in chars.split(|c| *c == '\n') {
        let line_start = start;
        start += line.len() + 1;
        let text: String = line.iter().collect();
        let trimmed = text.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code || trimmed.starts_with(['#', '|', '<']) {
            continue;
        }
        let words = trimmed
            .split_whitespace()
            .filter(|w| w.chars().any(|c| c.is_alphabetic()))
            .count();
        if words < 8 || line.len() > 2000 {
            continue;
        }
        out.push(Paragraph {
            start: line_start,
            text,
        });
    }
    out
}

/// Finds `quote` in `haystack` (char offsets), falling back to a case-insensitive match.
pub fn locate(haystack: &str, quote: &str) -> Option<(usize, usize)> {
    let q = quote
        .trim()
        .trim_matches(|c| c == '"' || c == '\u{201c}' || c == '\u{201d}');
    if q.chars().count() < 3 {
        return None;
    }
    let to_chars = |byte: usize, s: &str| s[..byte].chars().count();
    if let Some(b) = haystack.find(q) {
        let s = to_chars(b, haystack);
        return Some((s, s + q.chars().count()));
    }
    let lower_h = haystack.to_lowercase();
    let lower_q = q.to_lowercase();
    if lower_h.len() == haystack.len()
        && let Some(b) = lower_h.find(&lower_q)
    {
        let s = to_chars(b, &lower_h);
        return Some((s, s + lower_q.chars().count()));
    }
    None
}

/// FNV-1a hash, used for cache keys and ignore ids.
pub fn hash(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.encode_utf16() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:x}")
}

/// Keeps the author's straight or curly quotes so rewrites do not show fake punctuation edits.
pub fn match_quote_style(original: &str, rewrite: &str) -> String {
    let mut out = rewrite.to_string();
    if !original.contains(['\u{2018}', '\u{2019}']) {
        out = out.replace(['\u{2018}', '\u{2019}'], "'");
    }
    if !original.contains(['\u{201c}', '\u{201d}']) {
        out = out.replace(['\u{201c}', '\u{201d}'], "\"");
    }
    if !original.contains('\u{2014}') {
        out = out.replace(" \u{2014} ", ", ").replace('\u{2014}', ", ");
    }
    out
}

/// Trims wrapping quotes, drops rewrites identical to the original, and dedupes.
pub fn clean_rewrites(original: &str, rewrites: &[String], count: usize) -> Vec<String> {
    let original = original.trim();
    let mut out: Vec<String> = Vec::new();
    for r in rewrites {
        let mut s = r.trim().to_string();
        let quoted = |s: &str| {
            (s.starts_with('"') || s.starts_with('\u{201c}'))
                && (s.ends_with('"') || s.ends_with('\u{201d}'))
        };
        if s.chars().count() >= 2 && quoted(&s) && !quoted(original) {
            let inner: Vec<char> = s.chars().collect();
            s = inner[1..inner.len() - 1].iter().collect::<String>().trim().to_string();
        }
        s = match_quote_style(original, &s);
        if s.is_empty() || s == original || out.contains(&s) {
            continue;
        }
        out.push(s);
        if out.len() >= count {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence(text: &str, needle: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let byte = text.find(needle).unwrap();
        let start = text[..byte].chars().count();
        let (a, b) = sentence_around(&chars, start, start + needle.chars().count());
        chars[a..b].iter().collect()
    }

    #[test]
    fn finds_middle_sentence() {
        assert_eq!(
            sentence("One here. Two is long. Three.", "is"),
            "Two is long."
        );
    }

    #[test]
    fn keeps_page_abbreviations_inside() {
        assert_eq!(
            sentence("- She defends it (pp. 34-35). Next one.", "defends"),
            "She defends it (pp. 34-35)."
        );
    }

    #[test]
    fn stops_at_line_breaks() {
        assert_eq!(sentence("Title\nBody text here", "Body"), "Body text here");
    }

    #[test]
    fn locate_is_char_based() {
        assert_eq!(locate("caf\u{e9} is nice", "is nice"), Some((5, 12)));
    }

    #[test]
    fn clean_rewrites_dedupes() {
        let r = clean_rewrites(
            "a b",
            &["\"x y\"".into(), "a b".into(), "x y".into(), "z".into()],
            3,
        );
        assert_eq!(r, vec!["x y".to_string(), "z".to_string()]);
    }
}
