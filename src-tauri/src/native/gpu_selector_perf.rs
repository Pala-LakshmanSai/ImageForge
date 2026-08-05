//! Installed-only Task 014 selector performance instrumentation.
//!
//! The production renderer never receives a timer or a native sample ID from
//! this module.  A release harness must opt in before the Tauri window is
//! created, bind the installed artifact/session metadata, and arrange for the
//! native trusted-input hook to call `start_trusted_input`.  Without that
//! out-of-band session every command is deliberately disabled.

use super::{NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};
use uuid::{Uuid, Version};

const FIXTURE_SHA256: &str = "102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68";
const MOUNTED_ROW_IDS_SHA256: &str =
    "83d20e051a50c2f0fbb16a459af0d67662acf81feaeddf9af0cab82b6cc3c71c";
const QA_OPT_IN_ENV: &str = "IMAGEFORGE_GPU_SELECTOR_PERF_QA";
const QA_SESSION_ENV: &str = "IMAGEFORGE_GPU_SELECTOR_PERF_QA_SESSION";
const QA_EVENT: &str = "gpu-selector-perf-started-v1";
const QA_ERROR_EVENT: &str = "gpu-selector-perf-error-v1";
const QA_WARMUP_INPUT_EVENT: &str = "gpu-selector-perf-warmup-input-v1";
const ARM_VALID_FOR: Duration = Duration::from_secs(5);
const MAX_DURATION_US: u64 = 10_000_000;
type NativeWindowSize = (u32, u32);

pub const GPU_SELECTOR_PERF_ROW_IDS: [&str; 10] = [
    "current",
    "auto",
    "ordinary:rtx-4090",
    "ordinary:rtx-pro-4500-blackwell",
    "ordinary:rtx-5090",
    "ordinary:rtx-pro-4000-blackwell",
    "ordinary:l4",
    "ordinary:rtx-a4500",
    "ordinary:rtx-4000-ada",
    "emergency:rtx-2000-ada",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GpuSelectorPerfActionV1 {
    ColdOpen,
    WarmOpen,
    RefreshLoading,
    KeyboardMove,
    KeyboardSelect,
}

/// Native input kind observed by the installed QA hook.  The hook supplies
/// only the kind; action, viewport, UUID, and monotonic start stay native.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeSelectorInputKind {
    KeyboardMove,
    KeyboardSelect,
    PrimaryMouseUp,
}

impl NativeSelectorInputKind {
    fn matches(self, action: GpuSelectorPerfActionV1) -> bool {
        match self {
            Self::KeyboardMove => action == GpuSelectorPerfActionV1::KeyboardMove,
            Self::KeyboardSelect => action == GpuSelectorPerfActionV1::KeyboardSelect,
            Self::PrimaryMouseUp => matches!(
                action,
                GpuSelectorPerfActionV1::ColdOpen
                    | GpuSelectorPerfActionV1::WarmOpen
                    | GpuSelectorPerfActionV1::RefreshLoading
            ),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuSelectorPerfArmV1 {
    pub fixture_sha256: String,
    pub action: GpuSelectorPerfActionV1,
    pub ordinal: u8,
    pub viewport_width: u16,
    pub viewport_height: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuSelectorPerfCommitV1 {
    pub qa_session_id: String,
    pub sample_id: String,
    pub mounted_row_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuSelectorPerfArmResultV1 {
    pub schema_version: u8,
    pub armed: bool,
    pub qa_session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuSelectorPerfStartedEventV1 {
    pub schema_version: u8,
    pub event: &'static str,
    pub qa_session_id: String,
    pub sample_id: String,
    pub action: GpuSelectorPerfActionV1,
    pub ordinal: u8,
    pub viewport_width: u16,
    pub viewport_height: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GpuSelectorPerfWarmupInputEventV1 {
    schema_version: u8,
    event: &'static str,
    input: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuSelectorPerfSampleV1 {
    pub schema_version: u8,
    pub sample_id: String,
    pub platform: String,
    pub app_version: String,
    pub commit_sha: String,
    pub artifact_sha256: String,
    pub viewport_width: u16,
    pub viewport_height: u16,
    pub action: GpuSelectorPerfActionV1,
    pub ordinal: u8,
    pub duration_us: u64,
    pub mounted_gpu_rows: u8,
    pub mounted_row_ids_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GpuSelectorPerfQaSessionV1 {
    schema_version: u8,
    qa_session_id: String,
    platform: String,
    app_version: String,
    commit_sha: String,
    artifact_sha256: String,
    fixture_sha256: String,
    action: GpuSelectorPerfActionV1,
    window_label: String,
}

#[derive(Debug, Clone)]
struct ArmedSample {
    action: GpuSelectorPerfActionV1,
    ordinal: u8,
    viewport_width: u16,
    viewport_height: u16,
    native_window_size: Option<NativeWindowSize>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingSample {
    qa_session_id: String,
    sample_id: String,
    action: GpuSelectorPerfActionV1,
    ordinal: u8,
    viewport_width: u16,
    viewport_height: u16,
    native_window_size: Option<NativeWindowSize>,
    started_at: Instant,
}

#[derive(Debug, Default)]
struct PerfInner {
    session: Option<GpuSelectorPerfQaSessionV1>,
    armed: Option<ArmedSample>,
    pending: Option<PendingSample>,
}

#[derive(Clone, Debug, Default)]
pub struct GpuSelectorPerfHost {
    inner: Arc<Mutex<PerfInner>>,
    sample_output: Option<PathBuf>,
}

impl GpuSelectorPerfHost {
    /// Build the host before the main window exists.  The QA capability is
    /// only live when the harness supplies both an explicit opt-in and a
    /// strict, artifact-bound session object; ordinary launches stay disabled.
    pub fn from_environment() -> NativeResult<Self> {
        let host = Self::default();
        if std::env::var(QA_OPT_IN_ENV).ok().as_deref() != Some("1") {
            return Ok(host);
        }
        let sample_output = qa_sample_output_from_environment()?;
        let raw = std::env::var(QA_SESSION_ENV).map_err(|_| {
            NativeError::new(
                "gpu_selector_perf_session_invalid",
                "The selector performance QA session is missing.",
            )
        })?;
        let session: GpuSelectorPerfQaSessionV1 = serde_json::from_str(&raw).map_err(|_| {
            NativeError::new(
                "gpu_selector_perf_session_invalid",
                "The selector performance QA session is malformed.",
            )
        })?;
        validate_session(&session)?;
        *host.inner.lock().expect("selector perf lock") = PerfInner {
            session: Some(session),
            armed: None,
            pending: None,
        };
        if let Some(path) = &sample_output {
            reset_sample_output(path)?;
        }
        // The output path is an installed-harness-only transport for raw
        // samples. It is never accepted from a renderer command and is not
        // present in the artifact/session binding used by production.
        Ok(Self {
            inner: host.inner,
            sample_output,
        })
    }

    #[cfg(test)]
    fn for_test() -> Self {
        Self::for_test_action(GpuSelectorPerfActionV1::ColdOpen)
    }

    #[cfg(test)]
    fn for_test_action(action: GpuSelectorPerfActionV1) -> Self {
        let session = GpuSelectorPerfQaSessionV1 {
            schema_version: 1,
            qa_session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            platform: current_platform().to_owned(),
            app_version: "0.1.9".to_owned(),
            commit_sha: "a".repeat(40),
            artifact_sha256: "b".repeat(64),
            fixture_sha256: FIXTURE_SHA256.to_owned(),
            action,
            window_label: "main".to_owned(),
        };
        let host = Self::default();
        *host.inner.lock().expect("selector perf lock") = PerfInner {
            session: Some(session),
            armed: None,
            pending: None,
        };
        host
    }

    pub fn arm(
        &self,
        window: &WebviewWindow,
        input: GpuSelectorPerfArmV1,
    ) -> NativeResult<GpuSelectorPerfArmResultV1> {
        // Arming is only a QA capability and does not mint trusted input. The
        // native callback below still requires the visible, focused,
        // foreground window at the exact OS event. Allowing the harness to
        // arm before its external focus helper runs avoids a startup race;
        // focus loss still invalidates the arm through the window lifecycle.
        self.trace_qa(&format!(
            "selector arm preflight action={:?} ordinal={}",
            input.action, input.ordinal
        ));
        if let Err(error) = require_main_visible(window) {
            self.trace_qa(&format!(
                "selector arm preflight rejected code={} message={}",
                error.code, error.message
            ));
            return Err(error);
        }
        let native_window_size = native_window_size(window)?;
        let requested_action = input.action;
        let requested_ordinal = input.ordinal;
        self.trace_qa(&format!(
            "selector arm requested action={:?} ordinal={} native_window={:?}",
            requested_action, requested_ordinal, native_window_size
        ));
        let result =
            self.arm_inner_with_native_size(input, Instant::now(), Some(native_window_size));
        match &result {
            Ok(armed) => self.trace_qa(&format!(
                "selector arm accepted action={:?} ordinal={} armed={}",
                requested_action, requested_ordinal, armed.armed
            )),
            Err(error) => self.trace_qa(&format!(
                "selector arm rejected code={} message={}",
                error.code, error.message
            )),
        }
        result
    }

    /// Called by the native trusted pointer/keyboard hook.  There is no
    /// renderer command for this transition: the sample UUID and monotonic
    /// start timestamp are generated here, then the strict event is emitted
    /// to the bound main window exactly once.
    pub(crate) fn start_trusted_input(
        &self,
        window: &WebviewWindow,
        action: GpuSelectorPerfActionV1,
        viewport_width: u16,
        viewport_height: u16,
    ) -> NativeResult<GpuSelectorPerfStartedEventV1> {
        require_main_foreground(window)?;
        let native_window_size = native_window_size(window)?;
        let event = self.start_inner_with_native_size(
            action,
            viewport_width,
            viewport_height,
            Instant::now(),
            Some(native_window_size),
        )?;
        if window.emit(QA_EVENT, &event).is_err() {
            self.inner.lock().expect("selector perf lock").pending = None;
            return Err(NativeError::new(
                "gpu_selector_perf_event_failed",
                "The selector performance sample event could not be delivered.",
            ));
        }
        Ok(event)
    }

    /// Start a sample from a platform-native key/mouse event.  Renderer code
    /// cannot provide the action, viewport, timestamp, or sample ID.  A
    /// mismatched native event is ignored so normal user input while the
    /// harness is idle never changes QA state.
    pub(crate) fn start_native_input(
        &self,
        window: &WebviewWindow,
        input: NativeSelectorInputKind,
    ) -> NativeResult<Option<GpuSelectorPerfStartedEventV1>> {
        let result: NativeResult<Option<GpuSelectorPerfStartedEventV1>> = (|| {
            // The platform adapter has just authenticated the OS event with
            // its exact native window, visibility, foreground, and focus
            // checks.  Do not repeat that state read through Tauri here: the
            // native callback may run on a WebView2/host dispatch thread where
            // a second Tauri window query can return a stale or incompatible
            // value.  This method is crate-private and has no renderer-call
            // path; all callers are the platform adapters above it.
            // The arm's native size is retained in the pending sample. Window
            // resize/scale lifecycle events clear that arm before another
            // native event can be accepted, so querying Tauri again here is
            // both redundant and unsafe on the WebView2 hook thread.
            let now = Instant::now();
            self.trace_qa(&format!(
                "selector native input preflight lifecycle=native_input now_arm={} native_window={:?}",
                self.qa_arm_summary(now),
                self.armed_native_window_size()
            ));
            let native_window_size = self.armed_native_window_size();
            let event = self.start_native_inner_with_native_size(input, now, native_window_size)?;
            let Some(event) = event else {
                self.emit_warmup_input_if_needed(window, input)?;
                return Ok(None);
            };
            // WebView2's AcceleratorKeyPressed and WH_MOUSE callbacks are
            // thread-affine native hooks.  Do not synchronously call Tauri's
            // WebView emitter from those callbacks: a second authenticated
            // notification can otherwise race the blocked emit and consume
            // the one-use arm while the renderer never receives its event.
            // The sample identity and monotonic timestamp were already
            // generated and bound above the dispatch boundary.
            let event_for_emit = event.clone();
            let window_for_emit = window.clone();
            let host_for_emit = self.clone();
            window
                .run_on_main_thread(move || {
                    if window_for_emit.emit(QA_EVENT, &event_for_emit).is_err() {
                        host_for_emit.clear_pending_sample(&event_for_emit.sample_id);
                        let error = gpu_selector_perf_event_failed();
                        host_for_emit.report_qa_error(&window_for_emit, &error);
                    }
                })
                .map_err(|_| {
                    self.clear_pending_sample(&event.sample_id);
                    gpu_selector_perf_event_failed()
                })?;
            Ok(Some(event))
        })();
        match &result {
            Ok(Some(event)) => self.trace_qa(&format!(
                "selector native input accepted action={:?} ordinal={}",
                event.action, event.ordinal
            )),
            Ok(None) => self.trace_qa(&format!(
                "selector native input ignored because no matching arm was available lifecycle=native_input {}",
                self.qa_state_summary()
            )),
            Err(error) => self.trace_qa(&format!(
                "selector native input rejected code={} message={}",
                error.code, error.message
            )),
        }
        if let Err(error) = &result {
            self.report_qa_error(window, error);
        }
        result
    }

    fn emit_warmup_input_if_needed(
        &self,
        window: &WebviewWindow,
        input: NativeSelectorInputKind,
    ) -> NativeResult<()> {
        let Some(event) = self.warmup_input_event(input) else {
            return Ok(());
        };
        self.trace_qa("selector native warmup input scheduled");
        let event_for_emit = event.clone();
        let window_for_emit = window.clone();
        let host_for_emit = self.clone();
        window
            .run_on_main_thread(move || {
                if window_for_emit
                    .emit(QA_WARMUP_INPUT_EVENT, &event_for_emit)
                    .is_err()
                {
                    let error = gpu_selector_perf_event_failed();
                    host_for_emit.report_qa_error(&window_for_emit, &error);
                    return;
                }
                host_for_emit.trace_qa("selector native warmup input delivered");
            })
            .map_err(|_| gpu_selector_perf_event_failed())
    }

    fn warmup_input_event(
        &self,
        input: NativeSelectorInputKind,
    ) -> Option<GpuSelectorPerfWarmupInputEventV1> {
        let inner = self.inner.lock().expect("selector perf lock");
        let session = inner.session.as_ref()?;
        if session.action != GpuSelectorPerfActionV1::WarmOpen
            || input != NativeSelectorInputKind::PrimaryMouseUp
            || inner.armed.is_some()
            || inner.pending.is_some()
        {
            return None;
        }
        Some(GpuSelectorPerfWarmupInputEventV1 {
            schema_version: 1,
            event: QA_WARMUP_INPUT_EVENT,
            input: "primary_mouse_up",
        })
    }

    fn armed_native_window_size(&self) -> Option<NativeWindowSize> {
        self.inner
            .lock()
            .expect("selector perf lock")
            .armed
            .as_ref()
            .and_then(|armed| armed.native_window_size)
    }

    fn qa_state_summary(&self) -> String {
        let inner = self.inner.lock().expect("selector perf lock");
        let armed = inner
            .armed
            .as_ref()
            .map(|sample| format!("{:?}#{}", sample.action, sample.ordinal))
            .unwrap_or_else(|| "none".to_owned());
        let pending = inner
            .pending
            .as_ref()
            .map(|sample| format!("{:?}#{}", sample.action, sample.ordinal))
            .unwrap_or_else(|| "none".to_owned());
        format!("armed={armed} pending={pending}")
    }

    fn qa_arm_summary(&self, now: Instant) -> String {
        let inner = self.inner.lock().expect("selector perf lock");
        let Some(armed) = inner.armed.as_ref() else {
            return "none".to_owned();
        };
        let age_ms = now
            .saturating_duration_since(armed.expires_at - ARM_VALID_FOR)
            .as_millis();
        format!(
            "{:?}#{} age_ms={} expired={}",
            armed.action,
            armed.ordinal,
            age_ms,
            armed.expires_at <= now
        )
    }

    fn clear_pending_sample(&self, sample_id: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.sample_id == sample_id)
        {
            inner.pending = None;
        }
    }

    /// Report a native selector failure only to the explicitly opted-in QA
    /// session.  Production launches have no QA session and therefore never
    /// expose native diagnostics to the renderer.
    pub(crate) fn report_qa_error(&self, window: &WebviewWindow, error: &NativeError) {
        if self.qa_enabled() {
            let detail = format!(
                "pid={}; window=main; {}: {}",
                std::process::id(),
                error.code,
                error.message
            );
            if let Some(path) = std::env::var_os("IMAGEFORGE_NATIVE_SMOKE_RESULT") {
                let _ = fs::write(path, format!("FAIL\n{detail}\n"));
            }
            let _ = window.emit(QA_ERROR_EVENT, error);
            eprintln!("IMAGEFORGE_GPU_SELECTOR_PERF_QA_ERROR {detail}");
        }
    }

    pub(crate) fn trace_qa(&self, message: &str) {
        if self.qa_enabled() {
            eprintln!("IMAGEFORGE_GPU_SELECTOR_PERF_QA_TRACE {message}");
        }
    }

    fn qa_enabled(&self) -> bool {
        self.inner
            .lock()
            .expect("selector perf lock")
            .session
            .is_some()
    }

    /// Invalidate an in-flight sample when the native window loses the
    /// conditions required by the installed gate.  This is deliberately
    /// native-side; a renderer cannot rescue a backgrounded or resized sample.
    pub(crate) fn invalidate_native_sample(&self) {
        self.invalidate_native_sample_with_reason("direct");
    }

    pub(crate) fn invalidate_native_sample_with_reason(&self, reason: &str) {
        let (armed, pending) = {
            let mut inner = self.inner.lock().expect("selector perf lock");
            (inner.armed.take(), inner.pending.take())
        };
        let armed_summary = armed
            .as_ref()
            .map(|sample| format!("{:?}#{}", sample.action, sample.ordinal))
            .unwrap_or_else(|| "none".to_owned());
        let pending_summary = pending
            .as_ref()
            .map(|sample| format!("{:?}#{}", sample.action, sample.ordinal))
            .unwrap_or_else(|| "none".to_owned());
        self.trace_qa(&format!(
            "selector native sample invalidated reason={reason} lifecycle=window_event armed={armed_summary} pending={pending_summary}"
        ));
    }

    pub fn commit(
        &self,
        window: &WebviewWindow,
        input: GpuSelectorPerfCommitV1,
    ) -> NativeResult<GpuSelectorPerfSampleV1> {
        // Native input already authenticated the focused, visible window and
        // consumed the one-use arm before this renderer acknowledgement. The
        // WebView2 focus query can transiently report false while the click
        // opens the selector, so requiring focus again here would reject a
        // valid sample. Window lifecycle handlers still clear armed/pending
        // state on focus loss, resize, scale, and destroy; keep visibility and
        // exact native size checks at the commit boundary.
        require_main_visible(window)?;
        let native_window_size = native_window_size(window)?;
        let sample =
            self.commit_inner_with_native_size(input, Instant::now(), Some(native_window_size))?;
        self.record_sample(&sample)?;
        Ok(sample)
    }

    fn record_sample(&self, sample: &GpuSelectorPerfSampleV1) -> NativeResult<()> {
        let Some(path) = &self.sample_output else {
            return Ok(());
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| sample_output_failed())?;
        serde_json::to_writer(&mut file, sample).map_err(|_| sample_output_failed())?;
        file.write_all(b"\n").map_err(|_| sample_output_failed())?;
        file.sync_all().map_err(|_| sample_output_failed())?;
        Ok(())
    }

    fn arm_inner(
        &self,
        input: GpuSelectorPerfArmV1,
        now: Instant,
    ) -> NativeResult<GpuSelectorPerfArmResultV1> {
        self.arm_inner_with_native_size(input, now, None)
    }

    fn arm_inner_with_native_size(
        &self,
        input: GpuSelectorPerfArmV1,
        now: Instant,
        native_window_size: Option<NativeWindowSize>,
    ) -> NativeResult<GpuSelectorPerfArmResultV1> {
        validate_arm(&input)?;
        let mut inner = self.inner.lock().expect("selector perf lock");
        let session = inner.session.clone().ok_or_else(qa_disabled)?;
        if inner.pending.is_some() {
            return Err(NativeError::new(
                "gpu_selector_perf_busy",
                "A selector performance sample is already in progress.",
            ));
        }
        if inner
            .armed
            .as_ref()
            .is_some_and(|armed| armed.expires_at > now)
        {
            return Err(NativeError::new(
                "gpu_selector_perf_busy",
                "A selector performance action is already armed.",
            ));
        }
        inner.armed = Some(ArmedSample {
            action: input.action,
            ordinal: input.ordinal,
            viewport_width: input.viewport_width,
            viewport_height: input.viewport_height,
            native_window_size,
            expires_at: now + ARM_VALID_FOR,
        });
        Ok(GpuSelectorPerfArmResultV1 {
            schema_version: 1,
            armed: true,
            qa_session_id: session.qa_session_id,
        })
    }

    fn start_inner(
        &self,
        action: GpuSelectorPerfActionV1,
        viewport_width: u16,
        viewport_height: u16,
        now: Instant,
    ) -> NativeResult<GpuSelectorPerfStartedEventV1> {
        self.start_inner_with_native_size(action, viewport_width, viewport_height, now, None)
    }

    fn start_inner_with_native_size(
        &self,
        action: GpuSelectorPerfActionV1,
        viewport_width: u16,
        viewport_height: u16,
        now: Instant,
        native_window_size: Option<NativeWindowSize>,
    ) -> NativeResult<GpuSelectorPerfStartedEventV1> {
        let mut inner = self.inner.lock().expect("selector perf lock");
        let session = inner.session.clone().ok_or_else(qa_disabled)?;
        let armed = inner.armed.take().ok_or_else(|| {
            NativeError::new(
                "gpu_selector_perf_not_armed",
                "No selector performance action is armed.",
            )
        })?;
        if armed.expires_at <= now
            || armed.action != action
            || armed.viewport_width != viewport_width
            || armed.viewport_height != viewport_height
        {
            return Err(NativeError::new(
                "gpu_selector_perf_input_invalid",
                "The trusted selector input does not match the armed action.",
            ));
        }
        if armed.native_window_size != native_window_size {
            return Err(NativeError::new(
                "gpu_selector_perf_input_invalid",
                "The trusted selector input does not match the current native window.",
            ));
        }
        if inner.pending.is_some() {
            return Err(NativeError::new(
                "gpu_selector_perf_busy",
                "A selector performance sample is already in progress.",
            ));
        }
        let sample_id = Uuid::new_v4().to_string();
        inner.pending = Some(PendingSample {
            qa_session_id: session.qa_session_id.clone(),
            sample_id: sample_id.clone(),
            action,
            ordinal: armed.ordinal,
            viewport_width,
            viewport_height,
            native_window_size,
            started_at: now,
        });
        Ok(GpuSelectorPerfStartedEventV1 {
            schema_version: 1,
            event: QA_EVENT,
            qa_session_id: session.qa_session_id,
            sample_id,
            action,
            ordinal: armed.ordinal,
            viewport_width,
            viewport_height,
        })
    }

    fn start_native_inner(
        &self,
        input: NativeSelectorInputKind,
        now: Instant,
    ) -> NativeResult<Option<GpuSelectorPerfStartedEventV1>> {
        self.start_native_inner_with_native_size(input, now, None)
    }

    fn start_native_inner_with_native_size(
        &self,
        input: NativeSelectorInputKind,
        now: Instant,
        native_window_size: Option<NativeWindowSize>,
    ) -> NativeResult<Option<GpuSelectorPerfStartedEventV1>> {
        let mut inner = self.inner.lock().expect("selector perf lock");
        let session = inner.session.clone().ok_or_else(qa_disabled)?;
        let Some(armed) = inner.armed.as_ref() else {
            return Ok(None);
        };
        if armed.expires_at <= now {
            inner.armed = None;
            return Ok(None);
        }
        if armed.native_window_size != native_window_size {
            inner.armed = None;
            return Err(NativeError::new(
                "gpu_selector_perf_input_invalid",
                "The trusted selector input does not match the current native window.",
            ));
        }
        if !input.matches(armed.action) {
            return Ok(None);
        }
        if inner.pending.is_some() {
            return Err(NativeError::new(
                "gpu_selector_perf_busy",
                "A selector performance sample is already in progress.",
            ));
        }
        let armed = inner.armed.take().expect("armed sample checked above");
        let sample_id = Uuid::new_v4().to_string();
        inner.pending = Some(PendingSample {
            qa_session_id: session.qa_session_id.clone(),
            sample_id: sample_id.clone(),
            action: armed.action,
            ordinal: armed.ordinal,
            viewport_width: armed.viewport_width,
            viewport_height: armed.viewport_height,
            native_window_size,
            started_at: now,
        });
        Ok(Some(GpuSelectorPerfStartedEventV1 {
            schema_version: 1,
            event: QA_EVENT,
            qa_session_id: session.qa_session_id,
            sample_id,
            action: armed.action,
            ordinal: armed.ordinal,
            viewport_width: armed.viewport_width,
            viewport_height: armed.viewport_height,
        }))
    }

    fn commit_inner(
        &self,
        input: GpuSelectorPerfCommitV1,
        now: Instant,
    ) -> NativeResult<GpuSelectorPerfSampleV1> {
        self.commit_inner_with_native_size(input, now, None)
    }

    fn commit_inner_with_native_size(
        &self,
        input: GpuSelectorPerfCommitV1,
        now: Instant,
        native_window_size: Option<NativeWindowSize>,
    ) -> NativeResult<GpuSelectorPerfSampleV1> {
        if input.mounted_row_ids.len() != GPU_SELECTOR_PERF_ROW_IDS.len()
            || input
                .mounted_row_ids
                .iter()
                .map(String::as_str)
                .ne(GPU_SELECTOR_PERF_ROW_IDS.iter().copied())
        {
            return Err(NativeError::new(
                "gpu_selector_perf_rows_invalid",
                "The mounted selector row IDs do not match the QA fixture.",
            ));
        }
        let mut inner = self.inner.lock().expect("selector perf lock");
        let session = inner.session.clone().ok_or_else(qa_disabled)?;
        let pending = inner.pending.clone().ok_or_else(|| {
            NativeError::new(
                "gpu_selector_perf_sample_invalid",
                "The selector performance sample is missing or already committed.",
            )
        })?;
        if input.qa_session_id != pending.qa_session_id || input.sample_id != pending.sample_id {
            return Err(NativeError::new(
                "gpu_selector_perf_sample_invalid",
                "The selector performance sample binding is invalid.",
            ));
        }
        if pending.native_window_size != native_window_size {
            return Err(NativeError::new(
                "gpu_selector_perf_sample_invalid",
                "The selector performance window changed before commit.",
            ));
        }
        let duration_us = now
            .saturating_duration_since(pending.started_at)
            .as_micros() as u64;
        if duration_us == 0 || duration_us > MAX_DURATION_US {
            return Err(NativeError::new(
                "gpu_selector_perf_sample_invalid",
                "The selector performance duration is outside the safe range.",
            ));
        }
        // Consume only after every renderer-supplied binding and the native
        // duration pass. A stale/wrong commit must not destroy the one valid
        // sample that the harness can still complete.
        inner.pending = None;
        Ok(GpuSelectorPerfSampleV1 {
            schema_version: 1,
            sample_id: pending.sample_id,
            platform: session.platform,
            app_version: session.app_version,
            commit_sha: session.commit_sha,
            artifact_sha256: session.artifact_sha256,
            viewport_width: pending.viewport_width,
            viewport_height: pending.viewport_height,
            action: pending.action,
            ordinal: pending.ordinal,
            duration_us,
            mounted_gpu_rows: GPU_SELECTOR_PERF_ROW_IDS.len() as u8,
            mounted_row_ids_sha256: mounted_row_ids_sha256(),
        })
    }

    #[cfg(test)]
    fn arm_for_test(
        &self,
        input: GpuSelectorPerfArmV1,
    ) -> NativeResult<GpuSelectorPerfArmResultV1> {
        self.arm_inner(input, Instant::now())
    }

    #[cfg(test)]
    fn start_for_test(
        &self,
        action: GpuSelectorPerfActionV1,
        viewport_width: u16,
        viewport_height: u16,
    ) -> NativeResult<GpuSelectorPerfStartedEventV1> {
        self.start_inner(action, viewport_width, viewport_height, Instant::now())
    }

    #[cfg(test)]
    fn commit_for_test(
        &self,
        input: GpuSelectorPerfCommitV1,
    ) -> NativeResult<GpuSelectorPerfSampleV1> {
        std::thread::sleep(Duration::from_millis(1));
        self.commit_inner(input, Instant::now())
    }
}

fn native_window_size(window: &WebviewWindow) -> NativeResult<NativeWindowSize> {
    let size = window
        .inner_size()
        .map_err(|_| gpu_selector_perf_focus_required())?;
    if size.width == 0 || size.height == 0 {
        return Err(gpu_selector_perf_focus_required());
    }
    Ok((size.width, size.height))
}

fn require_main_foreground(window: &WebviewWindow) -> NativeResult<()> {
    require_main_visible(window)?;
    if !window
        .is_focused()
        .map_err(|_| gpu_selector_perf_focus_required())?
    {
        return Err(gpu_selector_perf_focus_required());
    }
    Ok(())
}

fn require_main_visible(window: &WebviewWindow) -> NativeResult<()> {
    if window.label() != "main"
        || !window
            .is_visible()
            .map_err(|_| gpu_selector_perf_focus_required())?
        || window
            .is_minimized()
            .map_err(|_| gpu_selector_perf_focus_required())?
    {
        return Err(gpu_selector_perf_focus_required());
    }
    Ok(())
}

fn gpu_selector_perf_focus_required() -> NativeError {
    NativeError::new(
        "gpu_selector_perf_focus_required",
        "The selector performance sample requires the focused main window.",
    )
}

fn gpu_selector_perf_event_failed() -> NativeError {
    NativeError::new(
        "gpu_selector_perf_event_failed",
        "The selector performance sample event could not be delivered.",
    )
}

fn qa_disabled() -> NativeError {
    NativeError::new(
        "gpu_selector_perf_qa_disabled",
        "Selector performance instrumentation is disabled outside the installed QA harness.",
    )
}

fn validate_arm(input: &GpuSelectorPerfArmV1) -> NativeResult<()> {
    if input.fixture_sha256 != FIXTURE_SHA256
        || !(1..=30).contains(&input.ordinal)
        || !valid_viewport(input.viewport_width, input.viewport_height)
    {
        return Err(NativeError::new(
            "gpu_selector_perf_arm_invalid",
            "The selector performance arm does not match the checked-in fixture.",
        ));
    }
    Ok(())
}

fn validate_session(session: &GpuSelectorPerfQaSessionV1) -> NativeResult<()> {
    if session.schema_version != 1
        || session.fixture_sha256 != FIXTURE_SHA256
        || session.window_label != "main"
        || session.platform != current_platform()
        || session.app_version.is_empty()
        || session.app_version.len() > 64
        || !session
            .app_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
        || !canonical_uuid_v4(&session.qa_session_id)
        || !lower_hex(&session.commit_sha, 40)
        || !lower_hex(&session.artifact_sha256, 64)
    {
        return Err(NativeError::new(
            "gpu_selector_perf_session_invalid",
            "The selector performance QA session is not bound to this artifact.",
        ));
    }
    Ok(())
}

fn valid_viewport(width: u16, height: u16) -> bool {
    matches!((width, height), (1280, 720) | (1440, 900))
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn canonical_uuid_v4(value: &str) -> bool {
    Uuid::parse_str(value).ok().is_some_and(|uuid| {
        uuid.to_string() == value && uuid.get_version() == Some(Version::Random)
    })
}

fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-arm64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

#[allow(dead_code)]
fn fixture_sha256() -> &'static str {
    FIXTURE_SHA256
}

#[allow(dead_code)]
fn checked_in_fixture_hash() -> String {
    let mut hasher = Sha256::new();
    hasher.update(include_bytes!(
        "../../../contracts/gpu-selector-perf-10-v1.json"
    ));
    format!("{:x}", hasher.finalize())
}

fn mounted_row_ids_sha256() -> String {
    let mut hasher = Sha256::new();
    let ordered = serde_json::to_string(&GPU_SELECTOR_PERF_ROW_IDS)
        .expect("selector performance row IDs are serializable");
    hasher.update(ordered.as_bytes());
    hasher.update(b"\n");
    format!("{:x}", hasher.finalize())
}

fn qa_sample_output_from_environment() -> NativeResult<Option<PathBuf>> {
    let Some(raw) = std::env::var_os("IMAGEFORGE_GPU_SELECTOR_PERF_QA_SAMPLES") else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(sample_output_failed());
    }
    let parent = path.parent().ok_or_else(sample_output_failed)?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| sample_output_failed())?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(sample_output_failed());
    }
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(sample_output_failed());
        }
    }
    Ok(Some(path))
}

fn reset_sample_output(path: &Path) -> NativeResult<()> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|_| sample_output_failed())?;
    file.sync_all().map_err(|_| sample_output_failed())
}

fn sample_output_failed() -> NativeError {
    NativeError::new(
        "gpu_selector_perf_sample_output_failed",
        "The installed selector performance sample output is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arm(action: GpuSelectorPerfActionV1) -> GpuSelectorPerfArmV1 {
        GpuSelectorPerfArmV1 {
            fixture_sha256: FIXTURE_SHA256.to_owned(),
            action,
            ordinal: 1,
            viewport_width: 1280,
            viewport_height: 720,
        }
    }

    fn rows() -> Vec<String> {
        GPU_SELECTOR_PERF_ROW_IDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    }

    #[test]
    fn disabled_host_rejects_arm_without_installed_session() {
        let host = GpuSelectorPerfHost::default();
        let error = host
            .arm_inner(arm(GpuSelectorPerfActionV1::ColdOpen), Instant::now())
            .unwrap_err();
        assert_eq!(error.code, "gpu_selector_perf_qa_disabled");
    }

    #[test]
    fn arm_requires_exact_fixture_viewport_and_ordinal() {
        let host = GpuSelectorPerfHost::for_test();
        let mut invalid = arm(GpuSelectorPerfActionV1::WarmOpen);
        invalid.fixture_sha256 = "0".repeat(64);
        assert_eq!(
            host.arm_for_test(invalid).unwrap_err().code,
            "gpu_selector_perf_arm_invalid"
        );

        let mut invalid = arm(GpuSelectorPerfActionV1::WarmOpen);
        invalid.ordinal = 31;
        assert_eq!(
            host.arm_for_test(invalid).unwrap_err().code,
            "gpu_selector_perf_arm_invalid"
        );

        let mut invalid = arm(GpuSelectorPerfActionV1::WarmOpen);
        invalid.viewport_height = 900;
        assert_eq!(
            host.arm_for_test(invalid).unwrap_err().code,
            "gpu_selector_perf_arm_invalid"
        );
    }

    #[test]
    fn trusted_input_generates_native_id_and_commit_is_one_shot() {
        let host = GpuSelectorPerfHost::for_test();
        host.arm_for_test(arm(GpuSelectorPerfActionV1::KeyboardMove))
            .unwrap();
        let started = host
            .start_for_test(GpuSelectorPerfActionV1::KeyboardMove, 1280, 720)
            .unwrap();
        assert!(canonical_uuid_v4(&started.sample_id));
        assert_eq!(started.event, QA_EVENT);

        let sample = host
            .commit_for_test(GpuSelectorPerfCommitV1 {
                qa_session_id: started.qa_session_id.clone(),
                sample_id: started.sample_id.clone(),
                mounted_row_ids: rows(),
            })
            .unwrap();
        assert_eq!(sample.duration_us >= 1, true);
        assert_eq!(sample.mounted_gpu_rows, 10);
        assert_eq!(sample.mounted_row_ids_sha256, MOUNTED_ROW_IDS_SHA256);
        let replay = host.commit_for_test(GpuSelectorPerfCommitV1 {
            qa_session_id: started.qa_session_id,
            sample_id: started.sample_id,
            mounted_row_ids: rows(),
        });
        assert_eq!(replay.unwrap_err().code, "gpu_selector_perf_sample_invalid");
    }

    #[test]
    fn native_hook_ignores_wrong_input_kind_then_starts_matching_action() {
        let host = GpuSelectorPerfHost::for_test();
        host.arm_for_test(arm(GpuSelectorPerfActionV1::KeyboardMove))
            .unwrap();
        assert!(host
            .start_native_inner(NativeSelectorInputKind::PrimaryMouseUp, Instant::now())
            .unwrap()
            .is_none());
        let started = host
            .start_native_inner(NativeSelectorInputKind::KeyboardMove, Instant::now())
            .unwrap()
            .expect("matching native key should start the sample");
        assert_eq!(started.action, GpuSelectorPerfActionV1::KeyboardMove);
    }

    #[test]
    fn native_window_size_change_invalidates_arm_and_pending_sample() {
        let host = GpuSelectorPerfHost::for_test();
        host.arm_inner_with_native_size(
            arm(GpuSelectorPerfActionV1::WarmOpen),
            Instant::now(),
            Some((1280, 720)),
        )
        .unwrap();
        let start = host
            .start_native_inner_with_native_size(
                NativeSelectorInputKind::PrimaryMouseUp,
                Instant::now(),
                Some((1440, 900)),
            )
            .unwrap_err();
        assert_eq!(start.code, "gpu_selector_perf_input_invalid");
        assert!(host
            .start_native_inner_with_native_size(
                NativeSelectorInputKind::PrimaryMouseUp,
                Instant::now(),
                Some((1280, 720)),
            )
            .unwrap()
            .is_none());

        host.arm_inner_with_native_size(
            arm(GpuSelectorPerfActionV1::WarmOpen),
            Instant::now(),
            Some((1280, 720)),
        )
        .unwrap();
        let started = host
            .start_native_inner_with_native_size(
                NativeSelectorInputKind::PrimaryMouseUp,
                Instant::now(),
                Some((1280, 720)),
            )
            .unwrap()
            .expect("matching native pointer should start the sample");
        let commit = host.commit_inner_with_native_size(
            GpuSelectorPerfCommitV1 {
                qa_session_id: started.qa_session_id.clone(),
                sample_id: started.sample_id.clone(),
                mounted_row_ids: rows(),
            },
            Instant::now() + Duration::from_millis(1),
            Some((1440, 900)),
        );
        assert_eq!(commit.unwrap_err().code, "gpu_selector_perf_sample_invalid");
        let committed = host
            .commit_inner_with_native_size(
                GpuSelectorPerfCommitV1 {
                    qa_session_id: started.qa_session_id,
                    sample_id: started.sample_id,
                    mounted_row_ids: rows(),
                },
                Instant::now() + Duration::from_millis(1),
                Some((1280, 720)),
            )
            .unwrap();
        assert!(committed.duration_us >= 1);
    }

    #[test]
    fn native_input_kind_is_action_exact() {
        assert!(
            NativeSelectorInputKind::KeyboardMove.matches(GpuSelectorPerfActionV1::KeyboardMove)
        );
        assert!(
            !NativeSelectorInputKind::KeyboardMove.matches(GpuSelectorPerfActionV1::KeyboardSelect)
        );
        assert!(NativeSelectorInputKind::KeyboardSelect
            .matches(GpuSelectorPerfActionV1::KeyboardSelect));
        assert!(
            !NativeSelectorInputKind::KeyboardSelect.matches(GpuSelectorPerfActionV1::KeyboardMove)
        );
        assert!(NativeSelectorInputKind::PrimaryMouseUp.matches(GpuSelectorPerfActionV1::ColdOpen));
        assert!(NativeSelectorInputKind::PrimaryMouseUp.matches(GpuSelectorPerfActionV1::WarmOpen));
        assert!(NativeSelectorInputKind::PrimaryMouseUp
            .matches(GpuSelectorPerfActionV1::RefreshLoading));
        assert!(
            !NativeSelectorInputKind::PrimaryMouseUp.matches(GpuSelectorPerfActionV1::KeyboardMove)
        );
    }

    #[test]
    fn warmup_input_event_is_native_pointer_only_and_session_bound() {
        let warm = GpuSelectorPerfHost::for_test_action(GpuSelectorPerfActionV1::WarmOpen);
        assert_eq!(
            warm.warmup_input_event(NativeSelectorInputKind::PrimaryMouseUp),
            Some(GpuSelectorPerfWarmupInputEventV1 {
                schema_version: 1,
                event: QA_WARMUP_INPUT_EVENT,
                input: "primary_mouse_up",
            })
        );
        assert!(warm
            .warmup_input_event(NativeSelectorInputKind::KeyboardSelect)
            .is_none());

        warm.arm_for_test(arm(GpuSelectorPerfActionV1::WarmOpen))
            .unwrap();
        assert!(warm
            .warmup_input_event(NativeSelectorInputKind::PrimaryMouseUp)
            .is_none());

        let cold = GpuSelectorPerfHost::for_test();
        assert!(cold
            .warmup_input_event(NativeSelectorInputKind::PrimaryMouseUp)
            .is_none());
    }

    #[test]
    fn native_window_invalidation_clears_armed_and_pending_samples() {
        let host = GpuSelectorPerfHost::for_test();
        host.arm_for_test(arm(GpuSelectorPerfActionV1::WarmOpen))
            .unwrap();
        host.invalidate_native_sample();
        assert!(host
            .start_native_inner(NativeSelectorInputKind::PrimaryMouseUp, Instant::now())
            .unwrap()
            .is_none());

        host.arm_for_test(arm(GpuSelectorPerfActionV1::WarmOpen))
            .unwrap();
        host.start_native_inner(NativeSelectorInputKind::PrimaryMouseUp, Instant::now())
            .unwrap()
            .expect("matching native pointer should start the sample");
        host.invalidate_native_sample();
        let commit = host.commit_inner(
            GpuSelectorPerfCommitV1 {
                qa_session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
                sample_id: "22222222-2222-4222-8222-222222222222".to_owned(),
                mounted_row_ids: rows(),
            },
            Instant::now(),
        );
        assert_eq!(commit.unwrap_err().code, "gpu_selector_perf_sample_invalid");
    }

    #[test]
    fn commit_rejects_wrong_row_order_without_returning_a_sample() {
        let host = GpuSelectorPerfHost::for_test();
        host.arm_for_test(arm(GpuSelectorPerfActionV1::KeyboardSelect))
            .unwrap();
        let started = host
            .start_for_test(GpuSelectorPerfActionV1::KeyboardSelect, 1280, 720)
            .unwrap();
        let mut wrong = rows();
        wrong.swap(0, 1);
        let error = host
            .commit_for_test(GpuSelectorPerfCommitV1 {
                qa_session_id: started.qa_session_id.clone(),
                sample_id: started.sample_id.clone(),
                mounted_row_ids: wrong,
            })
            .unwrap_err();
        assert_eq!(error.code, "gpu_selector_perf_rows_invalid");
        let sample = host
            .commit_for_test(GpuSelectorPerfCommitV1 {
                qa_session_id: started.qa_session_id,
                sample_id: started.sample_id,
                mounted_row_ids: rows(),
            })
            .unwrap();
        assert_eq!(sample.mounted_gpu_rows, 10);
    }

    #[test]
    fn checked_in_fixture_hash_matches_contract_constant() {
        assert_eq!(checked_in_fixture_hash(), FIXTURE_SHA256);
        assert_eq!(mounted_row_ids_sha256(), MOUNTED_ROW_IDS_SHA256);
    }
}
