# Drag-to-Columns Design

## Understanding

- Fix undo snapshots, page hierarchy cycles, unsafe imports, recursive permanent deletion, sidebar collapse, and keyboard focus visibility.
- Dragging a block to the left or right edge of another block creates a two-column layout.
- Dragging at the edge of an existing layout can add a column up to four columns.
- At four columns, an edge drop appends the block to the outermost column.
- Blocks can still be reordered vertically and moved back to the page root.
- Keep the local-only, dependency-free browser architecture.
- Imported workspace data is untrusted and must be normalized before rendering.

## Assumptions

- Column drops move blocks rather than copy them.
- The existing `columns` and `column` block types remain the persisted representation.
- Left and right edge hit zones are used only for column operations; vertical hit zones retain existing behavior.
- Empty columns remain valid and editable.
- The expected scale is one local workspace with thousands of pages and blocks.

## Design

Store owns all structural invariants. Page moves reject self and descendant targets regardless of the UI entry point. Permanent deletion traverses all children, including trashed children. Imported data is rebuilt from a whitelist of supported page, block, rich-text, property, reminder, version, and template fields.

Block column operations also live in Store. A side drop removes the source block, locates the target after removal, then either creates a new `columns` container, inserts a new column beside the target column, or appends to the outermost column when the four-column limit is reached. Moving a block out of columns uses the existing root drop path and removes empty structural wrappers when appropriate.

The editor computes horizontal edge zones during dragover. It renders a vertical drop indicator for left/right column drops and keeps the current horizontal indicator for before/after/inside drops. Multi-select side drops are not introduced in this iteration.

## Testing

- Add regression checks for first undo, cycle rejection, recursive permanent deletion, and import normalization.
- Add pure Store checks for creating two columns, adding columns, enforcing the four-column cap, and moving blocks back to root.
- Run all smoke tests and JavaScript syntax checks.
- Verify the interaction in a real browser at desktop and mobile widths, including visible keyboard focus.

## Decision Log

- Reuse the existing columns model instead of introducing a second layout representation.
- Put hierarchy and movement validation in Store so all UI paths share it.
- Normalize imported backups with allowlists rather than trusting serialized objects.
- Cap layouts at four columns; further edge drops append to the outermost column.
- Treat side drops as moves, not copies.
