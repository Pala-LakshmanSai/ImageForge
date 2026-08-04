fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "gpu-selector-perf",
        tauri_build::InlinedPlugin::new().commands(&["arm", "commit"]),
    ))
    .expect("Tauri GPU selector capability manifest must build")
}
