"""抓取悬浮窗在屏幕上的实际画面，用于确认投影是否已消失。"""
import ctypes
import ctypes.wintypes as wt
import struct
import zlib
import sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

TITLE = "用量悬浮窗"
PAD = 44

hwnd = user32.FindWindowW(None, TITLE)
if not hwnd:
    print("WINDOW_NOT_FOUND")
    sys.exit(1)

rect = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
print("hwnd=%d rect=(%d,%d,%d,%d) size=%dx%d" % (
    hwnd, rect.left, rect.top, rect.right, rect.bottom,
    rect.right - rect.left, rect.bottom - rect.top))

x = max(rect.left - PAD, 0)
y = max(rect.top - PAD, 0)
w = (rect.right - rect.left) + PAD * 2
h = (rect.bottom - rect.top) + PAD * 2

hdc_screen = user32.GetDC(0)
hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
gdi32.SelectObject(hdc_mem, hbm)
SRCCOPY = 0x00CC0020
gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, SRCCOPY)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


bi = BITMAPINFOHEADER()
bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.biWidth = w
bi.biHeight = -h  # 负值 = 自上而下
bi.biPlanes = 1
bi.biBitCount = 32
bi.biCompression = 0

buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(hdc_mem, hbm, 0, h, buf, ctypes.byref(bi), 0)

raw = bytearray()
for row in range(h):
    start = row * w * 4
    line = buf[start:start + w * 4]
    raw.append(0)  # filter type 0
    for col in range(w):
        b, g, r = line[col * 4], line[col * 4 + 1], line[col * 4 + 2]
        raw += bytes((r, g, b))


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
png += chunk(b"IEND", b"")

out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
with open(out, "wb") as f:
    f.write(png)

gdi32.DeleteObject(hbm)
gdi32.DeleteDC(hdc_mem)
user32.ReleaseDC(0, hdc_screen)
print("saved", out, w, "x", h)
