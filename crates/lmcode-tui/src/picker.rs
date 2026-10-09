//! Selector popup state (model / session pickers).

/// What a picker selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerKind {
    Model,
    Sessions,
}

/// One selectable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerItem {
    /// Value sent with the switch command (model alias / session id).
    pub id: String,
    /// Primary display text.
    pub label: String,
    /// Secondary display text.
    pub detail: String,
}

/// Open selector state.
#[derive(Debug)]
pub struct Picker {
    pub kind: PickerKind,
    pub title: String,
    pub items: Vec<PickerItem>,
    pub selected: usize,
}

impl Picker {
    pub fn new(kind: PickerKind, title: impl Into<String>, items: Vec<PickerItem>) -> Self {
        Self {
            kind,
            title: title.into(),
            items,
            selected: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn move_up(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn move_down(&mut self) {
        if self.selected + 1 < self.items.len() {
            self.selected += 1;
        }
    }

    pub fn selected_item(&self) -> Option<&PickerItem> {
        self.items.get(self.selected)
    }

    /// Visible window `(start, count)` keeping the selection roughly centered.
    pub fn window(&self, height: usize) -> (usize, usize) {
        if height == 0 || self.items.is_empty() {
            return (0, 0);
        }
        let count = height.min(self.items.len());
        let half = count / 2;
        let start = self
            .selected
            .saturating_sub(half)
            .min(self.items.len().saturating_sub(count));
        (start, count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picker(count: usize) -> Picker {
        let items = (0..count)
            .map(|index| PickerItem {
                id: format!("id-{index}"),
                label: format!("label {index}"),
                detail: String::new(),
            })
            .collect();
        Picker::new(PickerKind::Model, "test", items)
    }

    #[test]
    fn moves_within_bounds() {
        let mut picker = picker(3);
        picker.move_up();
        assert_eq!(picker.selected, 0, "cannot go above the first item");
        picker.move_down();
        picker.move_down();
        picker.move_down();
        assert_eq!(picker.selected, 2, "cannot go past the last item");
        assert_eq!(picker.selected_item().unwrap().id, "id-2");
    }

    #[test]
    fn window_centers_and_clamps() {
        let mut picker = picker(20);
        let (start, count) = picker.window(6);
        assert_eq!((start, count), (0, 6), "top of the list");

        picker.selected = 10;
        let (start, count) = picker.window(6);
        assert_eq!((start, count), (7, 6), "selection centered");

        picker.selected = 19;
        let (start, count) = picker.window(6);
        assert_eq!((start, count), (14, 6), "clamped at the bottom");

        let (start, count) = picker.window(50);
        assert_eq!((start, count), (0, 20), "window never exceeds items");
    }

    #[test]
    fn empty_picker_has_no_selection() {
        let picker = picker(0);
        assert!(picker.is_empty());
        assert!(picker.selected_item().is_none());
        assert_eq!(picker.window(5), (0, 0));
    }
}
