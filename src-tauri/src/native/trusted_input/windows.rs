//! Windows trusted input authority.
//!
//! WebView2's accelerator event and thread-scoped Win32 mouse hooks are the
//! only inputs that can create a broker activation. Renderer events are never
//! consulted. The host thread hook covers native-window messages; the
//! packaged helper DLL installs the same thread-scoped `WH_MOUSE` hook in the
//! WebView2 browser UI thread and posts only a native message back to this
//! host. All authorization and broker work remains on the host thread.

use super::{TrustedActivationKind, TrustedInputBroker};
use crate::native::gpu_selector_perf::{GpuSelectorPerfHost, NativeSelectorInputKind};
use ::windows::core::Interface;
use ::windows::Win32::Foundation::HWND;
use std::cell::RefCell;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, FreeLibrary, HANDLE, HINSTANCE, HMODULE, INVALID_HANDLE_VALUE, LPARAM, LRESULT,
    POINT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CallWindowProcW, GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetParent,
    GetWindow, GetWindowThreadProcessId, IsChild, IsIconic, IsWindow, IsWindowEnabled,
    IsWindowVisible, SetWindowLongPtrW, SetWindowsHookExW, UnhookWindowsHookEx, GA_ROOT,
    GA_ROOTOWNER, GUITHREADINFO, GWLP_WNDPROC, GW_CHILD, GW_HWNDNEXT, HC_ACTION, MOUSEHOOKSTRUCT,
    WH_MOUSE, WM_APP, WM_LBUTTONUP, WNDPROC,
};

const VK_RETURN: u32 = 0x0D;
const VK_SPACE: u32 = 0x20;
const VK_UP: u32 = 0x26;
const VK_DOWN: u32 = 0x28;
const TRUSTED_INPUT_MESSAGE: u32 = WM_APP + 0x4f;
const TRUSTED_INPUT_MAGIC: u32 = 0x4946_4754;
const TRUSTED_INPUT_VERSION: u32 = 1;
const TRUSTED_INPUT_HOOK_DLL: &str = "imageforge-trusted-input-hook.dll";

#[repr(C)]
struct HookConfig {
    magic: u32,
    version: u32,
    receiver_hwnd: usize,
    expected_hwnd: usize,
    active: i32,
}

#[derive(Clone)]
pub(crate) struct NativeInputHook {
    active: Arc<AtomicBool>,
    destroyed: Arc<AtomicBool>,
    registration: Arc<Mutex<Option<Registration>>>,
    window: WebviewWindow,
}

struct Registration {
    // COM interfaces are apartment/thread-affine and are not `Send`. Keep
    // the owned reference as an address in the cross-thread state; it is
    // reconstructed and released only by `remove_on_main_thread`.
    controller: usize,
    accelerator_token: i64,
    host_mouse_hook: usize,
    browser_mouse_hook: usize,
    hook_module: usize,
    mapping: usize,
    mapping_view: usize,
    original_window_proc: isize,
    host_hwnd: usize,
    host_thread_id: u32,
}

struct MouseHookContext {
    active: Arc<AtomicBool>,
    expected_hwnd: usize,
    expected_controller_hwnd: usize,
    host_thread_id: u32,
    browser_thread_id: u32,
    window_label: String,
    broker: TrustedInputBroker,
    selector_perf: GpuSelectorPerfHost,
    window: WebviewWindow,
    last_pointer_up: Mutex<Option<(Instant, i32, i32)>>,
}

struct HostWindowState {
    hwnd: usize,
    context: Arc<MouseHookContext>,
    original_window_proc: isize,
}

thread_local! {
    static MOUSE_HOOK_CONTEXT: RefCell<Option<Arc<MouseHookContext>>> = const { RefCell::new(None) };
}

static HOST_WINDOW_STATE: OnceLock<Mutex<Option<HostWindowState>>> = OnceLock::new();

fn host_window_state() -> &'static Mutex<Option<HostWindowState>> {
    HOST_WINDOW_STATE.get_or_init(|| Mutex::new(None))
}

impl NativeInputHook {
    pub(crate) fn invalidate(&self) {
        self.active.store(false, Ordering::Release);
        if let Ok(registration) = self.registration.lock() {
            if let Some(registration) = registration.as_ref() {
                set_mapping_active(registration.mapping_view as *mut HookConfig, false);
            }
        }
    }

    pub(crate) fn activate(&self) {
        if self.destroyed.load(Ordering::Acquire) {
            return;
        }
        let registered = self
            .registration
            .lock()
            .map(|registration| registration.is_some())
            .unwrap_or(false);
        if registered {
            self.active.store(true, Ordering::Release);
            if let Ok(registration) = self.registration.lock() {
                if let Some(registration) = registration.as_ref() {
                    set_mapping_active(registration.mapping_view as *mut HookConfig, true);
                }
            }
        }
    }

    pub(crate) fn remove_on_main_thread(&self) {
        self.destroyed.store(true, Ordering::Release);
        self.invalidate();
        let Ok(mut slot) = self.registration.lock() else {
            return;
        };

        // Tauri delivers Destroyed on the window thread. If that invariant is
        // ever violated, retain the registration and queue a retry instead of
        // dropping thread-affine resources on the wrong thread.
        let Some(registration_thread_id) = slot
            .as_ref()
            .map(|registration| registration.host_thread_id)
        else {
            return;
        };
        if unsafe { GetCurrentThreadId() } != registration_thread_id {
            drop(slot);
            let hook = self.clone();
            let window = self.window.clone();
            let _ = window.run_on_main_thread(move || hook.remove_on_main_thread());
            return;
        }
        let Some(registration) = slot.take() else {
            return;
        };

        unsafe {
            if registration.original_window_proc != 0 {
                let _ = SetWindowLongPtrW(
                    registration.host_hwnd as _,
                    GWLP_WNDPROC,
                    registration.original_window_proc,
                );
            }
        }
        clear_host_window_state(registration.host_hwnd);
        MOUSE_HOOK_CONTEXT.with(|context| {
            *context.borrow_mut() = None;
        });
        unsafe {
            let controller =
                ICoreWebView2Controller::from_raw(registration.controller as *mut std::ffi::c_void);
            let _ = controller.remove_AcceleratorKeyPressed(registration.accelerator_token);
            let _ = UnhookWindowsHookEx(registration.host_mouse_hook as _);
            let _ = UnhookWindowsHookEx(registration.browser_mouse_hook as _);
            let _ = FreeLibrary(registration.hook_module as _);
            close_hook_mapping(registration.mapping as _, registration.mapping_view as _);
        }
    }
}

pub(crate) fn install(
    window: &WebviewWindow,
    broker: TrustedInputBroker,
    selector_perf: GpuSelectorPerfHost,
) -> tauri::Result<NativeInputHook> {
    let hwnd = window.hwnd()?;
    let expected_hwnd = hwnd.0 as usize;
    selector_perf.trace_qa(&format!(
        "windows native input setup started hwnd={expected_hwnd}"
    ));
    let active = Arc::new(AtomicBool::new(false));
    let destroyed = Arc::new(AtomicBool::new(false));
    let registration = Arc::new(Mutex::new(None));
    let resource_dir = window.app_handle().path().resource_dir().ok();

    let active_for_setup = active.clone();
    let destroyed_for_setup = destroyed.clone();
    let registration_for_setup = registration.clone();
    let broker_for_hook = broker.clone();
    let selector_for_hook = selector_perf.clone();
    let window_for_hook = window.clone();
    let window_label = window.label().to_owned();

    window.with_webview(move |webview| {
        if destroyed_for_setup.load(Ordering::Acquire) {
            return;
        }

        // `with_webview` executes on Tauri's UI thread. Capture the thread id
        // here, not at install-call time, because the host hook and WebView2
        // accelerator are thread-affine.
        let host_thread_id = unsafe { GetCurrentThreadId() };
        let controller = webview.controller();
        let mut parent_window = HWND::default();
        let parent_matches = unsafe {
            controller.ParentWindow(&mut parent_window).is_ok()
                && controller_parent_is_authorized(
                    expected_hwnd,
                    parent_window.0 as usize,
                    host_thread_id,
                )
        };
        if !parent_matches {
            selector_for_hook.trace_qa(&format!(
                "windows native input rejected parent hwnd={} expected_root={expected_hwnd} thread_id={host_thread_id}",
                parent_window.0 as usize,
            ));
            return;
        }
        let expected_controller_hwnd = parent_window.0 as usize;
        let Some(browser_thread_id) = find_browser_thread_id(expected_controller_hwnd) else {
            selector_for_hook.trace_qa(
                "windows native input rejected because the WebView2 browser thread was unavailable",
            );
            return;
        };

        let context = Arc::new(MouseHookContext {
            active: active_for_setup.clone(),
            expected_hwnd,
            expected_controller_hwnd,
            host_thread_id,
            browser_thread_id,
            window_label: window_label.clone(),
            broker: broker_for_hook.clone(),
            selector_perf: selector_for_hook.clone(),
            window: window_for_hook.clone(),
            last_pointer_up: Mutex::new(None),
        });

        let original_window_proc = unsafe {
            SetWindowLongPtrW(
                expected_hwnd as _,
                GWLP_WNDPROC,
                trusted_window_proc as isize,
            )
        };
        if original_window_proc == 0 {
            selector_for_hook.trace_qa("windows native input rejected host window subclass");
            return;
        }
        if !set_host_window_state(HostWindowState {
            hwnd: expected_hwnd,
            context: context.clone(),
            original_window_proc,
        }) {
            unsafe {
                let _ = SetWindowLongPtrW(
                    expected_hwnd as _,
                    GWLP_WNDPROC,
                    original_window_proc,
                );
            }
            selector_for_hook.trace_qa("windows native input rejected duplicate host state");
            return;
        }

        let active_for_accelerator = active_for_setup.clone();
        let destroyed_for_accelerator = destroyed_for_setup.clone();
        let broker_for_accelerator = broker_for_hook.clone();
        let selector_for_accelerator = selector_for_hook.clone();
        let window_for_accelerator = window_for_hook.clone();
        let label_for_accelerator = window_label.clone();
        let accelerator = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |controller: Option<ICoreWebView2Controller>, args| {
                if destroyed_for_accelerator.load(Ordering::Acquire)
                    || !active_for_accelerator.load(Ordering::Acquire)
                {
                    return Ok(());
                }
                let (Some(controller), Some(args)) = (controller, args) else {
                    return Ok(());
                };

                let mut controller_window = HWND::default();
                let controller_matches = unsafe {
                    controller.ParentWindow(&mut controller_window).is_ok()
                        && controller_window.0 as usize == expected_controller_hwnd
                        && controller_parent_is_authorized(
                            expected_hwnd,
                            controller_window.0 as usize,
                            host_thread_id,
                        )
                };
                if !controller_matches
                    || !window_is_authorized(expected_hwnd, host_thread_id, browser_thread_id)
                {
                    return Ok(());
                }

                let mut event_kind = Default::default();
                let mut virtual_key = 0;
                let mut physical_status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                let read_ok = unsafe {
                    args.KeyEventKind(&mut event_kind).is_ok()
                        && args.VirtualKey(&mut virtual_key).is_ok()
                        && args.PhysicalKeyStatus(&mut physical_status).is_ok()
                };
                if !read_ok
                    || event_kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    || physical_status.RepeatCount != 1
                {
                    return Ok(());
                }

                match virtual_key {
                    VK_RETURN | VK_SPACE => {
                        broker_for_accelerator.record(
                            &label_for_accelerator,
                            TrustedActivationKind::KeyboardActivation,
                            Instant::now(),
                        );
                        if virtual_key == VK_SPACE {
                            let _ = selector_for_accelerator.start_native_input(
                                &window_for_accelerator,
                                NativeSelectorInputKind::KeyboardSelect,
                            );
                        }
                    }
                    VK_UP | VK_DOWN => {
                        let _ = selector_for_accelerator.start_native_input(
                            &window_for_accelerator,
                            NativeSelectorInputKind::KeyboardMove,
                        );
                    }
                    _ => {}
                }
                Ok(())
            },
        ));

        let mut accelerator_token = 0;
        if unsafe { controller.add_AcceleratorKeyPressed(&accelerator, &mut accelerator_token) }
            .is_err()
        {
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected accelerator registration");
            return;
        }

        let Some((mapping, mapping_view)) = create_hook_mapping(
            browser_thread_id,
            expected_hwnd,
        ) else {
            unsafe {
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected hook mapping");
            return;
        };
        let Some(resource_dir) = resource_dir.as_ref() else {
            unsafe {
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected missing resource directory");
            return;
        };
        let dll_path = resource_dir.join(TRUSTED_INPUT_HOOK_DLL);
        let Some(hook_module) = load_hook_module(&dll_path) else {
            unsafe {
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa(&format!(
                "windows native input rejected missing hook DLL path={}",
                dll_path.display()
            ));
            return;
        };
        let Some(browser_hook_proc) = hook_proc(hook_module) else {
            unsafe {
                let _ = FreeLibrary(hook_module);
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected hook DLL export");
            return;
        };

        // Required current-process, thread-scoped hook. A null module is
        // valid because this callback is in the ImageForge host executable.
        let host_mouse_hook = unsafe {
            SetWindowsHookExW(
                WH_MOUSE,
                Some(mouse_hook_proc),
                std::ptr::null_mut(),
                host_thread_id,
            )
        };
        if host_mouse_hook.is_null() {
            unsafe {
                let _ = FreeLibrary(hook_module);
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected host mouse hook registration");
            return;
        }

        // WebView2 content runs in a browser process. This second hook is
        // still thread-scoped WH_MOUSE, but its callback lives in the helper
        // DLL that Win32 injects into the exact browser UI thread. The helper
        // only posts a native host message; it never performs broker, COM, or
        // renderer work in the hook callback.
        let browser_mouse_hook = unsafe {
            SetWindowsHookExW(
                WH_MOUSE,
                Some(browser_hook_proc),
                hook_module as HINSTANCE,
                browser_thread_id,
            )
        };
        if browser_mouse_hook.is_null() {
            unsafe {
                let _ = UnhookWindowsHookEx(host_mouse_hook);
                let _ = FreeLibrary(hook_module);
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
            selector_for_hook.trace_qa("windows native input rejected WebView2 mouse hook registration");
            return;
        }

        MOUSE_HOOK_CONTEXT.with(|context_slot| {
            *context_slot.borrow_mut() = Some(context);
        });
        if let Ok(mut slot) = registration_for_setup.lock() {
            // Transfer one COM reference only after the registration lock is
            // acquired; the poisoned-lock cleanup path below therefore has
            // no raw reference to release.
            let controller_raw = controller.clone().into_raw() as usize;
            *slot = Some(Registration {
                controller: controller_raw,
                accelerator_token,
                host_mouse_hook: host_mouse_hook as usize,
                browser_mouse_hook: browser_mouse_hook as usize,
                hook_module: hook_module as usize,
                mapping: mapping as usize,
                mapping_view: mapping_view as usize,
                original_window_proc,
                host_hwnd: expected_hwnd,
                host_thread_id,
            });
            active_for_setup.store(true, Ordering::Release);
            set_mapping_active(mapping_view, true);
            selector_for_hook.trace_qa(&format!(
                "windows native input registered host_thread_id={host_thread_id} browser_thread_id={browser_thread_id} hwnd={expected_hwnd}"
            ));
        } else {
            selector_for_hook.trace_qa("windows native input rejected registration state");
            MOUSE_HOOK_CONTEXT.with(|context_slot| {
                *context_slot.borrow_mut() = None;
            });
            unsafe {
                let _ = UnhookWindowsHookEx(host_mouse_hook);
                let _ = UnhookWindowsHookEx(browser_mouse_hook);
                let _ = FreeLibrary(hook_module);
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
                close_hook_mapping(mapping, mapping_view);
            }
            restore_failed_setup(expected_hwnd, original_window_proc);
        }
    })?;

    Ok(NativeInputHook {
        active,
        destroyed,
        registration,
        window: window.clone(),
    })
}

type HookProc = unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT;

unsafe extern "system" fn mouse_hook_proc(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && w_param == WM_LBUTTONUP as WPARAM && l_param != 0 {
        MOUSE_HOOK_CONTEXT.with(|context_slot| {
            let context_guard = context_slot.borrow();
            let Some(context) = context_guard.as_ref() else {
                return;
            };
            let event = unsafe { &*(l_param as *const MOUSEHOOKSTRUCT) };
            handle_pointer_up(context, event.hwnd as usize, event.pt, "host-thread");
        });
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
}

unsafe extern "system" fn trusted_window_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if message == TRUSTED_INPUT_MESSAGE {
        let context = host_window_state().lock().ok().and_then(|state| {
            state
                .as_ref()
                .filter(|state| state.hwnd == hwnd as usize)
                .map(|state| state.context.clone())
        });
        if let Some(context) = context {
            let point = unpack_point(l_param);
            handle_pointer_up(&context, w_param as usize, point, "browser-thread");
            return 0;
        }
    }

    let original = host_window_state()
        .lock()
        .ok()
        .and_then(|state| state.as_ref().map(|state| state.original_window_proc));
    if let Some(original) = original.filter(|original| *original != 0) {
        let original: WNDPROC = Some(std::mem::transmute(original));
        unsafe { CallWindowProcW(original, hwnd, message, w_param, l_param) }
    } else {
        0
    }
}

fn handle_pointer_up(context: &MouseHookContext, target: usize, point: POINT, source: &str) {
    context.selector_perf.trace_qa(&format!(
        "windows {source} mouse hook received left button up target={target} point=({}, {})",
        point.x, point.y
    ));
    if !context.active.load(Ordering::Acquire) {
        context
            .selector_perf
            .trace_qa("windows mouse hook ignored inactive registration");
        return;
    }
    if !window_is_authorized(
        context.expected_hwnd,
        context.host_thread_id,
        context.browser_thread_id,
    ) || !controller_parent_is_authorized(
        context.expected_hwnd,
        context.expected_controller_hwnd,
        context.host_thread_id,
    ) {
        context
            .selector_perf
            .trace_qa("windows mouse hook ignored unauthorized window");
        return;
    }
    if !is_window_or_descendant(context.expected_controller_hwnd, target)
        && !is_window_or_descendant(context.expected_hwnd, target)
    {
        context.selector_perf.trace_qa(&format!(
            "windows mouse hook ignored target hwnd={target} expected={}",
            context.expected_hwnd
        ));
        return;
    }
    let point_target =
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::WindowFromPoint(point) };
    if point_target.is_null()
        || (!is_window_or_descendant(context.expected_controller_hwnd, point_target as usize)
            && !is_window_or_descendant(context.expected_hwnd, point_target as usize))
    {
        context
            .selector_perf
            .trace_qa("windows mouse hook ignored point outside WebView host");
        return;
    }
    let now = Instant::now();
    if let Ok(mut last) = context.last_pointer_up.lock() {
        if last.as_ref().is_some_and(|(previous, x, y)| {
            now.saturating_duration_since(*previous) < Duration::from_millis(50)
                && *x == point.x
                && *y == point.y
        }) {
            context
                .selector_perf
                .trace_qa("windows mouse hook ignored duplicate pointer notification");
            return;
        }
        *last = Some((now, point.x, point.y));
    } else {
        context
            .selector_perf
            .trace_qa("windows mouse hook ignored poisoned pointer state");
        return;
    }
    context.selector_perf.trace_qa(&format!(
        "windows mouse hook passed hwnd={} target={target}",
        context.expected_hwnd
    ));
    context.broker.record(
        &context.window_label,
        TrustedActivationKind::PrimaryPointerUp,
        now,
    );
    let _ = context
        .selector_perf
        .start_native_input(&context.window, NativeSelectorInputKind::PrimaryMouseUp);
}

fn window_is_authorized(
    expected_hwnd: usize,
    expected_thread_id: u32,
    browser_thread_id: u32,
) -> bool {
    if expected_hwnd == 0 || unsafe { GetCurrentThreadId() } != expected_thread_id {
        return false;
    }
    let expected = expected_hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsWindow(expected) == 0
            || IsWindowVisible(expected) == 0
            || IsWindowEnabled(expected) == 0
            || IsIconic(expected) != 0
            || GetForegroundWindow() != expected
        {
            return false;
        }
        let mut process_id = 0;
        let owner_thread_id = GetWindowThreadProcessId(expected, &mut process_id);
        if owner_thread_id == 0
            || owner_thread_id != expected_thread_id
            || process_id != GetCurrentProcessId()
        {
            return false;
        }
        let host_focus = GetFocus();
        if !host_focus.is_null() && is_window_or_descendant(expected_hwnd, host_focus as usize) {
            return true;
        }
        if browser_thread_id == 0 {
            return false;
        }
        let mut thread_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(browser_thread_id, &mut thread_info) != 0
            && !thread_info.hwndFocus.is_null()
            && (is_window_or_descendant(expected_hwnd, thread_info.hwndFocus as usize)
                || GetAncestor(thread_info.hwndFocus, GA_ROOTOWNER) == expected)
    }
}

fn controller_parent_is_authorized(
    expected_hwnd: usize,
    controller_hwnd: usize,
    expected_thread_id: u32,
) -> bool {
    if expected_hwnd == 0
        || controller_hwnd == 0
        || unsafe { GetCurrentThreadId() } != expected_thread_id
    {
        return false;
    }
    let expected = expected_hwnd as windows_sys::Win32::Foundation::HWND;
    let controller = controller_hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsWindow(expected) == 0
            || IsWindow(controller) == 0
            || IsWindowVisible(controller) == 0
            || IsWindowEnabled(controller) == 0
            || GetAncestor(controller, GA_ROOT) != expected
            || IsChild(expected, controller) == 0
        {
            return false;
        }
        let mut process_id = 0;
        let owner_thread_id = GetWindowThreadProcessId(controller, &mut process_id);
        owner_thread_id == expected_thread_id && process_id == GetCurrentProcessId()
    }
}

fn is_window_or_descendant(expected_hwnd: usize, target_hwnd: usize) -> bool {
    if expected_hwnd == 0 || target_hwnd == 0 {
        return false;
    }
    let expected = expected_hwnd as windows_sys::Win32::Foundation::HWND;
    let target = target_hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsWindow(target) == 0 || IsWindowVisible(target) == 0 {
            return false;
        }
        if target == expected || IsChild(expected, target) != 0 {
            return true;
        }
        let mut current = target;
        for _ in 0..64 {
            current = GetParent(current);
            if current.is_null() {
                break;
            }
            if current == expected {
                return true;
            }
        }
        false
    }
}

fn find_browser_thread_id(root_hwnd: usize) -> Option<u32> {
    let current_process = unsafe { GetCurrentProcessId() };
    let mut pending = vec![(root_hwnd as windows_sys::Win32::Foundation::HWND, 0_u8)];
    while let Some((parent, depth)) = pending.pop() {
        if depth >= 16 {
            continue;
        }
        let mut child = unsafe { GetWindow(parent, GW_CHILD) };
        while !child.is_null() {
            let mut process_id = 0;
            let thread_id = unsafe { GetWindowThreadProcessId(child, &mut process_id) };
            if thread_id != 0
                && process_id != 0
                && process_id != current_process
                && unsafe { IsWindowVisible(child) != 0 }
            {
                return Some(thread_id);
            }
            pending.push((child, depth.saturating_add(1)));
            child = unsafe { GetWindow(child, GW_HWNDNEXT) };
        }
    }
    None
}

fn set_host_window_state(state: HostWindowState) -> bool {
    let Ok(mut slot) = host_window_state().lock() else {
        return false;
    };
    if slot.is_some() {
        return false;
    }
    *slot = Some(state);
    true
}

fn clear_host_window_state(hwnd: usize) {
    if let Ok(mut slot) = host_window_state().lock() {
        if slot.as_ref().is_some_and(|state| state.hwnd == hwnd) {
            *slot = None;
        }
    }
}

fn restore_failed_setup(hwnd: usize, original_window_proc: isize) {
    unsafe {
        if original_window_proc != 0 {
            let _ = SetWindowLongPtrW(hwnd as _, GWLP_WNDPROC, original_window_proc);
        }
    }
    clear_host_window_state(hwnd);
}

fn create_hook_mapping(
    browser_thread_id: u32,
    expected_hwnd: usize,
) -> Option<(HANDLE, *mut HookConfig)> {
    let name = format!("Local\\ImageForgeTrustedInput-{browser_thread_id}");
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mapping = unsafe {
        CreateFileMappingW(
            INVALID_HANDLE_VALUE,
            std::ptr::null(),
            PAGE_READWRITE,
            0,
            std::mem::size_of::<HookConfig>() as u32,
            wide_name.as_ptr(),
        )
    };
    if mapping.is_null() {
        return None;
    }
    let view = unsafe {
        MapViewOfFile(
            mapping,
            FILE_MAP_ALL_ACCESS,
            0,
            0,
            std::mem::size_of::<HookConfig>(),
        )
    } as *mut HookConfig;
    if view.is_null() {
        unsafe {
            let _ = CloseHandle(mapping);
        }
        return None;
    }
    unsafe {
        std::ptr::write(
            view,
            HookConfig {
                magic: TRUSTED_INPUT_MAGIC,
                version: TRUSTED_INPUT_VERSION,
                receiver_hwnd: expected_hwnd,
                expected_hwnd,
                active: 0,
            },
        );
    }
    Some((mapping, view))
}

fn set_mapping_active(view: *mut HookConfig, active: bool) {
    if view.is_null() {
        return;
    }
    unsafe {
        std::ptr::write_volatile(
            std::ptr::addr_of_mut!((*view).active),
            if active { 1 } else { 0 },
        );
    }
}

unsafe fn close_hook_mapping(mapping: HANDLE, view: *mut HookConfig) {
    if !view.is_null() {
        let _ = UnmapViewOfFile(view as _);
    }
    if !mapping.is_null() {
        let _ = CloseHandle(mapping);
    }
}

fn load_hook_module(path: &Path) -> Option<HMODULE> {
    use std::os::windows::ffi::OsStrExt;
    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe { LoadLibraryW(wide_path.as_ptr()) };
    (!module.is_null()).then_some(module)
}

fn hook_proc(module: HMODULE) -> Option<HookProc> {
    let proc = unsafe { GetProcAddress(module, b"imageforge_trusted_mouse_hook\0".as_ptr()) }?;
    Some(unsafe { std::mem::transmute(proc) })
}

fn unpack_point(value: LPARAM) -> POINT {
    let packed = value as u64;
    POINT {
        x: (packed as u32) as i32,
        y: ((packed >> 32) as u32) as i32,
    }
}
