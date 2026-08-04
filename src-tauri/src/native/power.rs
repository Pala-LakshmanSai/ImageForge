use super::{NativeError, NativeResult};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// The renderer can only observe this small, platform-neutral projection. It
/// cannot hold or construct an OS assertion handle itself.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePowerState {
    pub run_revision: Option<String>,
    pub active: bool,
    pub platform: &'static str,
    pub display_sleep_allowed: bool,
}

#[derive(Clone)]
pub struct PowerController {
    inner: Arc<Mutex<PowerInner>>,
}

struct PowerInner {
    run_revision: Option<Uuid>,
    handle: Option<PlatformAssertion>,
}

impl PowerController {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(PowerInner {
                run_revision: None,
                handle: None,
            })),
        }
    }

    /// Acquire the scoped no-idle-sleep assertion. Repeated acquire for the
    /// same run is deliberately idempotent; switching runs always releases the
    /// old assertion before attempting a new one.
    pub fn set_enabled(&self, run_revision: Uuid, enabled: bool) -> NativeResult<NativePowerState> {
        let mut inner = self.inner.lock().map_err(|_| power_unavailable())?;
        if !enabled {
            inner.release();
            return Ok(power_state(&inner));
        }

        if inner.run_revision == Some(run_revision) && inner.handle.is_some() {
            return Ok(power_state(&inner));
        }

        inner.release();
        let assertion = PlatformAssertion::acquire()?;
        inner.run_revision = Some(run_revision);
        inner.handle = Some(assertion);
        Ok(power_state(&inner))
    }

    pub fn release_for_run(&self, run_revision: Uuid) -> NativePowerState {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return NativePowerState {
                    run_revision: None,
                    active: false,
                    platform: platform_name(),
                    display_sleep_allowed: true,
                }
            }
        };
        if inner.run_revision == Some(run_revision) {
            inner.release();
        }
        power_state(&inner)
    }

    /// Force cleanup when the owning queue journal is intentionally
    /// quarantined.  This is deliberately not exposed to the renderer: a
    /// normal release remains bound to the run lease, while destructive local
    /// recovery must never leave an assertion alive after its runner state is
    /// gone.
    pub fn release_all(&self) -> NativePowerState {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return NativePowerState {
                    run_revision: None,
                    active: false,
                    platform: platform_name(),
                    display_sleep_allowed: true,
                }
            }
        };
        inner.release();
        power_state(&inner)
    }

    #[cfg(test)]
    pub(crate) fn active_for_test(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.handle.is_some())
            .unwrap_or(false)
    }
}

impl Default for PowerController {
    fn default() -> Self {
        Self::new()
    }
}

impl PowerInner {
    fn release(&mut self) {
        // Dropping the platform assertion performs the only OS cleanup. This
        // is called from disable, runner release, state replacement, and the
        // final Arc drop at process exit.
        self.handle.take();
        self.run_revision = None;
    }
}

fn power_state(inner: &PowerInner) -> NativePowerState {
    NativePowerState {
        run_revision: inner.run_revision.map(|value| value.to_string()),
        active: inner.handle.is_some(),
        platform: platform_name(),
        // Neither platform assertion asks the OS to keep the display awake.
        display_sleep_allowed: true,
    }
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unsupported"
    }
}

enum PlatformAssertion {
    #[cfg(target_os = "macos")]
    MacOs { assertion_id: u32 },
    #[cfg(target_os = "windows")]
    Windows { handle: isize },
}

impl PlatformAssertion {
    fn acquire() -> NativeResult<Self> {
        #[cfg(target_os = "macos")]
        {
            return macos::acquire().map(|assertion_id| Self::MacOs { assertion_id });
        }
        #[cfg(target_os = "windows")]
        {
            return windows::acquire().map(|handle| Self::Windows { handle });
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(NativeError::new(
                "platform_unsupported",
                "Keep-awake is available in the macOS and Windows apps.",
            ))
        }
    }
}

impl Drop for PlatformAssertion {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let Self::MacOs { assertion_id } = self;
            macos::release(*assertion_id);
        }
        #[cfg(target_os = "windows")]
        {
            let Self::Windows { handle } = self;
            windows::release(*handle);
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{NativeError, NativeResult};
    use std::ffi::c_void;

    type CFStringRef = *const c_void;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    // `kIOPMAssertPreventUserIdleSystemSleep` is a C `CFSTR` macro, not an
    // exported IOKit symbol. Keep its documented literal here and create the
    // CFString locally so the Rust FFI never tries to link a nonexistent
    // `_kIOPMAssertionTypeNoIdleSleep` global. This assertion blocks only
    // idle system sleep; the display may still sleep.
    const PREVENT_USER_IDLE_SYSTEM_SLEEP: &[u8] = b"PreventUserIdleSystemSleep\0";
    const ASSERTION_NAME: &[u8] = b"ImageForge queue run\0";

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const i8,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    fn create_cf_string(bytes: &'static [u8]) -> CFStringRef {
        // Both literals above include their required trailing NUL and contain
        // no renderer-supplied data.
        unsafe {
            CFStringCreateWithCString(
                std::ptr::null(),
                bytes.as_ptr().cast(),
                K_CF_STRING_ENCODING_UTF8,
            )
        }
    }

    pub(super) fn acquire() -> NativeResult<u32> {
        let assertion_type = create_cf_string(PREVENT_USER_IDLE_SYSTEM_SLEEP);
        let name = create_cf_string(ASSERTION_NAME);
        if assertion_type.is_null() || name.is_null() {
            if !assertion_type.is_null() {
                unsafe { CFRelease(assertion_type) };
            }
            if !name.is_null() {
                unsafe { CFRelease(name) };
            }
            return Err(NativeError::new(
                "queue_power_unavailable",
                "ImageForge could not enable keep-awake.",
            ));
        }
        let mut assertion_id = 0_u32;
        let result = unsafe {
            IOPMAssertionCreateWithName(
                assertion_type,
                K_IOPM_ASSERTION_LEVEL_ON,
                name,
                &mut assertion_id,
            )
        };
        unsafe { CFRelease(name) };
        unsafe { CFRelease(assertion_type) };
        if result != 0 || assertion_id == 0 {
            return Err(NativeError::new(
                "queue_power_unavailable",
                "ImageForge could not enable keep-awake.",
            ));
        }
        Ok(assertion_id)
    }

    pub(super) fn release(assertion_id: u32) {
        // Cleanup is best-effort at Drop time; a process exit also releases
        // IOPM assertions owned by that process.
        let _ = unsafe { IOPMAssertionRelease(assertion_id) };
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{NativeError, NativeResult};
    use std::ffi::c_void;

    type Handle = isize;
    const INVALID_HANDLE_VALUE: Handle = -1;
    const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;
    const POWER_REQUEST_CONTEXT_SIMPLE_STRING: u32 = 0x0000_0001;
    const POWER_REQUEST_SYSTEM_REQUIRED: u32 = 0;

    #[repr(C)]
    union ReasonContextUnion {
        simple_reason_string: *mut u16,
        detailed: *mut c_void,
    }

    #[repr(C)]
    struct ReasonContext {
        version: u32,
        flags: u32,
        reason: ReasonContextUnion,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn PowerCreateRequest(context: *const ReasonContext) -> Handle;
        fn PowerSetRequest(handle: Handle, request_type: u32) -> i32;
        fn PowerClearRequest(handle: Handle, request_type: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(super) fn acquire() -> NativeResult<Handle> {
        let mut reason = "ImageForge queue run"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let context = ReasonContext {
            version: POWER_REQUEST_CONTEXT_VERSION,
            flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            reason: ReasonContextUnion {
                simple_reason_string: reason.as_mut_ptr(),
            },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            return Err(NativeError::new(
                "queue_power_unavailable",
                "ImageForge could not enable keep-awake.",
            ));
        }
        if unsafe { PowerSetRequest(handle, POWER_REQUEST_SYSTEM_REQUIRED) } == 0 {
            let _ = unsafe { CloseHandle(handle) };
            return Err(NativeError::new(
                "queue_power_unavailable",
                "ImageForge could not enable keep-awake.",
            ));
        }
        Ok(handle)
    }

    pub(super) fn release(handle: Handle) {
        let _ = unsafe { PowerClearRequest(handle, POWER_REQUEST_SYSTEM_REQUIRED) };
        let _ = unsafe { CloseHandle(handle) };
    }
}

fn power_unavailable() -> NativeError {
    NativeError::new(
        "queue_power_unavailable",
        "ImageForge could not update keep-awake.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_projection_never_claims_display_sleep_is_blocked() {
        let controller = PowerController::new();
        let state = controller.release_for_run(Uuid::new_v4());
        assert!(!state.active);
        assert!(state.display_sleep_allowed);
    }

    #[test]
    fn disabling_is_idempotent_without_an_assertion() {
        let controller = PowerController::new();
        let run = Uuid::new_v4();
        let first = controller.release_for_run(run);
        let second = controller.release_for_run(run);
        assert_eq!(first, second);
        assert!(!controller.active_for_test());
    }

    #[test]
    fn destructive_recovery_release_all_is_idempotent() {
        let controller = PowerController::new();
        let first = controller.release_all();
        let second = controller.release_all();
        assert_eq!(first, second);
        assert!(!controller.active_for_test());
    }
}
