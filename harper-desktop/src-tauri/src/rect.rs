use crate::color::Color;
use harper_core::{
    Span,
    linting::{Lint, Suggestion},
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Constructs a copy of the Rect, with the given amount of padding around the original.
    pub fn with_padding(&self, n: f64) -> Self {
        Self {
            x: self.x - n,
            y: self.y - n,
            width: self.width + 2.0 * n,
            height: self.height + 2.0 * n,
        }
    }

    /// Similar to [`Self::with_padding`], but preconfigured to a value that is forgiving to the
    /// user.
    pub fn with_friendly_padding(&self) -> Self {
        self.with_padding(2.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColoredRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Color,
}

/// A Harper lint paired with the screen-space rectangle where it should be rendered.
///
/// Harper owns the lint details and accessibility owns the geometry; this type keeps both pieces
/// together without duplicating lint fields into highlighter-specific strings.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionedLint {
    pub rect: Rect,
    pub lint: Lint,
}

/// A Harper lint paired with geometry, source context, and an OS-specific suggestion action.
///
/// The highlighter owns rendering and interaction, but the OS broker is the only layer that knows how
/// to mutate the underlying text element. Storing a one-shot callback here keeps those responsibilities
/// connected without teaching rendering code about Accessibility APIs.
pub struct ActionableLint {
    pub rect: Rect,
    pub rule_name: String,
    pub lint: Lint,
    pub source_text: String,
    apply_suggestion: Option<Box<dyn FnOnce(Span<char>, Suggestion)>>,
}

impl PositionedLint {
    pub fn new(rect: Rect, lint: Lint) -> Self {
        Self { rect, lint }
    }
}

impl ActionableLint {
    pub fn new(
        rect: Rect,
        rule_name: String,
        lint: Lint,
        source_text: String,
        apply_suggestion: impl FnOnce(Span<char>, Suggestion) + 'static,
    ) -> Self {
        Self {
            rect,
            rule_name,
            lint,
            source_text,
            apply_suggestion: Some(Box::new(apply_suggestion)),
        }
    }

    pub fn apply_suggestion(&mut self, suggestion: Suggestion) {
        let span = self.lint.span;
        if let Some(apply_suggestion) = self.apply_suggestion.take() {
            apply_suggestion(span, suggestion);
        }
    }

    /// Harper Plus: replaces an arbitrary span of the source text (e.g. a whole sentence) with an
    /// AI rewrite, through the same OS-specific callback suggestions use.
    pub fn apply_replacement(&mut self, span: Span<char>, text: &str) {
        if let Some(apply_suggestion) = self.apply_suggestion.take() {
            apply_suggestion(span, Suggestion::ReplaceWith(text.chars().collect()));
        }
    }
}

impl ColoredRect {
    pub fn new(x: f64, y: f64, width: f64, height: f64, color: Color) -> Self {
        Self {
            x,
            y,
            width,
            height,
            color,
        }
    }
}
