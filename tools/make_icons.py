"""Erzeugt die App-Icons ohne externe Bibliotheken (eigener PNG-Writer).

    python tools/make_icons.py
"""

import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG   = (0x1e, 0x21, 0x28)
RING = (0x3c, 0x42, 0x4e)
RED  = (0xff, 0x4d, 0x4f)

SS = 3  # Kantenglaettung per Ueberabtastung


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def render(size):
    c = size / 2.0
    r_disc = size * 0.195
    r_ring_out = size * 0.335
    r_ring_in = size * 0.298

    rows = []
    step = 1.0 / SS
    offsets = [(i + 0.5) * step for i in range(SS)]
    total = SS * SS

    for y in range(size):
        row = bytearray()
        for x in range(size):
            hits_disc = 0
            hits_ring = 0
            for oy in offsets:
                dy = y + oy - c
                dy2 = dy * dy
                for ox in offsets:
                    dx = x + ox - c
                    d = math.sqrt(dx * dx + dy2)
                    if d <= r_disc:
                        hits_disc += 1
                    elif r_ring_in <= d <= r_ring_out:
                        hits_ring += 1

            a_disc = hits_disc / total
            a_ring = hits_ring / total
            for i in range(3):
                v = BG[i] * (1 - a_disc - a_ring) + RED[i] * a_disc + RING[i] * a_ring
                row.append(int(v + 0.5))
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    cache = {}
    targets = [
        ("icon-180.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("icon-maskable-512.png", 512),
    ]
    for name, size in targets:
        if size not in cache:
            cache[size] = render(size)
        path = os.path.join(OUT, name)
        write_png(path, size, size, cache[size])
        print(f"{name}  {size}x{size}  {os.path.getsize(path)} Bytes")


if __name__ == "__main__":
    main()
