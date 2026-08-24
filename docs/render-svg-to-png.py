#!/usr/bin/env python3
"""Render an SVG to PNG with the system librsvg/cairo libraries.

The project image contains the shared libraries but not the rsvg-convert binary.  Keeping this
small bridge beside the presentation generator makes the PDF reproducible without downloading a
browser or an image package.
"""

from __future__ import annotations

import ctypes
import sys


class Dimensions(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("em", ctypes.c_double),
        ("ex", ctypes.c_double),
    ]


def main() -> None:
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: render-svg-to-png.py INPUT.svg OUTPUT.png [WIDTH]")

    source, target = sys.argv[1], sys.argv[2]
    output_width = int(sys.argv[3]) if len(sys.argv) == 4 else 1123

    rsvg = ctypes.CDLL("/lib/x86_64-linux-gnu/librsvg-2.so.2")
    cairo = ctypes.CDLL("/lib/x86_64-linux-gnu/libcairo.so.2")
    gobject = ctypes.CDLL("/lib/x86_64-linux-gnu/libgobject-2.0.so.0")

    rsvg.rsvg_handle_new_from_file.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    rsvg.rsvg_handle_new_from_file.restype = ctypes.c_void_p
    rsvg.rsvg_handle_get_dimensions.argtypes = [ctypes.c_void_p, ctypes.POINTER(Dimensions)]
    rsvg.rsvg_handle_render_cairo.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    rsvg.rsvg_handle_render_cairo.restype = ctypes.c_int

    cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    cairo.cairo_image_surface_create.restype = ctypes.c_void_p
    cairo.cairo_create.argtypes = [ctypes.c_void_p]
    cairo.cairo_create.restype = ctypes.c_void_p
    cairo.cairo_scale.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]
    cairo.cairo_surface_write_to_png.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_surface_write_to_png.restype = ctypes.c_int
    cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]
    gobject.g_object_unref.argtypes = [ctypes.c_void_p]

    handle = rsvg.rsvg_handle_new_from_file(source.encode(), None)
    if not handle:
        raise SystemExit(f"cannot load SVG: {source}")

    dimensions = Dimensions()
    rsvg.rsvg_handle_get_dimensions(handle, ctypes.byref(dimensions))
    output_height = round(output_width * dimensions.height / dimensions.width)

    # CAIRO_FORMAT_ARGB32 = 0. Every generated page includes its own opaque white background.
    surface = cairo.cairo_image_surface_create(0, output_width, output_height)
    context = cairo.cairo_create(surface)
    cairo.cairo_scale(
        context,
        output_width / dimensions.width,
        output_height / dimensions.height,
    )
    rendered = rsvg.rsvg_handle_render_cairo(handle, context)
    status = cairo.cairo_surface_write_to_png(surface, target.encode())

    cairo.cairo_destroy(context)
    cairo.cairo_surface_destroy(surface)
    gobject.g_object_unref(handle)

    if not rendered or status != 0:
        raise SystemExit(f"render failed: rsvg={rendered}, cairo={status}")


if __name__ == "__main__":
    main()
