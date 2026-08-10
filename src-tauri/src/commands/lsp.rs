use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// State for managing LSP server processes
pub struct LspState {
    pub servers: Arc<Mutex<HashMap<String, LspServer>>>,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub struct LspServer {
    process: Child,
    request_id: i64,
    pub pending_requests: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LspDiagnostic {
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub severity: u32, // 1=Error, 2=Warning, 3=Info, 4=Hint
    pub message: String,
    pub source: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LspDiagnosticsEvent {
    pub path: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Format an LSP JSON-RPC message with Content-Length header
fn format_lsp_message(content: &serde_json::Value) -> String {
    let body = serde_json::to_string(content).unwrap();
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body)
}

/// Read a single LSP JSON-RPC response from a reader
fn read_lsp_message(reader: &mut BufReader<impl Read>) -> Result<serde_json::Value, String> {
    // Read headers, skipping non-header lines (robustness)
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let bytes_read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            return Err("Stream closed".to_string());
        }
        
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            if content_length > 0 {
                break; // End of headers
            }
            continue; // Skip leading empty lines
        }
        
        if line_trimmed.starts_with("Content-Length:") {
            let len_str = line_trimmed["Content-Length:".len()..].trim();
            content_length = len_str.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
        }
    }

    if content_length == 0 {
        return Err("No Content-Length header found".to_string());
    }

    // Read body
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    let body_str = String::from_utf8(body).map_err(|e| e.to_string())?;
    serde_json::from_str(&body_str).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_lsp<R: Runtime>(
    webview: tauri::WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, LspState>,
    language: String,
    workspace_root: String,
) -> Result<String, String> {
    // Per-window key so each window runs its own server for a language, rooted
    // at that window's workspace (no cross-window diagnostics/completion mixing).
    let label = webview.label().to_string();
    let key = format!("{}::{}", label, language);

    let mut servers = state.servers.lock().await;

    // Stop this window's existing server for this language
    if let Some(mut server) = servers.remove(&key) {
        let _ = server.process.kill();
    }

    // Determine LSP server command based on language
    let (cmd, args): (String, Vec<String>) = match language.as_str() {
        "typescript" | "javascript" => {
            let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };
            (npx.to_string(), vec!["typescript-language-server".to_string(), "--stdio".to_string()])
        }
        "rust" => {
            ("rust-analyzer".to_string(), vec![])
        }
        "python" => {
            let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };
            (npx.to_string(), vec!["pyright-langserver".to_string(), "--stdio".to_string()])
        }
        _ => return Err(format!("Unsupported language for LSP: {}", language)),
    };

    // Start LSP server process
    let mut cmd_builder = if cfg!(target_os = "windows") && (cmd.ends_with(".cmd") || cmd.ends_with(".bat")) {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&cmd);
        c.args(&args);
        c
    } else {
        let mut c = Command::new(&cmd);
        c.args(&args);
        c
    };

    cmd_builder
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd_builder.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut process = cmd_builder
        .spawn()
        .map_err(|e| format!("Failed to start LSP server ({}): {}. Make sure '{}' is installed.", language, e, cmd))?;

    let pending_requests = Arc::new(Mutex::new(HashMap::new()));
    let pending_requests_clone = pending_requests.clone();

    // Send initialize request
    let init_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", workspace_root.replace('\\', "/").trim_start_matches('/')),
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": true
                    },
                    "synchronization": {
                        "didSave": true,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "dynamicRegistration": false
                    },
                    "completion": {
                        "completionItem": {
                            "snippetSupport": true
                        }
                    },
                    "definition": {
                        "dynamicRegistration": true
                    },
                    "hover": {
                        "contentFormat": ["markdown", "plaintext"]
                    }
                }
            },
            "workspaceFolders": [{
                "uri": format!("file:///{}", workspace_root.replace('\\', "/").trim_start_matches('/')),
                "name": "workspace"
            }]
        }
    });

    if let Some(stdin) = process.stdin.as_mut() {
        let msg = format_lsp_message(&init_request);
        stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }

    // Read initialize response
    if let Some(stdout) = process.stdout.take() {
        let mut reader = BufReader::new(stdout);
        match read_lsp_message(&mut reader) {
            Ok(response) => {
                log::info!("LSP Initialize response: {:?}", response);
                
                // Send initialized notification
                if let Some(stdin) = process.stdin.as_mut() {
                    let initialized = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "initialized",
                        "params": {}
                    });
                    let msg = format_lsp_message(&initialized);
                    stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
                    stdin.flush().map_err(|e| e.to_string())?;
                }

                // Spawn a background task to read all messages
                let app_clone = app.clone();
                let language_clone = language.clone();
                // Per-window event name so only THIS window receives its
                // diagnostics (Tauri v2 global `listen` ignores emit targeting).
                let diag_ev = format!("lsp-diagnostics::{}", label);
                std::thread::spawn(move || {
                    loop {
                        match read_lsp_message(&mut reader) {
                            Ok(msg) => {
                                // 1. Check for publishDiagnostics notification
                                if msg.get("method").and_then(|m| m.as_str()) == Some("textDocument/publishDiagnostics") {
                                    if let Some(params) = msg.get("params") {
                                        let uri = params.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                                        let path = uri.replace("file:///", "").replace("file://", "");
                                        
                                        let diagnostics: Vec<LspDiagnostic> = params.get("diagnostics")
                                            .and_then(|d| d.as_array())
                                            .map(|arr| {
                                                arr.iter().filter_map(|d| {
                                                    let range = d.get("range")?;
                                                    let start = range.get("start")?;
                                                    let end = range.get("end")?;
                                                    Some(LspDiagnostic {
                                                        path: path.clone(),
                                                        line: start.get("line")?.as_u64()? as u32,
                                                        character: start.get("character")?.as_u64()? as u32,
                                                        end_line: end.get("line")?.as_u64()? as u32,
                                                        end_character: end.get("character")?.as_u64()? as u32,
                                                        severity: d.get("severity").and_then(|s| s.as_u64()).unwrap_or(1) as u32,
                                                        message: d.get("message")?.as_str()?.to_string(),
                                                        source: d.get("source").and_then(|s| s.as_str()).unwrap_or(&language_clone).to_string(),
                                                    })
                                                }).collect()
                                            })
                                            .unwrap_or_default();

                                        let event = LspDiagnosticsEvent {
                                            path,
                                            diagnostics,
                                        };
                                        let _ = app_clone.emit(&diag_ev, event);
                                    }
                                }
                                // 2. Check if it's a response to a pending request
                                else if let Some(id) = msg.get("id").and_then(|id| id.as_i64()) {
                                    let mut pending = futures::executor::block_on(pending_requests_clone.lock());
                                    let pending: &mut HashMap<i64, tokio::sync::oneshot::Sender<serde_json::Value>> = &mut *pending;
                                    if let Some(tx) = pending.remove(&id) {
                                        let _ = tx.send(msg.clone());
                                    }
                                }
                            }
                            Err(_) => break, // Server process ended
                        }
                    }
                });
            }
            Err(e) => {
                let _ = process.kill();
                return Err(format!("LSP initialize failed: {}", e));
            }
        }
    }

    servers.insert(key.clone(), LspServer {
        process,
        request_id: 2,
        pending_requests,
    });

    Ok(format!("LSP server started for {}", language))
}

/// Kill all LSP servers belonging to a window (called when it closes) so their
/// child processes don't linger for the life of the app. Takes the shared map
/// Arc so it can run from a spawned async task in the window-close handler.
pub async fn stop_lsp_for_label(
    servers: Arc<Mutex<HashMap<String, LspServer>>>,
    label: &str,
) {
    let prefix = format!("{}::", label);
    let mut servers = servers.lock().await;
    let keys: Vec<String> = servers.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for k in keys {
        if let Some(mut server) = servers.remove(&k) {
            let _ = server.process.kill();
        }
    }
}

#[tauri::command]
pub async fn stop_lsp(
    webview: tauri::WebviewWindow,
    state: State<'_, LspState>,
    language: String,
) -> Result<(), String> {
    let key = format!("{}::{}", webview.label(), language);
    let mut servers = state.servers.lock().await;
    if let Some(mut server) = servers.remove(&key) {
        // Send shutdown request
        if let Some(stdin) = server.process.stdin.as_mut() {
            let shutdown = serde_json::json!({
                "jsonrpc": "2.0",
                "id": server.request_id,
                "method": "shutdown",
                "params": null
            });
            let msg = format_lsp_message(&shutdown);
            let _ = stdin.write_all(msg.as_bytes());
            let _ = stdin.flush();

            // Send exit notification
            let exit = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "exit",
                "params": null
            });
            let msg = format_lsp_message(&exit);
            let _ = stdin.write_all(msg.as_bytes());
            let _ = stdin.flush();
        }

        // Force kill after a timeout
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let _ = server.process.kill();
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_did_open(
    webview: tauri::WebviewWindow,
    state: State<'_, LspState>,
    language: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let key = format!("{}::{}", webview.label(), language);
    let mut servers = state.servers.lock().await;
    if let Some(server) = servers.get_mut(&key) {
        let uri = format!("file:///{}", path.replace('\\', "/").trim_start_matches('/'));
        let lang_id = match language.as_str() {
            "typescript" => if path.ends_with(".tsx") { "typescriptreact" } else { "typescript" },
            "javascript" => if path.ends_with(".jsx") { "javascriptreact" } else { "javascript" },
            "rust" => "rust",
            _ => &language,
        };

        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": lang_id,
                    "version": 1,
                    "text": content
                }
            }
        });

        if let Some(stdin) = server.process.stdin.as_mut() {
            let msg = format_lsp_message(&notification);
            stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_did_change(
    webview: tauri::WebviewWindow,
    state: State<'_, LspState>,
    language: String,
    path: String,
    content: String,
    version: i32,
) -> Result<(), String> {
    let key = format!("{}::{}", webview.label(), language);
    let mut servers = state.servers.lock().await;
    if let Some(server) = servers.get_mut(&key) {
        let uri = format!("file:///{}", path.replace('\\', "/").trim_start_matches('/'));

        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "version": version
                },
                "contentChanges": [{
                    "text": content
                }]
            }
        });

        if let Some(stdin) = server.process.stdin.as_mut() {
            let msg = format_lsp_message(&notification);
            stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_did_close(
    webview: tauri::WebviewWindow,
    state: State<'_, LspState>,
    language: String,
    path: String,
) -> Result<(), String> {
    let key = format!("{}::{}", webview.label(), language);
    let mut servers = state.servers.lock().await;
    if let Some(server) = servers.get_mut(&key) {
        let uri = format!("file:///{}", path.replace('\\', "/").trim_start_matches('/'));

        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didClose",
            "params": {
                "textDocument": {
                    "uri": uri
                }
            }
        });

        if let Some(stdin) = server.process.stdin.as_mut() {
            let msg = format_lsp_message(&notification);
            stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_request(
    webview: tauri::WebviewWindow,
    state: State<'_, LspState>,
    language: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let key = format!("{}::{}", webview.label(), language);
    let mut servers = state.servers.lock().await;
    let server = servers.get_mut(&key).ok_or_else(|| format!("LSP server for {} not started", language))?;
    
    let id = server.request_id;
    server.request_id += 1;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = server.pending_requests.lock().await;
        pending.insert(id, tx);
    }

    if let Some(stdin) = server.process.stdin.as_mut() {
        let msg = format_lsp_message(&request);
        stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }

    // Wait for response with 5s timeout
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(response)) => {
            if let Some(error) = response.get("error") {
                return Err(error.to_string());
            }
            Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
        }
        Ok(Err(_)) => Err("Request channel closed".to_string()),
        Err(_) => {
            // Cleanup pending request on timeout
            let mut pending = server.pending_requests.lock().await;
            pending.remove(&id);
            Err("LSP request timed out".to_string())
        }
    }
}
