# VirtualScroll.js — Virtual Scroll Engine

## Purpose
Efficiently renders large DOM lists using virtualization. Used by CsvEditor etc.

## File Info
- **Path**: `src/modules/utils/VirtualScroll.js` (3.6KB)

## Key Features

| Feature | Description |
|---------|-------------|
| Row virtualization | Off-screen rows not in DOM |
| Column virtualization | Off-screen columns hidden |
| Padding calculation | Dynamic top/bottom padding |
| Resize handling | Recalculate on container resize |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Total rows below threshold | Skip virtualization, render all |
| Scroll position change | Recalculate visible range |
| Column width change | Recalculate horizontal scroll |