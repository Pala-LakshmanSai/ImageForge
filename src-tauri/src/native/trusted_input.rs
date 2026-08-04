//! Native, per-window activation evidence.
//!
//! Renderer `isTrusted` is useful UI telemetry, but it is not authority.  This
//! broker records only filtered OS events received by the native window and
//! consumes each serial once.  Platform adapters below never expose the
//! serial or event timestamp to the renderer.

use super::NativeResult;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const ACTIVATION_VALID_FOR: Duration = Duration::from_millis(1_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrustedActivationKind {
    PrimaryPointerUp,
    KeyboardActivation,
}

#[derive(Debug, Clone)]
struct PendingActivation {
    serial: u64,
    window_label: String,
    kind: TrustedActivationKind,
    issued_at: Instant,
}

#[derive(Debug, Default)]
struct ActivationInner {
    next_serial: u64,
    pending: Option<PendingActivation>,
}

/// Process-local activation authority.  It intentionally contains no
/// renderer-provided fields and is invalidated on native window lifecycle
/// changes.
#[derive(Clone, Debug, Default)]
pub(crate) struct TrustedInputBroker {
    inner: Arc<Mutex<ActivationInner>>,
}

impl TrustedInputBroker {
    pub(crate) fn record(
        &self,
        window_label: &str,
        kind: TrustedActivationKind,
        now: Instant,
    ) -> u64 {
        let mut inner = self.inner.lock().expect("trusted input lock");
        inner.next_serial = inner.next_serial.saturating_add(1).max(1);
        let serial = inner.next_serial;
        inner.pending = Some(PendingActivation {
            serial,
            window_label: window_label.to_owned(),
            kind,
            issued_at: now,
        });
        serial
    }

    pub(crate) fn consume(
        &self,
        window_label: &str,
        now: Instant,
    ) -> NativeResult<TrustedActivationKind> {
        let mut inner = self.inner.lock().expect("trusted input lock");
        let pending = inner.pending.take().ok_or_else(activation_required)?;
        if pending.window_label != window_label
            || now.saturating_duration_since(pending.issued_at) >= ACTIVATION_VALID_FOR
        {
            return Err(activation_required());
        }
        let _serial = pending.serial;
        Ok(pending.kind)
    }

    pub(crate) fn invalidate(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending = None;
        }
    }

    #[cfg(test)]
    fn pending_serial(&self) -> Option<u64> {
        self.inner
            .lock()
            .expect("trusted input lock")
            .pending
            .as_ref()
            .map(|pending| pending.serial)
    }
}

fn activation_required() -> super::NativeError {
    super::NativeError::new(
        "gpu_start_foreground_required",
        "Use a focused native ImageForge control to authorize this GPU action.",
    )
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{TrustedActivationKind, TrustedInputBroker};
    use crate::native::gpu_selector_perf::{GpuSelectorPerfHost, NativeSelectorInputKind};
    use crate::native::NativeError;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventType, NSWindow};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use tauri::WebviewWindow;

    #[derive(Clone, Debug)]
    pub(crate) struct NativeInputHook {
        active: Arc<AtomicBool>,
        destroyed: Arc<AtomicBool>,
        monitor: Arc<Mutex<Option<usize>>>,
    }

    impl NativeInputHook {
        pub(crate) fn invalidate(&self) {
            self.active.store(false, Ordering::Release);
        }

        pub(crate) fn activate(&self) {
            if !self.destroyed.load(Ordering::Acquire) {
                self.active.store(true, Ordering::Release);
            }
        }

        pub(crate) fn remove_on_main_thread(&self) {
            self.destroyed.store(true, Ordering::Release);
            self.active.store(false, Ordering::Release);
            let raw = self.monitor.lock().ok().and_then(|mut slot| slot.take());
            let Some(raw) = raw else { return };
            unsafe {
                if let Some(token) = Retained::<AnyObject>::from_raw(raw as *mut AnyObject) {
                    NSEvent::removeMonitor(&token);
                }
            }
        }
    }

    pub(crate) fn install(
        window: &WebviewWindow,
        broker: TrustedInputBroker,
        selector_perf: GpuSelectorPerfHost,
    ) -> tauri::Result<NativeInputHook> {
        let active = Arc::new(AtomicBool::new(true));
        let destroyed = Arc::new(AtomicBool::new(false));
        let monitor = Arc::new(Mutex::new(None));
        let window_label = window.label().to_owned();
        let window_for_hook = window.clone();
        let window_for_setup = window.clone();
        let active_for_hook = active.clone();
        let active_for_setup = active.clone();
        let destroyed_for_setup = destroyed.clone();
        let monitor_for_setup = monitor.clone();
        let broker_for_hook = broker.clone();
        let selector_for_hook = selector_perf.clone();
        let selector_for_setup = selector_perf.clone();
        let window_number = Arc::new(Mutex::new(None::<isize>));
        let window_number_for_setup = window_number.clone();
        let window_ptr = Arc::new(Mutex::new(None::<usize>));
        let window_ptr_for_setup = window_ptr.clone();

        window.with_webview(move |webview| {
            if destroyed_for_setup.load(Ordering::Acquire) {
                return;
            }
            let ns_window = webview.ns_window();
            if ns_window.is_null() {
                active_for_setup.store(false, Ordering::Release);
                selector_for_setup.report_qa_error(
                    &window_for_setup,
                    &NativeError::new(
                        "gpu_selector_perf_native_input_unavailable",
                        "The native selector input window is unavailable.",
                    ),
                );
                return;
            }
            let number = unsafe { (&*ns_window.cast::<NSWindow>()).windowNumber() as isize };
            *window_number_for_setup.lock().expect("window number lock") = Some(number);
            *window_ptr_for_setup.lock().expect("window pointer lock") = Some(ns_window as usize);

            let event_mask = NSEventMask::LeftMouseUp | NSEventMask::KeyDown;
            let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let event_ref = unsafe { event.as_ref() };
                if !active_for_hook.load(Ordering::Acquire) {
                    return event.as_ptr();
                }
                let Some(expected_window) = *window_number.lock().expect("window number lock")
                else {
                    return event.as_ptr();
                };
                if event_ref.windowNumber() as isize != expected_window {
                    return event.as_ptr();
                }
                let mtm = MainThreadMarker::new().expect("AppKit event monitor main thread");
                let Some(window_ptr) = *window_ptr.lock().expect("window pointer lock") else {
                    return event.as_ptr();
                };
                let app = NSApplication::sharedApplication(mtm);
                let main_window = unsafe { &*(window_ptr as *const NSWindow) };
                if !app.isActive()
                    || main_window.windowNumber() as isize != expected_window
                    || !main_window.isVisible()
                    || !main_window.isKeyWindow()
                {
                    return event.as_ptr();
                }
                match event_ref.r#type() {
                    NSEventType::LeftMouseUp => {
                        broker_for_hook.record(
                            &window_label,
                            TrustedActivationKind::PrimaryPointerUp,
                            Instant::now(),
                        );
                        let _ = selector_for_hook.start_native_input(
                            &window_for_hook,
                            NativeSelectorInputKind::PrimaryMouseUp,
                        );
                    }
                    NSEventType::KeyDown if !event_ref.isARepeat() => {
                        let key = event_ref.keyCode();
                        if matches!(key, 36 | 76 | 49) {
                            broker_for_hook.record(
                                &window_label,
                                TrustedActivationKind::KeyboardActivation,
                                Instant::now(),
                            );
                        }
                        let selector_kind = match key {
                            125 | 126 => Some(NativeSelectorInputKind::KeyboardMove),
                            49 => Some(NativeSelectorInputKind::KeyboardSelect),
                            _ => None,
                        };
                        if let Some(kind) = selector_kind {
                            let _ = selector_for_hook.start_native_input(&window_for_hook, kind);
                        }
                    }
                    _ => {}
                }
                event.as_ptr()
            });
            let token = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(event_mask, &block)
            };
            if let Some(token) = token {
                *monitor_for_setup.lock().expect("monitor lock") =
                    Some(Retained::into_raw(token) as usize);
            } else {
                active_for_setup.store(false, Ordering::Release);
                selector_for_setup.report_qa_error(
                    &window_for_setup,
                    &NativeError::new(
                        "gpu_selector_perf_native_input_unavailable",
                        "The macOS native selector input monitor could not be registered.",
                    ),
                );
            }
        })?;

        // `with_webview` schedules its closure on the Tauri main thread and
        // returns before that closure necessarily runs.  The handle remains
        // active while registration completes; failure leaves activation
        // disabled rather than aborting a normal app launch.
        Ok(NativeInputHook {
            active,
            destroyed,
            monitor,
        })
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub(crate) use windows::{install, NativeInputHook};

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
#[derive(Clone, Debug)]
pub(crate) struct NativeInputHook;

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
impl NativeInputHook {
    pub(crate) fn invalidate(&self) {}
    pub(crate) fn activate(&self) {}
    pub(crate) fn remove_on_main_thread(&self) {}
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) fn install(
    _window: &tauri::WebviewWindow,
    _broker: TrustedInputBroker,
    _selector_perf: crate::native::gpu_selector_perf::GpuSelectorPerfHost,
) -> tauri::Result<NativeInputHook> {
    // Windows receives its equivalent WebView2/subclass hook in the target
    // implementation.  Keep ordinary non-macOS development launches safe:
    // no renderer fallback is treated as native activation evidence.
    Ok(NativeInputHook)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_is_native_window_bound_single_use_and_expiring() {
        let broker = TrustedInputBroker::default();
        let now = Instant::now();
        assert_eq!(broker.pending_serial(), None);
        broker.record("main", TrustedActivationKind::PrimaryPointerUp, now);
        assert!(broker.pending_serial().is_some());
        assert_eq!(
            broker.consume("secondary", now).unwrap_err().code,
            "gpu_start_foreground_required"
        );
        // The mismatched consume consumes the pending record; no replay.
        assert_eq!(
            broker.consume("main", now).unwrap_err().code,
            "gpu_start_foreground_required"
        );

        broker.record("main", TrustedActivationKind::PrimaryPointerUp, now);
        assert_eq!(
            broker
                .consume("main", now + Duration::from_millis(999))
                .unwrap(),
            TrustedActivationKind::PrimaryPointerUp
        );
        broker.record("main", TrustedActivationKind::PrimaryPointerUp, now);
        assert_eq!(
            broker
                .consume("main", now + ACTIVATION_VALID_FOR)
                .unwrap_err()
                .code,
            "gpu_start_foreground_required"
        );

        broker.record("main", TrustedActivationKind::KeyboardActivation, now);
        assert_eq!(
            broker.consume("main", now).unwrap(),
            TrustedActivationKind::KeyboardActivation
        );
        assert_eq!(
            broker.consume("main", now).unwrap_err().code,
            "gpu_start_foreground_required"
        );
    }

    #[test]
    fn invalidation_destroys_pending_activation() {
        let broker = TrustedInputBroker::default();
        let now = Instant::now();
        broker.record("main", TrustedActivationKind::KeyboardActivation, now);
        broker.invalidate();
        assert_eq!(
            broker.consume("main", now).unwrap_err().code,
            "gpu_start_foreground_required"
        );
    }
}
