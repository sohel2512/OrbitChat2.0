"""Generate a small gradient PNG used by browser tests to exercise photo sending."""
import base64
import struct
import zlib

W, H = 480, 300

rows = bytearray()
for y in range(H):
    rows.append(0)  # filter: none
    for x in range(W):
        t = x / (W - 1)
        u = y / (H - 1)
        r = int(110 + 140 * t)
        g = int(90 + 110 * t * (1 - 0.35 * u))
        b = int(45 + 70 * (1 - u))
        rows += bytes((min(r, 255), min(g, 255), min(b, 255)))


def chunk(tag: bytes, data: bytes) -> bytes:
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
png += chunk(b'IEND', b'')

out = '/home/z/my-project/public/test-photo.png'
with open(out, 'wb') as f:
    f.write(png)
print(f'written {out} bytes={len(png)}')
