#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

#define IMAGEFORGE_TRUSTED_INPUT_MAGIC 0x49464754u
#define IMAGEFORGE_TRUSTED_INPUT_VERSION 1u
#define IMAGEFORGE_TRUSTED_INPUT_MESSAGE (WM_APP + 0x4f)
#define IMAGEFORGE_TRUSTED_INPUT_EVENT_EMPTY 0
#define IMAGEFORGE_TRUSTED_INPUT_EVENT_WRITING 1
#define IMAGEFORGE_TRUSTED_INPUT_EVENT_READY 2
#define IMAGEFORGE_TRUSTED_INPUT_EVENT_POINTER 1u
#define IMAGEFORGE_TRUSTED_INPUT_EVENT_KEYBOARD_SELECT 2u

typedef struct ImageForgeTrustedInputConfig {
    uint32_t magic;
    uint32_t version;
    uintptr_t receiver_hwnd;
    uintptr_t expected_hwnd;
    volatile LONG active;
    volatile LONG event_state;
    volatile LONGLONG event_sequence;
    uintptr_t event_target;
    LONG event_x;
    LONG event_y;
    uint32_t event_kind;
} ImageForgeTrustedInputConfig;

static HANDLE config_mapping = NULL;
static ImageForgeTrustedInputConfig *config_view = NULL;

static int is_descendant(HWND expected, HWND candidate) {
    HWND current = candidate;
    for (int depth = 0; current != NULL && depth < 64; depth += 1) {
        if (current == expected) return 1;
        current = GetParent(current);
    }
    return IsChild(expected, candidate) != FALSE;
}

static int load_config(void) {
    if (config_view != NULL) return 1;

    wchar_t mapping_name[128];
    wsprintfW(mapping_name, L"Local\\ImageForgeTrustedInput-%lu", GetCurrentThreadId());
    config_mapping = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, mapping_name);
    if (config_mapping == NULL) return 0;
    config_view = (ImageForgeTrustedInputConfig *)MapViewOfFile(
        config_mapping,
        FILE_MAP_READ | FILE_MAP_WRITE,
        0,
        0,
        sizeof(ImageForgeTrustedInputConfig)
    );
    if (config_view == NULL) {
        CloseHandle(config_mapping);
        config_mapping = NULL;
        return 0;
    }
    return 1;
}

static int authorized_window_event(
    ImageForgeTrustedInputConfig *config,
    HWND expected,
    HWND receiver
) {
    return config->magic == IMAGEFORGE_TRUSTED_INPUT_MAGIC
        && config->version == IMAGEFORGE_TRUSTED_INPUT_VERSION
        && InterlockedCompareExchange((LONG *)&config->active, 0, 0) != 0
        && IsWindow(expected) != FALSE
        && IsWindowVisible(expected) != FALSE
        && IsIconic(expected) == FALSE
        && GetForegroundWindow() == expected
        && IsWindow(receiver) != FALSE;
}

static void publish_event(
    ImageForgeTrustedInputConfig *config,
    HWND receiver,
    uint32_t event_kind,
    uintptr_t event_target,
    LONG event_x,
    LONG event_y
) {
    if (InterlockedCompareExchange(
            &config->event_state,
            IMAGEFORGE_TRUSTED_INPUT_EVENT_WRITING,
            IMAGEFORGE_TRUSTED_INPUT_EVENT_EMPTY
        ) != IMAGEFORGE_TRUSTED_INPUT_EVENT_EMPTY) {
        return;
    }
    LONGLONG sequence = InterlockedIncrement64(&config->event_sequence);
    config->event_target = event_target;
    config->event_x = event_x;
    config->event_y = event_y;
    config->event_kind = event_kind;
    MemoryBarrier();
    InterlockedExchange(&config->event_state, IMAGEFORGE_TRUSTED_INPUT_EVENT_READY);
    // The message carries only the opaque one-use sequence. The host consumes
    // the hook-written payload from the shared slot after verifying it.
    if (!PostMessageW(receiver, IMAGEFORGE_TRUSTED_INPUT_MESSAGE, (WPARAM)sequence, 0)) {
        InterlockedExchange(&config->event_state, IMAGEFORGE_TRUSTED_INPUT_EVENT_EMPTY);
    }
}

__declspec(dllexport) LRESULT CALLBACK imageforge_trusted_mouse_hook(
    int code,
    WPARAM w_param,
    LPARAM l_param
) {
    if (code == HC_ACTION && load_config()) {
        ImageForgeTrustedInputConfig *config = config_view;
        HWND expected = (HWND)config->expected_hwnd;
        HWND receiver = (HWND)config->receiver_hwnd;
        if (w_param == WM_LBUTTONUP && l_param != 0) {
            MOUSEHOOKSTRUCT *event = (MOUSEHOOKSTRUCT *)l_param;
            HWND target = event->hwnd;
            if (authorized_window_event(config, expected, receiver)
                && IsWindow(target) != FALSE
                && IsWindowVisible(target) != FALSE
                && is_descendant(expected, target)) {
                publish_event(
                    config,
                    receiver,
                    IMAGEFORGE_TRUSTED_INPUT_EVENT_POINTER,
                    (uintptr_t)target,
                    event->pt.x,
                    event->pt.y
                );
            }
        } else if (w_param == VK_SPACE
            && l_param != 0
            && (((ULONG_PTR)l_param & 0x80000000u) == 0)
            && (((ULONG_PTR)l_param & 0x40000000u) == 0)
            && authorized_window_event(config, expected, receiver)) {
            // WH_KEYBOARD runs on the exact WebView2 browser UI thread. Space
            // is delivered to the DOM but is not consistently surfaced by
            // WebView2's AcceleratorKeyPressed event, so publish its first
            // native keydown through the same one-use authenticated slot.
            publish_event(
                config,
                receiver,
                IMAGEFORGE_TRUSTED_INPUT_EVENT_KEYBOARD_SELECT,
                0,
                0,
                0
            );
        }
    }
    return CallNextHookEx(NULL, code, w_param, l_param);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;
    if (reason == DLL_PROCESS_DETACH) {
        if (config_view != NULL) {
            UnmapViewOfFile(config_view);
            config_view = NULL;
        }
        if (config_mapping != NULL) {
            CloseHandle(config_mapping);
            config_mapping = NULL;
        }
    } else if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}
