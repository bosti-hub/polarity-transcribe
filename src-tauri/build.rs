fn main() {
    // See pt_core::gpu: load the Vulkan loader lazily so the app also starts without it.
    if std::env::var_os("CARGO_FEATURE_VULKAN").is_some() && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:vulkan-1.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }
    tauri_build::build()
}
