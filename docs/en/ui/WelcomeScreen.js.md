# WelcomeScreen.js — Welcome Screen

## Purpose
Startup screen for workspace selection and recent workspaces.

## File Info
- **Path**: `src/modules/ui/WelcomeScreen.js` (121 lines)

## Key Features

| Feature | Description |
|---------|-------------|
| Open folder | Native dialog folder selection |
| Recent workspaces | Display from localStorage |
| Workspace switch | Switch to selected workspace |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Workspace selected | Hide welcome screen |
| No recent workspaces | Hide recent section |
| Folder selection cancelled | No action |