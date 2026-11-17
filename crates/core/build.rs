// Build script for pt-core.
//
// macOS only: the prebuilt ONNX Runtime that `ort` links statically uses Objective-C
// `@available` checks (CoreML provider), which call `__isPlatformVersionAtLeast`. Debug builds
// pick that symbol up from Rust's compiler_builtins, but release builds with LTO drop it and the
// link fails. Link clang's own runtime library, which defines it, to every binary that uses
// pt-core.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_clang_runtime();
    }
}

fn link_clang_runtime() {
    let out = std::process::Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output()
        .or_else(|_| std::process::Command::new("clang").arg("-print-resource-dir").output());
    let dir = match out {
        Ok(o) if o.status.success() => {
            std::path::PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()).join("lib/darwin")
        }
        _ => {
            println!("cargo:warning=could not locate clang's resource dir; release link may fail");
            return;
        }
    };
    if !dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:warning=libclang_rt.osx.a not found in {}", dir.display());
        return;
    }
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
