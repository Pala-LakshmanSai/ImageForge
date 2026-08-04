//! Windows trusted input authority.
//!
//! WebView2's accelerator event and a thread-scoped Win32 mouse hook are the
//! only inputs that can create a broker activation.  Renderer events are not
//! consulted, and registration remains disabled unless both native hooks are
//! installed successfully.

use super::{TrustedActivationKind, TrustedInputBroker};
use crate::native::gpu_selector_perf::{GpuSelectorPerfHost, NativeSelectorInputKind};
use ::windows::core::Interface;
use ::windows::Win32::Foundation::HWND;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::WebviewWindow;
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsChild, IsIconic,
    IsWindow, IsWindowVisible, SetWindowsHookExW, UnhookWindowsHookEx, GA_ROOT, HC_ACTION,
    MOUSEHOOKSTRUCT, WH_MOUSE, WM_LBUTTONUP,
};

const VK_RETURN: u32 = 0x0D;
const VK_SPACE: u32 = 0x20;
const VK_UP: u32 = 0x26;
const VK_DOWN: u32 = 0x28;

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
    mouse_hook: usize,
    thread_id: u32,
}

struct MouseHookContext {
    active: Arc<AtomicBool>,
    expected_hwnd: usize,
    thread_id: u32,
    window_label: String,
    broker: TrustedInputBroker,
    selector_perf: GpuSelectorPerfHost,
    window: WebviewWindow,
}

thread_local! {
    static MOUSE_HOOK_CONTEXT: RefCell<Option<MouseHookContext>> = const { RefCell::new(None) };
}

impl NativeInputHook {
    pub(crate) fn invalidate(&self) {
        self.active.store(false, Ordering::Release);
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
        }
    }

    pub(crate) fn remove_on_main_thread(&self) {
        self.destroyed.store(true, Ordering::Release);
        self.active.store(false, Ordering::Release);
        let Ok(mut slot) = self.registration.lock() else {
            return;
        };

        // Tauri delivers Destroyed on the window thread.  If that invariant is
        // ever violated, remain fail-closed and retain the registration for
        // that thread to tear down rather than dropping the OS handles here.
        let Some(registration_thread_id) = slot.as_ref().map(|registration| registration.thread_id)
        else {
            return;
        };
        if unsafe { GetCurrentThreadId() } != registration_thread_id {
            // Destroyed normally arrives on the WebView UI thread, but keep a
            // queued retry for the defensive off-thread case.  Dropping the
            // COM registration here would leak the accelerator and mouse hook.
            drop(slot);
            let hook = self.clone();
            let window = self.window.clone();
            let _ = window.run_on_main_thread(move || hook.remove_on_main_thread());
            return;
        }
        let Some(registration) = slot.take() else {
            return;
        };

        MOUSE_HOOK_CONTEXT.with(|context| {
            *context.borrow_mut() = None;
        });
        unsafe {
            let controller =
                ICoreWebView2Controller::from_raw(registration.controller as *mut std::ffi::c_void);
            let _ = controller.remove_AcceleratorKeyPressed(registration.accelerator_token);
            let _ = UnhookWindowsHookEx(registration.mouse_hook as _);
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
    let active = Arc::new(AtomicBool::new(false));
    let destroyed = Arc::new(AtomicBool::new(false));
    let registration = Arc::new(Mutex::new(None));

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

        // `with_webview` executes on Tauri's UI thread.  Capture the thread
        // id here, not at install-call time, because the hook and WebView2
        // accelerator are both thread-affine.
        let thread_id = unsafe { GetCurrentThreadId() };

        let controller = webview.controller();
        let mut parent_window = HWND::default();
        let parent_matches = unsafe {
            controller.ParentWindow(&mut parent_window).is_ok()
                && parent_window.0 as usize == expected_hwnd
        };
        if !parent_matches {
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
                        && controller_window.0 as usize == expected_hwnd
                };
                if !controller_matches || !window_is_authorized(expected_hwnd, thread_id) {
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
                    VK_UP => {
                        let _ = selector_for_accelerator.start_native_input(
                            &window_for_accelerator,
                            NativeSelectorInputKind::KeyboardMove,
                        );
                    }
                    VK_DOWN => {
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
            return;
        }

        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        let mouse_hook =
            unsafe { SetWindowsHookExW(WH_MOUSE, Some(mouse_hook_proc), module, thread_id) };
        if mouse_hook.is_null() {
            unsafe {
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
            }
            return;
        }

        MOUSE_HOOK_CONTEXT.with(|context| {
            *context.borrow_mut() = Some(MouseHookContext {
                active: active_for_setup.clone(),
                expected_hwnd,
                thread_id,
                window_label: window_label.clone(),
                broker: broker_for_hook.clone(),
                selector_perf: selector_for_hook.clone(),
                window: window_for_hook.clone(),
            });
        });
        if let Ok(mut slot) = registration_for_setup.lock() {
            // Transfer one COM reference only after the registration lock is
            // acquired; the poisoned-lock cleanup path below therefore has
            // no raw reference to release.
            let controller_raw = controller.clone().into_raw() as usize;
            *slot = Some(Registration {
                controller: controller_raw,
                accelerator_token,
                mouse_hook: mouse_hook as usize,
                thread_id,
            });
            active_for_setup.store(true, Ordering::Release);
        } else {
            MOUSE_HOOK_CONTEXT.with(|context| {
                *context.borrow_mut() = None;
            });
            unsafe {
                let _ = UnhookWindowsHookEx(mouse_hook);
                let _ = controller.remove_AcceleratorKeyPressed(accelerator_token);
            }
        }
    })?;

    Ok(NativeInputHook {
        active,
        destroyed,
        registration,
        window: window.clone(),
    })
}

unsafe extern "system" fn mouse_hook_proc(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && w_param == WM_LBUTTONUP as WPARAM && l_param != 0 {
        MOUSE_HOOK_CONTEXT.with(|context| {
            let context_guard = context.borrow();
            let Some(context) = context_guard.as_ref() else {
                return;
            };
            if !context.active.load(Ordering::Acquire)
                || !window_is_authorized(context.expected_hwnd, context.thread_id)
            {
                return;
            }
            let event = unsafe { &*(l_param as *const MOUSEHOOKSTRUCT) };
            let target = event.hwnd as usize;
            if !is_window_or_child(context.expected_hwnd, target) {
                return;
            }
            context.broker.record(
                &context.window_label,
                TrustedActivationKind::PrimaryPointerUp,
                Instant::now(),
            );
            let _ = context
                .selector_perf
                .start_native_input(&context.window, NativeSelectorInputKind::PrimaryMouseUp);
        });
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
}

fn window_is_authorized(expected_hwnd: usize, expected_thread_id: u32) -> bool {
    if expected_hwnd == 0 || unsafe { GetCurrentThreadId() } != expected_thread_id {
        return false;
    }
    let expected = expected_hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsWindow(expected) == 0
            || IsWindowVisible(expected) == 0
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
        let focus = GetFocus();
        !focus.is_null() && GetAncestor(focus, GA_ROOT) == expected
    }
}

fn is_window_or_child(expected_hwnd: usize, target_hwnd: usize) -> bool {
    if expected_hwnd == 0 || target_hwnd == 0 {
        return false;
    }
    let expected = expected_hwnd as windows_sys::Win32::Foundation::HWND;
    let target = target_hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe { target == expected || IsChild(expected, target) != 0 }
}
