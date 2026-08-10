fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    // Move temp_build to target/temp_build to avoid triggering tauri dev rebuild loop
    let temp_dir = std::path::Path::new(&manifest_dir).join("target").join("temp_build");
    
    // Ensure the directory exists
    if !temp_dir.exists() {
        let _ = std::fs::create_dir_all(&temp_dir);
    }

    // Only set if not already set or specifically needed for protobuf etc.
    // Actually, setting these here affects the build process environment.
    std::env::set_var("TMP", &temp_dir);
    std::env::set_var("TEMP", &temp_dir);
    
    tauri_build::build()
}
