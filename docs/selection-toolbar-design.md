# Selection And Toolbar Design

## Understanding

- Editing focus must not look like multi-block selection.
- Block highlighting is reserved for hover, marquee selection, Shift selection, and dragging.
- The inline text toolbar is shown only for non-empty text selected within one editable block.
- Clicking outside the inline toolbar, clicking a different block, or pressing Escape clears the text selection and hides the toolbar.
- Toolbar actions preserve the native text selection long enough to apply formatting.
- The implementation remains native browser JavaScript with contenteditable and no new dependencies.

## Design

Browser Selection is the only source of truth for text selection. The Editor introduces a narrow predicate that accepts only non-collapsed selections whose anchor and focus are in the same `.ed` element. The existing `.selected` CSS class represents only explicit block multi-selection.

A document-level capturing pointer handler closes the inline toolbar for any pointerdown outside it. It removes all browser ranges, preventing selectionchange from immediately reopening the toolbar. Pointerdown inside the toolbar prevents selection loss so formatting commands continue to work. Escape closes both native text selection and block multi-selection.

## Decision Log

- Use native Selection rather than a parallel selection state.
- Keep no visible close button; outside click and Escape are faster and do not clutter the toolbar.
- Separate editor focus from batch block selection to prevent accidental-looking full-block highlights.
- Use a subtle hover surface and a more distinct multi-select treatment.

## Tests

- A collapsed selection and cross-block selection do not qualify for the inline toolbar.
- A non-empty same-editor selection qualifies.
- Clearing the browser selection removes the toolbar.
- Focusing a block does not add the multi-select class.
- Browser acceptance verifies toolbar appearance, outside-click dismissal, Escape dismissal, and no console errors.
