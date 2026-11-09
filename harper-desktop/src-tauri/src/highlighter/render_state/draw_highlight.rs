//! Draws lint highlights without owning popup selection or application state.

use harper_core::linting::Lint;

use super::{lint_kind_color32, rect_bounds};
use crate::rect::Rect;

/// Draws the always-visible lint marker without making the renderer responsible for popup state.
///
/// Harper Plus: a thin, rounded Grammarly-style underline with no fill, colored by category.
pub fn draw_highlight(ui: &mut egui::Ui, rect: &Rect, lint: &Lint) {
    let rect_bounds = rect_bounds(rect);
    let [r, g, b, _] = grammarly_color(lint).to_array();
    let underline_color = egui::Color32::from_rgba_unmultiplied(r, g, b, 200);
    let underline_height = rect_bounds.height().min(2.5);

    ui.painter().rect_filled(
        egui::Rect::from_min_max(
            egui::pos2(rect_bounds.left(), rect_bounds.bottom() - underline_height),
            rect_bounds.right_bottom(),
        ),
        1.5,
        underline_color,
    );
}

/// Red for correctness, blue for clarity, green for engagement, purple for delivery.
fn grammarly_color(lint: &Lint) -> egui::Color32 {
    use harper_core::linting::LintKind::*;
    match lint.lint_kind {
        Agreement | BoundaryError | Capitalization | Eggcorn | Grammar | Malapropism
        | Punctuation | Spelling | Typo => egui::Color32::from_rgb(0xe5, 0x48, 0x4d),
        Readability | Redundancy | Repetition | WordOrder => {
            egui::Color32::from_rgb(0x4a, 0x7c, 0xf0)
        }
        WordChoice | Enhancement | Style => egui::Color32::from_rgb(0x15, 0xa4, 0x6b),
        _ => egui::Color32::from_rgb(0x8a, 0x5c, 0xf5),
    }
}

#[allow(dead_code)]
/// Maps Harper lint kinds to egui colors at the drawing boundary so shared color data stays UI-toolkit
/// agnostic.
fn lint_color(lint: &Lint) -> egui::Color32 {
    lint_kind_color32(lint.lint_kind)
}
