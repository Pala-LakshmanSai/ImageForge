#[cfg(windows)]
fn build_windows_trusted_input_hook() {
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let source = manifest_dir.join("native/trusted_input_hook.c");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("build output dir"));
    let dll = out_dir.join("imageforge-trusted-input-hook.dll");
    let target = env::var("TARGET").expect("target triple");

    let mut compiler = cc::Build::new();
    compiler.file(&source).target(&target).opt_level(2);
    let mut command = compiler.get_compiler().to_command();
    command
        .arg("/nologo")
        .arg("/LD")
        .arg("/O2")
        .arg("/MT")
        .arg(format!("/Fe:{}", dll.display()))
        .arg(&source)
        .arg("user32.lib");
    let status = command
        .status()
        .expect("compile Windows trusted-input hook DLL");
    assert!(
        status.success(),
        "Windows trusted-input hook DLL compiler exited with {status}"
    );

    let generated_dir = manifest_dir.join("native/generated");
    fs::create_dir_all(&generated_dir).expect("create generated native directory");
    fs::copy(
        &dll,
        generated_dir.join("imageforge-trusted-input-hook.dll"),
    )
    .expect("copy Windows trusted-input hook DLL");
    println!("cargo:rerun-if-changed={}", source.display());
}

#[cfg(not(windows))]
fn build_windows_trusted_input_hook() {}

fn main() {
    build_windows_trusted_input_hook();
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "gpu-selector-perf",
        tauri_build::InlinedPlugin::new().commands(&["arm", "commit"]),
    ))
    .expect("Tauri GPU selector capability manifest must build")
}
