// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by git to ask for a password: answer it and exit, before
    // anything else (the single-instance plugin above all) runs.
    app_lib::askpass::run_client_if_requested();
    app_lib::run();
}
