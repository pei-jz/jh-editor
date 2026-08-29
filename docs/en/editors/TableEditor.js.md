# TableEditor.js — Markdown Table Visual Editor

## Purpose
`TableEditor` is a singleton object providing Markdown table detection, parsing, serialization, and interactive visual editing.

## File Info
- **Path**: `src/modules/editors/TableEditor.js` (466 lines)
- **Dependencies**: None (standalone)

## Export

### `TableEditor` Singleton Object

## Methods

### `isSeparatorLine(line: string): boolean`
Checks if a line is a Markdown table separator row.

### `isTable(text: string): boolean`
Checks if text is a Markdown table.

**Branch Logic**:
1. Less than 2 lines → `false`
2. Line 2 is separator → `true`
3. No separator: checks if all lines contain pipe `|`

### `parse(text: string): Array<Array<string>>`
Converts Markdown string to 2D array. Skips separator row, strips leading/trailing pipes.

### `serialize(data: Array<Array<string>>): string`
Converts 2D array to Markdown table string with auto-calculated column widths.

### `focusCell(container, row, col, editMode?: boolean): void`
Focuses specified cell. If `editMode`, shows and focuses input field.

### `render(container, data, onChange): void`
Renders interactive table UI.

**Keyboard Operations**:
| Key | Action |
|-----|--------|
| Arrow keys | Cell navigation |
| `Shift+Arrow` | Range selection |
| `Alt+;` | Add row |
| `Alt+Shift+;` | Add column |
| `Alt+-` | Delete row |
| `Alt+Shift+-` | Delete column |
| `Ctrl+Space` | Row selection |
| `Tab` | Move right (wraps to next row, adds new row at end) |
| `Shift+Tab` | Move left |
| `Enter` | Move down |
| `F2` | Toggle edit mode |
| Any character | Enter edit mode and type |

### `selectRow(container, rowIndex): void`
Toggles row selection (`selected-row` class toggle).