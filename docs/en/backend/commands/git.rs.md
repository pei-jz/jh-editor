# commands/git.rs — Git Integration Commands

Git operations via Tauri commands (~520 lines).

**Path**: `src-tauri/src/commands/git.rs`

## Commands

| Command | Description |
|---------|-------------|
| `git_status` | Branch, staged, modified, **deleted**, untracked |
| `git_add` / `git_unstage` | Stage/unstage |
| `git_commit` | Commit |
| `git_log` | Commit history |
| `git_diff` | Diff |
| `git_push` / `git_pull` / `git_fetch` | Remote ops |
| `git_discard` | Discard changes (restores deleted files) |
| `git_ignore` | Add to .gitignore |
| `git_init` | Initialize repo |
| `find_git_repos` | Find multiple repos |
| `git_diff_files` | List files changed between two revisions |
| `git_commit_files` | List files changed in a commit |
| `git_file_diff` | Diff a single file between revisions |

## Branch Logic

- `git_status`: Parse `git status --porcelain -b -uall` output. `M `/`A `/`D `→staged, ` M`→modified, ` D`→**deleted**, `??`→untracked
  - `-uall` lists every file inside untracked directories individually so the Git panel can expand folders
- The `GitStatus` struct now has a `deleted` field explicitly carrying worktree-deleted files