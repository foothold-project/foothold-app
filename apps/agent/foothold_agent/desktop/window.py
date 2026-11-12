"""Raise the existing app window using OS libraries, without a new dependency."""
import ctypes as C
import os

TITLE = 'FOOTHOLD 로봇 연결'


def window_class(port):
    return 'foothold-robot-'+str(port)


def focus_existing(port):
    try:
        return _windows() if os.name == 'nt' else _x11(window_class(port))
    except (OSError, AttributeError):
        return False


def _windows():
    from ctypes import wintypes as W
    api = C.WinDLL('user32', use_last_error=True)
    callback = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    api.GetWindowTextW.argtypes = (W.HWND, W.LPWSTR, C.c_int)
    api.GetClassNameW.argtypes = (W.HWND, W.LPWSTR, C.c_int)
    api.ShowWindow.argtypes = (W.HWND, C.c_int)
    api.SetForegroundWindow.argtypes = (W.HWND,)
    api.EnumWindows.argtypes = (callback, W.LPARAM)
    found = []
    @callback
    def visit(handle, _):
        title, kind = C.create_unicode_buffer(1024), C.create_unicode_buffer(256)
        api.GetWindowTextW(handle, title, len(title))
        api.GetClassNameW(handle, kind, len(kind))
        if title.value == TITLE and kind.value == 'Chrome_WidgetWin_1':
            api.ShowWindow(handle, 9)  # SW_RESTORE, including minimized windows.
            api.SetForegroundWindow(handle)
            found.append(handle)
            return False
        return True
    api.EnumWindows(visit, 0)
    return bool(found)


def _x11(name):
    if not os.environ.get('DISPLAY'):
        return False
    api = C.CDLL('libX11.so.6')
    ulong, pointer = C.c_ulong, C.c_void_p
    api.XOpenDisplay.argtypes, api.XOpenDisplay.restype = (C.c_char_p,), pointer
    api.XDefaultRootWindow.argtypes, api.XDefaultRootWindow.restype = (pointer,), ulong
    api.XInternAtom.argtypes, api.XInternAtom.restype = (pointer, C.c_char_p, C.c_int), ulong
    api.XGetWindowProperty.argtypes = (pointer, ulong, ulong, C.c_long, C.c_long, C.c_int, ulong,
                                      C.POINTER(ulong), C.POINTER(C.c_int), C.POINTER(ulong),
                                      C.POINTER(ulong), C.POINTER(pointer))
    api.XFree.argtypes = (pointer,)
    api.XCloseDisplay.argtypes = (pointer,)
    api.XSetErrorHandler.argtypes, api.XSetErrorHandler.restype = (pointer,), pointer
    api.XMapRaised.argtypes = (pointer, ulong)
    api.XFlush.argtypes = (pointer,)
    class Hint(C.Structure):
        _fields_ = [('instance', pointer), ('name', pointer)]
    api.XGetClassHint.argtypes = (pointer, ulong, C.POINTER(Hint))
    class Message(C.Structure):
        _fields_ = [('type', C.c_int), ('serial', ulong), ('send_event', C.c_int),
                    ('display', pointer), ('window', ulong), ('message_type', ulong),
                    ('format', C.c_int), ('data', C.c_long*5)]
    class Event(C.Union):
        _fields_ = [('message', Message), ('padding', C.c_long*24)]
    api.XSendEvent.argtypes = (pointer, ulong, C.c_int, C.c_long, C.POINTER(Event))
    display = api.XOpenDisplay(None)
    if not display:
        return False
    # A window can close between enumeration and lookup; Xlib's default error
    # handler would otherwise terminate the connection program on BadWindow.
    error_handler = C.CFUNCTYPE(C.c_int, pointer, pointer)(lambda *_: 0)
    previous_handler = api.XSetErrorHandler(C.cast(error_handler, pointer))
    data = pointer()
    try:
        root = api.XDefaultRootWindow(display)
        atom = api.XInternAtom(display, b'_NET_CLIENT_LIST', False)
        actual, count, remaining, fmt = ulong(), ulong(), ulong(), C.c_int()
        if api.XGetWindowProperty(display, root, atom, 0, 65536, False, 0,
                                  C.byref(actual), C.byref(fmt), C.byref(count),
                                  C.byref(remaining), C.byref(data)) or fmt.value != 32 or not data:
            return False
        for handle in C.cast(data, C.POINTER(ulong))[:count.value]:
            hint = Hint()
            if not api.XGetClassHint(display, handle, C.byref(hint)):
                continue
            try:
                matches = any(value and C.string_at(value).decode(errors='replace') == name
                              for value in (hint.instance, hint.name))
            finally:
                for value in (hint.instance, hint.name):
                    if value:
                        api.XFree(value)
            if matches:
                event = Event()
                event.message.type, event.message.display, event.message.window = 33, display, handle
                event.message.message_type = api.XInternAtom(display, b'_NET_ACTIVE_WINDOW', False)
                event.message.format, event.message.data[0] = 32, 1
                api.XMapRaised(display, handle)
                api.XSendEvent(display, root, False, (1 << 20) | (1 << 19), C.byref(event))
                api.XFlush(display)
                return True
        return False
    finally:
        if data:
            api.XFree(data)
        api.XCloseDisplay(display)
        api.XSetErrorHandler(previous_handler)
