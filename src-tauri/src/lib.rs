mod models;
mod commands;

use tauri::Manager;
use crate::commands::lsp::{LspState, start_lsp, stop_lsp, lsp_did_open, lsp_did_change, lsp_did_close, lsp_request};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single process for the whole app. A second launch is forwarded here and
        // routed to the right window in-process (focus the workspace that owns the
        // file, else open a new window).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let target = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or_default();
            commands::window::route_open_in_process(app, &target);
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_dir,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::write_file_bytes,
            commands::fs::diff_directories,
            commands::fs::parse_excel_to_markdown,
            commands::search::search_files,
            commands::search::list_all_files,
            commands::search::start_grep,
            commands::fs::create_dir,
            commands::fs::remove_file,
            commands::fs::rename_file,
            commands::fs::copy_file_cmd,
            commands::fs::exists,
            commands::fs::read_file_auto_detect,
            commands::fs::read_file_with_encoding,
            commands::fs::paste_files,
            commands::fs::list_recursive,
            commands::app::get_launch_args,
            commands::app::path_is_dir,
            commands::app::reveal_in_file_manager,
            commands::window::create_app_window,
            commands::window::take_launch_path,
            commands::git::git_exec,
            commands::app::expand_env_path,
            commands::parser::parse_structured_data,
            commands::parser::get_node_children,
            commands::pty::spawn_pty,
            commands::pty::list_shells,
            commands::pty::stop_pty,
            commands::pty::write_to_pty,
            commands::pty::resize_pty,
            commands::fs::set_workspace_root,
            start_lsp,
            stop_lsp,
            lsp_did_open,
            lsp_did_change,
            lsp_did_close,
            lsp_request,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_add,
            commands::git::git_commit,
            commands::git::git_unstage,
            commands::git::git_log,
            commands::app::open_devtools,
            commands::fs::file_stats,
            commands::git::git_push,
            commands::git::git_upstream,
            commands::git::git_remote_url,
            commands::git::git_default_branch,
            commands::git::gh_available,
            commands::git::gh_pr_create,
            commands::git::git_pull,
            commands::git::git_fetch,
            commands::git::git_show,
            commands::git::git_commit_files,
            commands::git::git_diff_files,
            commands::git::git_file_diff,
            commands::git::git_discard,
            commands::git::git_ignore,
            commands::git::find_git_repos,
            commands::git::git_init,
            commands::large_file::large_file_open,
            commands::large_file::large_file_lines,
            commands::large_file::large_file_search,
            commands::large_file::large_file_close,
            commands::large_file::editable_open,
            commands::large_file::editable_window,
            commands::large_file::editable_replace,
            commands::large_file::editable_line_count,
            commands::large_file::editable_search,
            commands::large_file::editable_save,
            commands::large_file::editable_close,
        ])
        .manage(commands::pty::PtyState::default())
        .manage(commands::fs::WorkspaceState::default())
        .manage(LspState::default())
        .manage(commands::large_file::LargeFileState::default())
        .manage(commands::large_file::EditableState::default())
        .manage(commands::window::PendingLaunch::default())
        .on_window_event(|window, event| {
            // Tear down a window's terminal and workspace entry when it closes,
            // so its shell process doesn't linger for the life of the app.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label().to_string();
                let app = window.app_handle();
                if let Some(pty) = app.try_state::<commands::pty::PtyState>() {
                    commands::pty::stop_pty_for_label(&pty, &label);
                }
                if let Some(ws) = app.try_state::<commands::fs::WorkspaceState>() {
                    ws.roots.lock().unwrap().remove(&label);
                }
                if let Some(lsp) = app.try_state::<LspState>() {
                    let servers = lsp.servers.clone();
                    tauri::async_runtime::spawn(async move {
                        commands::lsp::stop_lsp_for_label(servers, &label).await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
