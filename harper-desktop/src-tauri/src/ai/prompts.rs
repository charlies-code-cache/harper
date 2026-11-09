//! Prompts for Ollama's `/api/chat`, kept in step with `packages/obsidian-plugin/src/ai/prompts.ts`.

use serde_json::{Value, json};

use super::{FindingType, Tone};

/// What a rewrite should accomplish.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RewriteGoal {
    Fix { problem: String },
    Tone(Tone),
    Finding { kind: FindingType, reason: String },
}

impl RewriteGoal {
    pub fn key(&self) -> String {
        match self {
            Self::Fix { problem } => format!("fix:{problem}"),
            Self::Tone(t) => format!("tone:{}", t.name()),
            Self::Finding { kind, reason } => format!("finding:{}:{reason}", kind.key()),
        }
    }

    fn instruction(&self) -> String {
        match self {
            Self::Fix { problem } => format!(
                "A grammar checker flagged this problem: \"{problem}\". Edit the TEXT so the problem is gone, changing as few words as possible. If the problem is length, split or tighten it."
            ),
            Self::Tone(t) => format!(
                "Rewrite the TEXT so it sounds more {}, without changing what it says.",
                t.name()
            ),
            Self::Finding { kind, reason } => format!(
                "The TEXT has a {} problem: {reason}. Edit it to fix that, changing as few words as possible.",
                kind.label().to_lowercase()
            ),
        }
    }
}

pub struct PromptSpec {
    pub messages: Value,
    pub format: Value,
    pub num_predict: u32,
}

const SYSTEM: &str = "You are a careful writing assistant inside a grammar checker. Keep the author's meaning, voice, and facts. Never invent information. Keep Markdown, links, names, numbers, and quoted material exactly as written. Do not use em dashes. Keep straight quotes straight. Reply with JSON only.";

fn system(style_note: &str) -> Value {
    let note = style_note.trim();
    let content = if note.is_empty() {
        SYSTEM.to_string()
    } else {
        format!("{SYSTEM} Author preference: {note}")
    };
    json!({ "role": "system", "content": content })
}

pub fn rewrite(
    target: &str,
    context: &str,
    goal: &RewriteGoal,
    count: usize,
    style_note: &str,
) -> PromptSpec {
    let context_block = if !context.trim().is_empty() && context.trim() != target.trim() {
        format!("Surrounding paragraph, for context only (do not rewrite it):\n{context}\n\n")
    } else {
        String::new()
    };
    let plural = if count == 1 { "" } else { "s" };
    PromptSpec {
        messages: json!([
            system(style_note),
            {
                "role": "user",
                "content": format!(
                    "{}\nGive {count} distinct rewrite{plural}, best first. Each one must be a drop-in replacement for the TEXT only, with no commentary.\n\n{context_block}TEXT:\n{target}",
                    goal.instruction()
                ),
            }
        ]),
        format: json!({
            "type": "object",
            "properties": {
                "rewrites": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": count }
            },
            "required": ["rewrites"]
        }),
        num_predict: 120 + (target.chars().count() as u32 / 3 + 1) * count as u32,
    }
}

pub fn scan(paragraph: &str, types: &[FindingType], style_note: &str) -> PromptSpec {
    let descriptions: Vec<&str> = types.iter().map(|t| t.description()).collect();
    let keys: Vec<&str> = types.iter().map(|t| t.key()).collect();
    PromptSpec {
        messages: json!([
            system(style_note),
            {
                "role": "user",
                "content": format!(
                    "Review the PARAGRAPH for these problem types only: {}.\nFlag at most 3 clear problems that a skilled editor would change. Ignore spelling, grammar, punctuation, citations, and personal style. If the writing is fine, return an empty list.\nFor each problem, copy the exact text span from the paragraph into \"quote\", character for character. For word_choice, quote only the weak word or short phrase; for the other types, quote the clause or sentence. Set \"type\", and give a \"reason\" under 12 words.\n\nPARAGRAPH:\n{paragraph}",
                    descriptions.join("; ")
                ),
            }
        ]),
        format: json!({
            "type": "object",
            "properties": {
                "issues": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "quote": { "type": "string" },
                            "type": { "type": "string", "enum": keys },
                            "reason": { "type": "string" }
                        },
                        "required": ["quote", "type", "reason"]
                    }
                }
            },
            "required": ["issues"]
        }),
        num_predict: 400,
    }
}

pub fn tone(text: &str, style_note: &str) -> PromptSpec {
    PromptSpec {
        messages: json!([
            system(style_note),
            {
                "role": "user",
                "content": format!(
                    "Describe how the TEXT sounds to a reader.\n\"tones\": up to 3 one-word tone labels, strongest first (for example confident, friendly, formal, casual, tentative, urgent, enthusiastic, critical).\n\"formality\": one of very casual, casual, neutral, formal, very formal.\n\"confidence\": one of tentative, neutral, confident.\n\"summary\": one sentence under 20 words about the overall impression.\n\nTEXT:\n{text}"
                ),
            }
        ]),
        format: json!({
            "type": "object",
            "properties": {
                "tones": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
                "formality": { "type": "string" },
                "confidence": { "type": "string" },
                "summary": { "type": "string" }
            },
            "required": ["tones", "formality", "confidence", "summary"]
        }),
        num_predict: 160,
    }
}
