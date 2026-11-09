//! Harper Plus: local AI writing help through Ollama.
//!
//! [`AiEngine`] owns one worker thread that talks to Ollama, so only one generation runs at a time.
//! Every public method is non-blocking: it returns a cached result or [`AiStatus::Pending`] and
//! queues the work. The highlighter redraws every frame, so results appear as soon as they land.

pub mod diff;
pub mod prompts;
pub mod text;

use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

use harper_core::linting::LintKind;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use prompts::RewriteGoal;

/// The rule name AI lints are reported under.
pub const AI_RULE: &str = "HarperPlusAI";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTiming {
    /// Generate when a popup opens, then cache.
    Hover,
    /// Generate for every flag in the background.
    Prefetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RewriteScope {
    Sentence,
    All,
}

/// User settings for the AI features, persisted in the desktop `config.json` under `"ai"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    pub enabled: bool,
    pub ollama_url: String,
    pub model: String,
    pub timing: AiTiming,
    pub rewrites: bool,
    pub rewrite_scope: RewriteScope,
    pub clarity: bool,
    pub tone_detection: bool,
    pub tone_rewrites: bool,
    pub word_choice: bool,
    pub rewrite_count: u8,
    pub temperature: f32,
    pub scan_idle_ms: u64,
    pub style_note: String,
    pub ignored: Vec<String>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ollama_url: "http://localhost:11434".into(),
            model: "gemma3:4b".into(),
            timing: AiTiming::Hover,
            rewrites: true,
            rewrite_scope: RewriteScope::Sentence,
            clarity: true,
            tone_detection: true,
            tone_rewrites: true,
            word_choice: true,
            rewrite_count: 3,
            temperature: 0.5,
            scan_idle_ms: 2500,
            style_note: String::new(),
            ignored: Vec::new(),
        }
    }
}

impl AiConfig {
    fn count(&self) -> usize {
        self.rewrite_count.clamp(1, 3) as usize
    }

    /// Whether a Harper lint of this kind gets AI rewrites in its popup.
    pub fn rewrites_lint_kind(&self, kind: LintKind) -> bool {
        if !self.enabled || !self.rewrites || is_spelling(kind) {
            return false;
        }
        match self.rewrite_scope {
            RewriteScope::All => true,
            RewriteScope::Sentence => is_sentence_level(kind),
        }
    }

    pub fn scan_types(&self) -> Vec<FindingType> {
        let mut types = Vec::new();
        if self.enabled && self.clarity {
            types.extend([FindingType::Clarity, FindingType::Conciseness]);
        }
        if self.enabled && self.word_choice {
            types.extend([FindingType::WordChoice, FindingType::Fluency]);
        }
        types
    }

    /// Settings whose change invalidates cached generations.
    fn cache_identity(&self) -> (String, String, u8, String, u32) {
        (
            self.ollama_url.clone(),
            self.model.clone(),
            self.rewrite_count,
            self.style_note.clone(),
            self.temperature.to_bits(),
        )
    }
}

fn is_spelling(kind: LintKind) -> bool {
    matches!(
        kind,
        LintKind::Spelling | LintKind::Typo | LintKind::Eggcorn | LintKind::Malapropism
    )
}

fn is_sentence_level(kind: LintKind) -> bool {
    matches!(
        kind,
        LintKind::Readability
            | LintKind::Style
            | LintKind::Redundancy
            | LintKind::Repetition
            | LintKind::WordChoice
            | LintKind::Enhancement
            | LintKind::WordOrder
            | LintKind::Usage
            | LintKind::Nonstandard
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FindingType {
    Clarity,
    Conciseness,
    WordChoice,
    Fluency,
}

impl FindingType {
    pub fn key(self) -> &'static str {
        match self {
            Self::Clarity => "clarity",
            Self::Conciseness => "conciseness",
            Self::WordChoice => "word_choice",
            Self::Fluency => "fluency",
        }
    }

    fn from_key(s: &str) -> Option<Self> {
        [
            Self::Clarity,
            Self::Conciseness,
            Self::WordChoice,
            Self::Fluency,
        ]
        .into_iter()
        .find(|t| t.key() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Clarity => "Clarity",
            Self::Conciseness => "Conciseness",
            Self::WordChoice => "Word choice",
            Self::Fluency => "Fluency",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Clarity => "clarity (hard to follow, vague, or ambiguous)",
            Self::Conciseness => "conciseness (wordy, padded, or redundant)",
            Self::WordChoice => {
                "word_choice (a weak, vague, or imprecise word that has a stronger option)"
            }
            Self::Fluency => "fluency (awkward or unnatural phrasing)",
        }
    }

    /// The Harper lint kind an AI finding is shown as, so it shares Harper's colors.
    pub fn lint_kind(self) -> LintKind {
        match self {
            Self::Clarity => LintKind::Readability,
            Self::Conciseness => LintKind::Redundancy,
            Self::WordChoice => LintKind::WordChoice,
            Self::Fluency => LintKind::Style,
        }
    }

    pub fn from_lint_kind(kind: LintKind) -> Self {
        match kind {
            LintKind::Readability => Self::Clarity,
            LintKind::Redundancy => Self::Conciseness,
            LintKind::WordChoice => Self::WordChoice,
            _ => Self::Fluency,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tone {
    Formal,
    Casual,
    Confident,
    Friendly,
    Concise,
}

impl Tone {
    pub const ALL: [Tone; 5] = [
        Tone::Formal,
        Tone::Casual,
        Tone::Confident,
        Tone::Friendly,
        Tone::Concise,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Formal => "formal",
            Self::Casual => "casual",
            Self::Confident => "confident",
            Self::Friendly => "friendly",
            Self::Concise => "concise",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Formal => "Formal",
            Self::Casual => "Casual",
            Self::Confident => "Confident",
            Self::Friendly => "Friendly",
            Self::Concise => "Concise",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToneReport {
    pub tones: Vec<String>,
    pub formality: String,
    pub confidence: String,
    pub summary: String,
}

impl ToneReport {
    pub fn short(&self) -> String {
        let label = self
            .tones
            .iter()
            .take(2)
            .map(|t| {
                let mut c = t.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(", ");
        if label.is_empty() {
            self.formality.clone()
        } else {
            label
        }
    }
}

/// An AI-detected problem positioned in the scanned text (char offsets).
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub start: usize,
    pub end: usize,
    pub quote: String,
    pub kind: FindingType,
    pub reason: String,
    pub id: String,
    pub paragraph: String,
}

#[derive(Debug, Clone, PartialEq)]
struct RawFinding {
    quote: String,
    kind: FindingType,
    reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiStatus<T> {
    Pending,
    Ready(T),
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Prefetch = 0,
    Scan = 1,
    Tone = 2,
    Hover = 3,
}

#[derive(Debug, Clone)]
enum Entry {
    Pending,
    Rewrites(Vec<String>),
    Findings(Vec<RawFinding>),
    Tone(ToneReport),
    Error(String),
}

#[derive(Debug, Clone)]
enum JobKind {
    Rewrite {
        target: String,
        context: String,
        goal: RewriteGoal,
    },
    Scan {
        paragraph: String,
        types: Vec<FindingType>,
    },
    Tone {
        text: String,
    },
}

struct Job {
    key: String,
    priority: Priority,
    requested: Instant,
    kind: JobKind,
}

struct State {
    config: AiConfig,
    cache: HashMap<String, Entry>,
    queue: Vec<Job>,
    first_seen: HashMap<String, Instant>,
}

const STALE: Duration = Duration::from_secs(60);
const CACHE_LIMIT: usize = 800;

pub struct AiEngine {
    shared: Arc<(Mutex<State>, Condvar)>,
}

static ENGINE: OnceLock<AiEngine> = OnceLock::new();

/// The process-wide engine. Its worker thread starts on first use.
pub fn engine() -> &'static AiEngine {
    ENGINE.get_or_init(AiEngine::start)
}

impl AiEngine {
    fn start() -> Self {
        let shared = Arc::new((
            Mutex::new(State {
                config: AiConfig::default(),
                cache: HashMap::new(),
                queue: Vec::new(),
                first_seen: HashMap::new(),
            }),
            Condvar::new(),
        ));
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("harper-plus-ai".into())
            .spawn(move || worker_loop(worker))
            .expect("failed to start the AI worker");
        Self { shared }
    }

    pub fn config(&self) -> AiConfig {
        self.shared.0.lock().unwrap().config.clone()
    }

    pub fn set_config(&self, config: AiConfig) {
        let mut state = self.shared.0.lock().unwrap();
        if state.config.cache_identity() != config.cache_identity() {
            state.cache.clear();
            state.queue.clear();
            state.first_seen.clear();
        }
        state.config = config;
    }

    fn request(&self, key: String, priority: Priority, kind: JobKind) -> Option<Entry> {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap();
        if let Some(job) = state.queue.iter_mut().find(|j| j.key == key) {
            job.requested = Instant::now();
            job.priority = job.priority.max(priority);
            return None;
        }
        match state.cache.get(&key) {
            Some(Entry::Pending) => return None,
            Some(entry) => return Some(entry.clone()),
            None => {}
        }
        state.cache.insert(key.clone(), Entry::Pending);
        state.queue.push(Job {
            key,
            priority,
            requested: Instant::now(),
            kind,
        });
        cvar.notify_one();
        None
    }

    fn rewrite_key(config: &AiConfig, target: &str, goal: &RewriteGoal) -> String {
        format!(
            "rw:{}:{}:{}",
            config.count(),
            text::hash(&goal.key()),
            text::hash(target)
        )
    }

    pub fn rewrites(
        &self,
        target: &str,
        context: &str,
        goal: &RewriteGoal,
        priority: Priority,
    ) -> AiStatus<Vec<String>> {
        let config = self.config();
        if !config.enabled {
            return AiStatus::Error("AI features are turned off.".into());
        }
        let key = Self::rewrite_key(&config, target, goal);
        match self.request(
            key,
            priority,
            JobKind::Rewrite {
                target: target.to_string(),
                context: context.to_string(),
                goal: goal.clone(),
            },
        ) {
            None => AiStatus::Pending,
            Some(Entry::Rewrites(r)) => AiStatus::Ready(r),
            Some(Entry::Error(e)) => AiStatus::Error(e),
            Some(_) => AiStatus::Pending,
        }
    }

    /// Cached rewrites for a target, without queuing any work.
    pub fn peek_rewrites(&self, target: &str, goal: &RewriteGoal) -> Option<Vec<String>> {
        let state = self.shared.0.lock().unwrap();
        let key = Self::rewrite_key(&state.config, target, goal);
        match state.cache.get(&key) {
            Some(Entry::Rewrites(r)) => Some(r.clone()),
            _ => None,
        }
    }

    pub fn tone(&self, text: &str, priority: Priority) -> AiStatus<ToneReport> {
        let body: String = text.chars().take(6000).collect();
        let key = format!("tone:{}", text::hash(&body));
        match self.request(key, priority, JobKind::Tone { text: body }) {
            None => AiStatus::Pending,
            Some(Entry::Tone(t)) => AiStatus::Ready(t),
            Some(Entry::Error(e)) => AiStatus::Error(e),
            Some(_) => AiStatus::Pending,
        }
    }

    /// Returns cached findings for `chars` and queues scans for paragraphs that have settled.
    pub fn scan(&self, chars: &[char]) -> Vec<Finding> {
        let config = self.config();
        let types = config.scan_types();
        if types.is_empty() {
            return Vec::new();
        }
        let type_key = types.iter().map(|t| t.key()).collect::<Vec<_>>().join(",");
        let idle = Duration::from_millis(config.scan_idle_ms);
        let mut findings = Vec::new();

        for p in text::prose_paragraphs(chars).into_iter().take(40) {
            let key = format!("scan:{type_key}:{}", text::hash(&p.text));
            let cached = self.shared.0.lock().unwrap().cache.get(&key).cloned();
            match cached {
                Some(Entry::Findings(raw)) => {
                    for f in raw {
                        if let Some((s, e)) = text::locate(&p.text, &f.quote) {
                            let id = text::hash(&f.quote);
                            if config.ignored.contains(&id) {
                                continue;
                            }
                            findings.push(Finding {
                                start: p.start + s,
                                end: p.start + e,
                                quote: f.quote,
                                kind: f.kind,
                                reason: f.reason,
                                id,
                                paragraph: p.text.clone(),
                            });
                        }
                    }
                    continue;
                }
                Some(_) => continue,
                None => {}
            }
            let settled = {
                let mut state = self.shared.0.lock().unwrap();
                let seen = *state
                    .first_seen
                    .entry(key.clone())
                    .or_insert_with(Instant::now);
                if state.first_seen.len() > 400 {
                    state.first_seen.retain(|_, t| t.elapsed() < STALE);
                }
                seen.elapsed() >= idle
            };
            if settled {
                self.request(
                    key,
                    Priority::Scan,
                    JobKind::Scan {
                        paragraph: p.text,
                        types: types.clone(),
                    },
                );
            }
        }
        findings
    }
}

fn worker_loop(shared: Arc<(Mutex<State>, Condvar)>) {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("failed to build HTTP client");
    let (lock, cvar) = &*shared;
    loop {
        let (job, config) = {
            let mut state = lock.lock().unwrap();
            loop {
                let now = Instant::now();
                let mut dropped = Vec::new();
                state.queue.retain(|j| {
                    let keep = j.priority >= Priority::Tone || now - j.requested < STALE;
                    if !keep {
                        dropped.push(j.key.clone());
                    }
                    keep
                });
                for key in dropped {
                    state.cache.remove(&key);
                }
                if let Some(best) = state
                    .queue
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| {
                        a.priority
                            .cmp(&b.priority)
                            .then(a.requested.cmp(&b.requested))
                    })
                    .map(|(i, _)| i)
                {
                    let job = state.queue.swap_remove(best);
                    break (job, state.config.clone());
                }
                state = cvar.wait(state).unwrap();
            }
        };

        let entry = run_job(&client, &config, &job.kind).unwrap_or_else(Entry::Error);
        let mut state = lock.lock().unwrap();
        if state.cache.len() > CACHE_LIMIT {
            state.cache.retain(|_, e| matches!(e, Entry::Pending));
        }
        // A config change clears the cache; do not resurrect results for old settings.
        if state.cache.contains_key(&job.key) {
            state.cache.insert(job.key, entry);
        }
    }
}

fn run_job(
    client: &reqwest::blocking::Client,
    config: &AiConfig,
    kind: &JobKind,
) -> Result<Entry, String> {
    match kind {
        JobKind::Rewrite {
            target,
            context,
            goal,
        } => {
            let out = chat(
                client,
                config,
                prompts::rewrite(target, context, goal, config.count(), &config.style_note),
            )?;
            let raw: Vec<String> = out["rewrites"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let rewrites = text::clean_rewrites(target, &raw, config.count());
            if rewrites.is_empty() {
                Err("No rewrites came back.".into())
            } else {
                Ok(Entry::Rewrites(rewrites))
            }
        }
        JobKind::Scan { paragraph, types } => {
            let out = chat(
                client,
                config,
                prompts::scan(paragraph, types, &config.style_note),
            )?;
            let mut found = Vec::new();
            for issue in out["issues"].as_array().into_iter().flatten() {
                let (Some(quote), Some(kind)) = (
                    issue["quote"].as_str(),
                    issue["type"].as_str().and_then(FindingType::from_key),
                ) else {
                    continue;
                };
                if !types.contains(&kind) {
                    continue;
                }
                let Some((s, e)) = text::locate(paragraph, quote) else {
                    continue;
                };
                let exact: String = paragraph.chars().skip(s).take(e - s).collect();
                if exact.split_whitespace().count() < 2 && kind != FindingType::WordChoice {
                    continue;
                }
                found.push(RawFinding {
                    quote: exact,
                    kind,
                    reason: issue["reason"].as_str().unwrap_or("").trim().to_string(),
                });
            }
            Ok(Entry::Findings(found))
        }
        JobKind::Tone { text } => {
            let out = chat(client, config, prompts::tone(text, &config.style_note))?;
            let s = |k: &str| out[k].as_str().unwrap_or("").to_string();
            Ok(Entry::Tone(ToneReport {
                tones: out["tones"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .take(3)
                            .collect()
                    })
                    .unwrap_or_default(),
                formality: s("formality"),
                confidence: s("confidence"),
                summary: s("summary"),
            }))
        }
    }
}

/// What an AI rewrite of a lint replaces: the sentence around it, with the lint's problem as the goal.
pub struct LintTarget {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub context: String,
    pub goal: RewriteGoal,
}

/// Builds the rewrite target for a lint, or `None` when its kind does not get AI rewrites.
pub fn lint_target(
    config: &AiConfig,
    chars: &[char],
    rule: &str,
    lint: &harper_core::linting::Lint,
) -> Option<LintTarget> {
    if !config.enabled || lint.span.end > chars.len() {
        return None;
    }
    let goal = if rule == AI_RULE {
        RewriteGoal::Finding {
            kind: FindingType::from_lint_kind(lint.lint_kind),
            reason: lint.message.clone(),
        }
    } else if config.rewrites_lint_kind(lint.lint_kind) {
        RewriteGoal::Fix {
            problem: lint.message.clone(),
        }
    } else {
        return None;
    };
    let (start, end) = text::sentence_around(chars, lint.span.start, lint.span.end);
    let (line_start, line_end) = text::line_around(chars, lint.span.start);
    Some(LintTarget {
        start,
        end,
        text: chars[start..end].iter().collect(),
        context: chars[line_start..line_end].iter().collect(),
        goal,
    })
}

/// Char ranges in `before` that a rewrite changes, one per small correction, trimmed of spaces.
pub fn changed_ranges(before: &str, after: &str) -> Vec<(usize, usize)> {
    diff::rewrite_clusters(before, after)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let lead = c.before.chars().take_while(|ch| ch.is_whitespace()).count();
            let trail = c.before.chars().rev().take_while(|ch| ch.is_whitespace()).count();
            let start = c.start + lead;
            (start, (c.end - trail).max(start + 1))
        })
        .collect()
}

/// A short anchor on the first few words of a long flag, used until its rewrite is known.
pub fn anchor_range(chars: &[char], start: usize, end: usize) -> (usize, usize) {
    let mut words = 0;
    let mut i = start;
    let mut last = start;
    while i < end && words < 3 {
        while i < end && chars[i].is_whitespace() {
            i += 1;
        }
        let w = i;
        while i < end && !chars[i].is_whitespace() {
            i += 1;
        }
        if i > w {
            words += 1;
            last = i;
        }
    }
    (start, last.max(start + 1).min(end.max(start + 1)))
}

fn base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn chat(
    client: &reqwest::blocking::Client,
    config: &AiConfig,
    spec: prompts::PromptSpec,
) -> Result<Value, String> {
    let url = format!("{}/api/chat", base_url(&config.ollama_url));
    let body = json!({
        "model": config.model,
        "messages": spec.messages,
        "stream": false,
        "format": spec.format,
        "keep_alive": "15m",
        "options": { "temperature": config.temperature, "num_predict": spec.num_predict },
    });
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| connection_error(&e, &config.ollama_url))?;
    let status = res.status();
    let value: Value = res.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("Ollama returned HTTP {status}")));
    }
    let content = value["message"]["content"].as_str().unwrap_or("");
    serde_json::from_str(content)
        .or_else(|_| {
            let start = content.find('{').ok_or(())?;
            let end = content.rfind('}').ok_or(())?;
            serde_json::from_str(&content[start..=end]).map_err(|_| ())
        })
        .map_err(|_| "The model did not return valid JSON.".to_string())
}

fn connection_error(e: &reqwest::Error, url: &str) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("Ollama is not reachable at {url}.")
    } else {
        e.to_string()
    }
}

/// Lists installed model names from Ollama's `/api/tags`. Blocking; call off the UI thread.
pub fn list_models(url: &str) -> Result<Vec<String>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{}/api/tags", base_url(url)))
        .send()
        .map_err(|e| connection_error(&e, url))?;
    let value: Value = res.json().map_err(|e| e.to_string())?;
    let mut names: Vec<String> = value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["name"].as_str().map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

/// Runs one rewrite synchronously, for the settings window's "Test" button.
pub fn test_rewrite(config: &AiConfig) -> Result<(Vec<String>, f64), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let sample =
        "In my opinion I think that the meeting that we had was kind of not very productive.";
    let entry = run_job(
        &client,
        config,
        &JobKind::Rewrite {
            target: sample.into(),
            context: String::new(),
            goal: RewriteGoal::Fix {
                problem: "This sentence is wordy.".into(),
            },
        },
    )?;
    match entry {
        Entry::Rewrites(r) => Ok((r, started.elapsed().as_secs_f64())),
        _ => Err("Unexpected result.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_and_fills_defaults() {
        let parsed: AiConfig = serde_json::from_str(r#"{"timing":"prefetch","model":"x"}"#).unwrap();
        assert_eq!(parsed.timing, AiTiming::Prefetch);
        assert_eq!(parsed.model, "x");
        assert_eq!(parsed.ollama_url, AiConfig::default().ollama_url);
    }

    #[test]
    fn sentence_scope_skips_spelling_and_punctuation() {
        let c = AiConfig::default();
        assert!(c.rewrites_lint_kind(LintKind::Readability));
        assert!(!c.rewrites_lint_kind(LintKind::Spelling));
        assert!(!c.rewrites_lint_kind(LintKind::Punctuation));
    }
}
