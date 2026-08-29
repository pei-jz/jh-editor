# BaseView.js — Abstract Base Class

## Purpose
Defines the view interface contract as an abstract base class.

## File Info
- **Path**: `src/modules/views/BaseView.js` (41 lines)
- **Dependencies**: None

## Class: `BaseView`

## Methods

| Method | Description |
|--------|-------------|
| `constructor(container)` | Set container element |
| `render(content, file)` | Abstract. Throws if not overridden |
| `destroy()` | Optional cleanup (default no-op) |
| `focus()` | Optional focus (default no-op) |
| `getDiagnostics()` | Returns empty array by default |