//! Word-level diff for Grammarly-style rewrite display, kept in step with
//! `packages/obsidian-plugin/src/ai/diff.ts`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffPart {
    Same(String),
    Del(String),
    Ins(String),
}

fn tokenize(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let word = |c: char| c.is_alphanumeric() || c == '\'' || c == '\u{2019}' || c == '-';
    for c in s.chars() {
        let class = if word(c) {
            0
        } else if c.is_whitespace() {
            1
        } else {
            2
        };
        let joins = out.last().is_some_and(|last: &String| {
            let lc = last.chars().last().unwrap();
            let last_class = if word(lc) {
                0
            } else if lc.is_whitespace() {
                1
            } else {
                2
            };
            class != 2 && last_class == class
        });
        if joins {
            out.last_mut().unwrap().push(c);
        } else {
            out.push(c.to_string());
        }
    }
    out
}

/// Diffs `before` against `after`, grouping each run of changes into one deletion then one insertion.
pub fn word_diff(before: &str, after: &str) -> Vec<DiffPart> {
    let a = tokenize(before);
    let b = tokenize(after);
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    #[derive(PartialEq)]
    enum K {
        S,
        D,
        I,
    }
    let mut ops: Vec<(K, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push((K::S, &a[i]));
            i += 1;
            j += 1;
        } else if j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            ops.push((K::I, &b[j]));
            j += 1;
        } else {
            ops.push((K::D, &a[i]));
            i += 1;
        }
    }

    let mut parts: Vec<DiffPart> = Vec::new();
    let push_same = |parts: &mut Vec<DiffPart>, t: &str| {
        if let Some(DiffPart::Same(last)) = parts.last_mut() {
            last.push_str(t);
        } else {
            parts.push(DiffPart::Same(t.to_string()));
        }
    };
    let mut k = 0;
    while k < ops.len() {
        if ops[k].0 == K::S {
            push_same(&mut parts, ops[k].1);
            k += 1;
            continue;
        }
        let (mut del, mut ins) = (String::new(), String::new());
        while k < ops.len() {
            let (kind, t) = &ops[k];
            match kind {
                K::D => del.push_str(t),
                K::I => ins.push_str(t),
                K::S if t.chars().all(char::is_whitespace)
                    && ops.get(k + 1).is_some_and(|o| o.0 != K::S) =>
                {
                    del.push_str(t);
                    ins.push_str(t);
                }
                K::S => break,
            }
            k += 1;
        }
        let basis = if del.is_empty() { &ins } else { &del };
        let lead: String = basis.chars().take_while(|c| c.is_whitespace()).collect();
        let trail: String = basis
            .chars()
            .rev()
            .take_while(|c| c.is_whitespace())
            .collect();
        if !lead.is_empty() {
            push_same(&mut parts, &lead);
        }
        if !del.trim().is_empty() {
            parts.push(DiffPart::Del(del.trim().to_string()));
        }
        if !ins.trim().is_empty() {
            parts.push(DiffPart::Ins(ins.trim().to_string()));
        }
        if !trail.is_empty() && trail != lead {
            parts.push(DiffPart::Same(trail));
        }
    }
    parts
}

/// Share of the original text a rewrite removes, from 0 to 1.
pub fn change_ratio(parts: &[DiffPart], before: &str) -> f32 {
    let removed: usize = parts
        .iter()
        .map(|p| match p {
            DiffPart::Del(t) => t.chars().count(),
            _ => 0,
        })
        .sum();
    let total = before.chars().count();
    if total == 0 {
        1.0
    } else {
        removed as f32 / total as f32
    }
}

/// One self-contained edit inside a rewrite, positioned in the original text (char offsets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cluster {
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub after: String,
}

/// Splits a rewrite into separate edits, like Grammarly's small corrections. Pure insertions attach
/// to the word before them; edits separated by one or two short words merge.
pub fn change_clusters(before: &str, after: &str) -> Vec<Cluster> {
    let a = tokenize(before);
    let b = tokenize(after);
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    // (kind: 0 same, 1 del, 2 ins, text, char position in `before`)
    let mut ops: Vec<(u8, &str, usize)> = Vec::new();
    let (mut i, mut j, mut pos) = (0, 0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push((0, &a[i], pos));
            pos += a[i].chars().count();
            i += 1;
            j += 1;
        } else if j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            ops.push((2, &b[j], pos));
            j += 1;
        } else {
            ops.push((1, &a[i], pos));
            pos += a[i].chars().count();
            i += 1;
        }
    }
    let chars: Vec<char> = before.chars().collect();
    let slice = |s: usize, e: usize| chars[s..e].iter().collect::<String>();
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut k = 0;
    while k < ops.len() {
        if ops[k].0 == 0 {
            k += 1;
            continue;
        }
        let from = ops[k].2;
        let mut to = from;
        let mut ins = String::new();
        while k < ops.len() {
            let (kind, t, p) = ops[k];
            match kind {
                1 => to = p + t.chars().count(),
                2 => ins.push_str(t),
                _ if t.chars().all(char::is_whitespace)
                    && ops.get(k + 1).is_some_and(|o| o.0 != 0) =>
                {
                    to = p + t.chars().count();
                    ins.push_str(t);
                }
                _ => break,
            }
            k += 1;
        }
        let mut start = from;
        let mut del: Vec<char> = chars[from..to].to_vec();
        let mut insc: Vec<char> = ins.chars().collect();
        while !del.is_empty() && !insc.is_empty() && del[0].is_whitespace() && del[0] == insc[0] {
            del.remove(0);
            insc.remove(0);
            start += 1;
        }
        while !del.is_empty()
            && !insc.is_empty()
            && del[del.len() - 1].is_whitespace()
            && del.last() == insc.last()
        {
            del.pop();
            insc.pop();
        }
        let mut end = start + del.len();
        let mut before_s: String = del.iter().collect();
        let mut after_s: String = insc.iter().collect();
        if before_s.trim().is_empty() {
            let mut e = start;
            while e > 0 && chars[e - 1].is_whitespace() {
                e -= 1;
            }
            let mut s = e;
            while s > 0 && !chars[s - 1].is_whitespace() {
                s -= 1;
            }
            if s == e {
                continue;
            }
            after_s = slice(s, start) + &after_s;
            before_s = slice(s, end);
            start = s;
            end = s + before_s.chars().count();
        }
        if before_s == after_s {
            continue;
        }
        clusters.push(Cluster {
            start,
            end,
            before: before_s,
            after: after_s,
        });
    }
    let mut merged: Vec<Cluster> = Vec::new();
    for c in clusters {
        if let Some(last) = merged.last_mut() {
            let gap = slice(last.end, c.start);
            if gap.chars().count() <= 14 && gap.split_whitespace().count() <= 2 {
                last.after = format!("{}{}{}", last.after, gap, c.after);
                last.before = slice(last.start, c.end);
                last.end = c.end;
                continue;
            }
        }
        merged.push(c);
    }
    merged
}

/// The edits of a rewrite, or `None` when it changes too much to split into small corrections.
pub fn rewrite_clusters(before: &str, after: &str) -> Option<Vec<Cluster>> {
    if change_ratio(&word_diff(before, after), before) > 0.6 {
        return None;
    }
    let clusters = change_clusters(before, after);
    (!clusters.is_empty() && clusters.len() <= 4).then_some(clusters)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(a: &str, b: &str) -> String {
        word_diff(a, b)
            .into_iter()
            .map(|p| match p {
                DiffPart::Same(t) => t,
                DiffPart::Del(t) => format!("[-{t}-]"),
                DiffPart::Ins(t) => format!("{{+{t}+}}"),
            })
            .collect()
    }

    #[test]
    fn matches_grammarly_example() {
        assert_eq!(
            show(
                "when one adjusts their language by responding to inter-group cues.",
                "when someone adjusts their language in response to intergroup cues."
            ),
            "when [-one-]{+someone+} adjusts their language [-by responding-]{+in response+} to [-inter-group-]{+intergroup+} cues."
        );
    }

    #[test]
    fn clusters_split_and_attach_insertions() {
        let c = change_clusters("In class we discussed it.", "In class, we discussed it.");
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].before.as_str(), c[0].after.as_str()), ("class", "class,"));
        let c = change_clusters(
            "While I once again agree with your end conclusion, I think you are missing an even bigger argument.",
            "While I again agree with your conclusion, I think you are missing an even stronger argument.",
        );
        assert_eq!(c.len(), 3);
        assert_eq!(c[2].after, "stronger");
    }

    #[test]
    fn pure_deletion() {
        assert_eq!(
            show("it is really very good.", "it is good."),
            "it is [-really very-] good."
        );
    }
}
