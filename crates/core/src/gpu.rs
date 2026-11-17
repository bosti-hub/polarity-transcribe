//! Choosing a graphics processor for speech recognition.
//!
//! A dedicated graphics card is many times faster than the processor (on an RTX 5060 Ti about
//! 56 times real time against 3 times on eight processor cores). Graphics built into a laptop
//! processor (Radeon 680M/780M, Intel Arc) are reported at three to four times the speed of the
//! processor, but small ones are not: the two-core Radeon in a desktop Ryzen 7700 is no faster
//! than four processor threads.
//!
//! Chips whose name settles the question are in a small table ([`classify`]): clearly fast ones
//! are used, clearly slow ones are not. Every other chip (generic names such as "AMD Radeon(TM)
//! Graphics", Intel Iris Xe, entry-level and older graphics cards) races the processor once, on
//! the first chunk of the first transcription (see [`needs_check`] and [`record_check`]). The
//! faster one is remembered for that chip until the app is updated. On a Mac the graphics chip
//! is always the fast path.
//!
//! On Windows the Vulkan loader (`vulkan-1.dll`) comes with the graphics driver. A PC without
//! one (a virtual machine, a broken driver) must still be able to run the app on the
//! processor, so the loader is delay-loaded (see the build scripts of the app and the CLI) and
//! a failed load is turned into "no Vulkan devices" instead of a crash.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    /// Index among the graphics devices, as whisper.cpp counts them (`gpu_device`).
    pub index: i32,
    pub name: String,
    pub integrated: bool,
    /// Total memory in MiB (for integrated graphics: the shared memory it may use).
    pub memory_mib: u64,
}

/// Whether this build has a GPU backend at all.
pub const GPU_BUILD: bool = cfg!(any(feature = "vulkan", feature = "metal", feature = "cuda"));

/// The speech model and its working memory need about this much graphics memory.
const MIN_MEMORY_MIB: u64 = 2_000;

/// All graphics devices whisper.cpp can use, in its own order.
pub fn devices() -> Vec<GpuDevice> {
    if !GPU_BUILD {
        return Vec::new();
    }
    #[cfg(all(windows, feature = "vulkan"))]
    if !delay_load::vulkan_present() {
        return Vec::new();
    }
    use whisper_rs::whisper_rs_sys as sys;
    let mut out = Vec::new();
    // SAFETY: the ggml backend registry is a process-wide singleton that is safe to query; the
    // returned strings are owned by the registry and copied before use.
    unsafe {
        let n = sys::ggml_backend_dev_count();
        for i in 0..n {
            let dev = sys::ggml_backend_dev_get(i);
            if dev.is_null() {
                continue;
            }
            let ty = sys::ggml_backend_dev_type(dev);
            let integrated = ty == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU;
            if ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU && !integrated {
                continue;
            }
            let desc = sys::ggml_backend_dev_description(dev);
            let name = if desc.is_null() {
                String::from("GPU")
            } else {
                std::ffi::CStr::from_ptr(desc).to_string_lossy().trim().to_string()
            };
            let (mut free, mut total) = (0usize, 0usize);
            sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
            out.push(GpuDevice { index: out.len() as i32, name, integrated, memory_mib: (total / (1 << 20)) as u64 });
        }
    }
    out
}

/// The device to transcribe on, or `None` to use the processor.
pub fn pick() -> Option<GpuDevice> {
    if let Ok(v) = std::env::var("PT_GPU_DEVICE") {
        // Developer override: an index, or "cpu".
        let i: i32 = v.parse().ok()?;
        return devices().into_iter().find(|d| d.index == i);
    }
    let checks = load_checks();
    choose(devices(), |d| verdict(d, &checks))
}

/// Whether device `d` should be used: `None` while that is still to be found out by a race.
fn verdict(d: &GpuDevice, checks: &BTreeMap<String, Check>) -> Option<bool> {
    if cfg!(target_os = "macos") {
        return Some(true);
    }
    if let Some(check) = checks.get(&d.name).filter(|c| c.version == ENGINE_VERSION) {
        return Some(check.use_gpu);
    }
    match classify(d) {
        Class::Fast => Some(true),
        Class::Slow => Some(false),
        Class::Uncertain => None,
    }
}

/// What a chip's name says about its speed relative to the processor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Clearly faster than any processor it is paired with: use it without a check.
    Fast,
    /// Clearly not faster: use the processor without a check.
    Slow,
    /// Could go either way: race the processor once.
    Uncertain,
}

/// Classify a chip by its name. Only unmistakable names are listed; drivers report some chips
/// under generic names ("AMD Radeon(TM) Graphics" is a two-core desktop chip on one PC and a
/// Radeon 680M on another), and those stay uncertain.
pub fn classify(d: &GpuDevice) -> Class {
    let n = d.name.to_lowercase().replace("(r)", "").replace("(tm)", "");
    let has = |s: &str| n.contains(s);
    let any = |list: &[&str]| list.iter().any(|s| has(s));
    if d.integrated {
        // Laptop chips measured or reported at several times the processor's speed.
        const FAST: &[&str] = &[
            "radeon 660m", "radeon 680m", "radeon 760m", "radeon 780m", "radeon 860m", "radeon 880m", "radeon 890m",
            "radeon 8050s", "radeon 8060s", "arc graphics", "arc 130v", "arc 140v", "arc b370", "arc b390",
        ];
        // Older and entry-level integrated graphics.
        const SLOW: &[&str] = &[
            "uhd graphics", "hd graphics", "radeon 610m", "radeon vega 3", "radeon r2", "radeon r3", "radeon r4", "radeon r5",
            "radeon r6", "radeon r7",
        ];
        if any(FAST) {
            Class::Fast
        } else if any(SLOW) {
            Class::Slow
        } else {
            Class::Uncertain
        }
    } else {
        // Current and recent graphics cards. NVIDIA MX, GTX 9xx/10xx and older Radeon cards are
        // uncertain: some are no faster than a modern processor.
        const FAST: &[&str] = &[
            "geforce rtx", "nvidia rtx", "quadro rtx", "geforce gtx 16", "radeon rx 5", "radeon rx 6", "radeon rx 7",
            "radeon rx 9", "radeon pro w6", "radeon pro w7", "arc a3", "arc a5", "arc a7", "arc b5", "arc b7", "arc pro",
        ];
        if any(FAST) {
            Class::Fast
        } else {
            Class::Uncertain
        }
    }
}

/// `verdict(d)`: whether device `d` should be used, `None` if not known yet (it is then used,
/// subject to a race against the processor).
fn choose(devices: Vec<GpuDevice>, verdict: impl Fn(&GpuDevice) -> Option<bool>) -> Option<GpuDevice> {
    let usable = |d: &GpuDevice| {
        let memory = d.memory_mib == 0 || d.memory_mib >= MIN_MEMORY_MIB || d.integrated;
        memory && verdict(d) != Some(false)
    };
    let best_dedicated = devices.iter().filter(|d| !d.integrated && usable(d)).max_by_key(|d| d.memory_mib).cloned();
    best_dedicated.or_else(|| devices.into_iter().find(|d| d.integrated && usable(d)))
}

// ------------------------------------------------------------------ race against the processor

/// One race between a graphics device and the processor on the same audio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub gpu_seconds: f64,
    pub cpu_seconds: f64,
    pub cpu_threads: usize,
    pub use_gpu: bool,
    /// The app version that raced: a new version (and with it a new recogniser) races again.
    #[serde(default)]
    pub version: String,
}

const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The graphics device is kept unless the processor is clearly faster: at equal speed the
/// graphics chip is the better choice, because it leaves the processor free for other work.
const CPU_MARGIN: f64 = 0.85;

static CHECK_FILE: OnceLock<PathBuf> = OnceLock::new();
static CHECKS: Mutex<Option<BTreeMap<String, Check>>> = Mutex::new(None);

/// Where race results are remembered (a JSON file). Without it, every run races again.
pub fn set_check_file(path: PathBuf) {
    let _ = CHECK_FILE.set(path);
}

fn load_checks() -> BTreeMap<String, Check> {
    let mut cache = CHECKS.lock().unwrap();
    if cache.is_none() {
        let read = CHECK_FILE.get().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok());
        *cache = Some(read.unwrap_or_default());
    }
    cache.clone().unwrap()
}

/// Whether `device` must first race the processor: a chip of uncertain speed that has not raced
/// in this version of the app.
pub fn needs_check(device: &GpuDevice) -> bool {
    std::env::var_os("PT_GPU_DEVICE").is_none() && verdict(device, &load_checks()).is_none()
}

/// Remember the outcome of a race and say whether the graphics device won.
pub fn record_check(device: &GpuDevice, gpu_seconds: f64, cpu_seconds: f64, cpu_threads: usize) -> bool {
    let use_gpu = cpu_seconds >= CPU_MARGIN * gpu_seconds;
    let mut checks = load_checks();
    checks.insert(device.name.clone(), Check { gpu_seconds, cpu_seconds, cpu_threads, use_gpu, version: ENGINE_VERSION.into() });
    if let Some(path) = CHECK_FILE.get() {
        if let Ok(json) = serde_json::to_vec_pretty(&checks) {
            let _ = crate::fsutil::write_atomic(path, &json);
        }
    }
    *CHECKS.lock().unwrap() = Some(checks);
    use_gpu
}

#[cfg(all(windows, feature = "vulkan"))]
mod delay_load {
    //! Survive a missing `vulkan-1.dll`.
    //!
    //! The executable imports the Vulkan loader lazily (`/DELAYLOAD:vulkan-1.dll`). If the
    //! loader cannot be found when ggml first calls into it, the delay-load helper asks this
    //! hook what to do. The hook supplies a stand-in `vkGetInstanceProcAddr` that reports
    //! Vulkan 1.0; ggml requires 1.2, so it cleanly concludes that there is no usable device.
    use std::ffi::{c_char, c_void, CStr};

    #[repr(C)]
    struct DelayLoadProc {
        import_by_name: i32,
        name: *const c_char,
    }
    #[repr(C)]
    struct DelayLoadInfo {
        cb: u32,
        pidd: *const c_void,
        ppfn: *mut *mut c_void,
        dll: *const c_char,
        dlp: DelayLoadProc,
        hmod: *mut c_void,
        pfn: *mut c_void,
        last_error: u32,
    }
    type Hook = unsafe extern "system" fn(u32, *const DelayLoadInfo) -> *mut c_void;

    const FAIL_LOAD_LIB: u32 = 3;
    const FAIL_GET_PROC: u32 = 4;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
    }

    unsafe extern "system" fn enumerate_instance_version(version: *mut u32) -> i32 {
        *version = 1 << 22; // Vulkan 1.0.0
        0 // VK_SUCCESS
    }

    unsafe extern "system" fn get_instance_proc_addr(_instance: *mut c_void, name: *const c_char) -> *mut c_void {
        if !name.is_null() && CStr::from_ptr(name).to_bytes() == b"vkEnumerateInstanceVersion" {
            enumerate_instance_version as *mut c_void
        } else {
            std::ptr::null_mut()
        }
    }

    unsafe extern "system" fn hook(notify: u32, info: *const DelayLoadInfo) -> *mut c_void {
        let Some(info) = info.as_ref() else { return std::ptr::null_mut() };
        let is_vulkan = !info.dll.is_null() && CStr::from_ptr(info.dll).to_bytes().eq_ignore_ascii_case(b"vulkan-1.dll");
        if !is_vulkan {
            return std::ptr::null_mut();
        }
        match notify {
            // Hand back our own module; looking up the Vulkan function in it then fails, and
            // that failure is answered below.
            FAIL_LOAD_LIB => GetModuleHandleW(std::ptr::null()),
            FAIL_GET_PROC => {
                let wanted = info.dlp.import_by_name != 0
                    && !info.dlp.name.is_null()
                    && CStr::from_ptr(info.dlp.name).to_bytes() == b"vkGetInstanceProcAddr";
                if wanted {
                    get_instance_proc_addr as *mut c_void
                } else {
                    std::ptr::null_mut()
                }
            }
            _ => std::ptr::null_mut(),
        }
    }

    /// Read by the delay-load helper (delayimp.lib) when a delay-loaded import fails.
    #[no_mangle]
    #[used]
    static __pfnDliFailureHook2: Option<Hook> = Some(hook);

    /// Whether the Vulkan loader can be loaded. Also keeps the hook above in the final binary.
    pub fn vulkan_present() -> bool {
        // SAFETY: reading a static and calling LoadLibraryW with a valid, NUL-terminated name.
        unsafe {
            std::hint::black_box(std::ptr::read_volatile(&__pfnDliFailureHook2));
            let name: Vec<u16> = "vulkan-1.dll\0".encode_utf16().collect();
            !LoadLibraryW(name.as_ptr()).is_null()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(index: i32, integrated: bool, memory_mib: u64) -> GpuDevice {
        GpuDevice { index, name: format!("gpu{index}"), integrated, memory_mib }
    }

    #[test]
    fn a_dedicated_card_beats_integrated_graphics() {
        let picked = choose(vec![dev(0, true, 16_000), dev(1, false, 8_000)], |_| None).unwrap();
        assert_eq!(picked.index, 1);
    }

    #[test]
    fn integrated_graphics_are_used_unless_the_processor_won_the_race() {
        assert_eq!(choose(vec![dev(0, true, 16_000)], |_| None).unwrap().index, 0);
        assert_eq!(choose(vec![dev(0, true, 16_000)], |_| Some(true)).unwrap().index, 0);
        assert!(choose(vec![dev(0, true, 16_000)], |_| Some(false)).is_none());
    }

    #[test]
    fn a_card_with_too_little_memory_is_skipped() {
        assert!(choose(vec![dev(0, false, 1_024)], |_| None).is_none());
    }

    fn named(name: &str, integrated: bool) -> GpuDevice {
        GpuDevice { index: 0, name: name.into(), integrated, memory_mib: 8_000 }
    }

    #[test]
    fn known_chips_need_no_race() {
        // Names as Windows Vulkan drivers report them.
        assert_eq!(classify(&named("NVIDIA GeForce RTX 5060 Ti", false)), Class::Fast);
        assert_eq!(classify(&named("NVIDIA GeForce RTX 4060 Laptop GPU", false)), Class::Fast);
        assert_eq!(classify(&named("AMD Radeon RX 7600", false)), Class::Fast);
        assert_eq!(classify(&named("Intel(R) Arc(TM) A770 Graphics", false)), Class::Fast);
        assert_eq!(classify(&named("AMD Radeon 780M Graphics", true)), Class::Fast);
        assert_eq!(classify(&named("Intel(R) Arc(TM) Graphics", true)), Class::Fast);
        assert_eq!(classify(&named("Intel(R) Arc(TM) 140V GPU (16GB)", true)), Class::Fast);
        assert_eq!(classify(&named("Intel(R) UHD Graphics 620", true)), Class::Slow);
        assert_eq!(classify(&named("Intel(R) HD Graphics 530", true)), Class::Slow);
    }

    #[test]
    fn ambiguous_chips_race_the_processor() {
        assert_eq!(classify(&named("AMD Radeon(TM) Graphics", true)), Class::Uncertain);
        assert_eq!(classify(&named("Intel(R) Iris(R) Xe Graphics", true)), Class::Uncertain);
        assert_eq!(classify(&named("AMD Radeon(TM) RX Vega 11 Graphics", true)), Class::Uncertain);
        assert_eq!(classify(&named("NVIDIA GeForce MX450", false)), Class::Uncertain);
        assert_eq!(classify(&named("NVIDIA GeForce GTX 1050", false)), Class::Uncertain);
    }

    #[test]
    fn the_processor_must_be_clearly_faster_to_win() {
        let d = dev(0, true, 8_000);
        assert!(record_check(&d, 10.0, 9.0, 8)); // 10% faster: keep the graphics chip
        assert!(!record_check(&d, 10.0, 8.0, 8)); // 20% faster: use the processor
    }
}
