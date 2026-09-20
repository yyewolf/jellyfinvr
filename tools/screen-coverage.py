#!/usr/bin/env python3
"""How much of your vision the virtual screen actually fills.

Reads SCREEN_LAYOUTS / SEATS / THEATER straight out of the plugin source, so the
numbers here cannot drift away from what the renderer builds. Reproduces the
same placement maths the renderer does:

  * computeScreenLayout()  - height fixed, width follows the aspect up to maxWidth
  * bendAroundY()          - x -> r*sin(x/r), z += r*(1-cos(x/r)), arc length preserved
  * applySeat()            - seatRoot moves the room past a viewer the XR runtime owns,
                             so row N shifts the screen by N*rowDepth in z and N*riser in y

Coverage is a true solid angle: the screen is integrated as a surface,
  omega = || cos(theta) / d^2 dA
so the curve and the off-centre elevation are accounted for rather than assumed
away by a flat rectangle approximation.
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path

DEFAULT_SOURCE = Path(__file__).resolve().parent.parent / "Jellyfin supports plugins for VR.js"

# Reference fields of view, degrees (horizontal, vertical).
# Headset figures are the binocular field the optics present, not the panel's
# per-eye spec sheet number.
# Headset figures are the binocular field the optics present, not a panel spec.
# Vendors quote these loosely and they vary with face shape and eye relief, so
# treat them as approximate - they are here to be edited.
FIELDS = {
    "quest3": ("Quest 3 / 3S (pancake)", 110.0, 96.0),
    "quest2": ("Quest 2 (fresnel)", 97.0, 93.0),
    "frame": ("Steam Frame (pancake)", 110.0, 96.0),
    "index": ("Valve Index @ 130", 130.0, 105.0),
    "human-stereo": ("Human binocular overlap", 114.0, 130.0),
    "human-total": ("Human total field (both eyes)", 200.0, 130.0),
}

# Angular resolution the headset itself can resolve, pixels per degree, centre of
# field. A screen wider than the source can feed at this density looks soft no
# matter how good the file is, which is the real ceiling on screen size.
# Steam Frame is 2160x2160 per eye over roughly the same field as a Quest 3.
HEADSET_PPD = {"quest3": 25.0, "quest2": 20.0, "frame": 20.0, "index": 18.0}

# Per-eye source widths worth checking, in pixels.
SOURCE_WIDTHS = [1920, 2560, 3840]

# Real-world comparisons for the horizontal subtense, degrees.
BENCHMARKS = [
    (30.0, "SMPTE EG-18 minimum for cinema"),
    (36.0, "THX recommended / reference seat"),
    (40.0, "SMPTE preferred, front third of a cinema"),
    (54.0, "IMAX 70mm recommended minimum"),
    (70.0, "IMAX dome / front rows, fills peripheral vision"),
]


def strip_js_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def js_object(source, name):
    """Extract `const <name> = {...}` or `[...]` and parse it as JSON."""
    match = re.search(r"\bconst\s+" + re.escape(name) + r"\s*=\s*([\[{])", source)
    if not match:
        raise SystemExit(f"could not find `const {name}` in the plugin source")
    opener = match.group(1)
    closer = {"{": "}", "[": "]"}[opener]
    depth = 0
    start = match.end(1) - 1
    for index in range(start, len(source)):
        char = source[index]
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                body = source[start : index + 1]
                break
    else:
        raise SystemExit(f"unbalanced literal for `{name}`")
    body = strip_js_comments(body)
    body = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)\s*:", r'\1"\2":', body)  # quote bare keys
    body = re.sub(r"'([^']*)'", r'"\1"', body)  # single -> double quotes
    body = re.sub(r",\s*([}\]])", r"\1", body)  # trailing commas
    return json.loads(body)


def load_constants(path):
    source = strip_js_comments(path.read_text(encoding="utf-8"))
    eye_height = re.search(r"\bconst\s+EYE_HEIGHT\s*=\s*([\d.]+)", source)
    return {
        "SCREEN_LAYOUTS": js_object(source, "SCREEN_LAYOUTS"),
        "SEATS": js_object(source, "SEATS"),
        "THEATER": js_object(source, "THEATER"),
        "EYE_HEIGHT": float(eye_height.group(1)) if eye_height else 1.6,
    }


def screen_layout(preset, aspect):
    """Port of computeScreenLayout(): height is fixed, width gives way at maxWidth."""
    height = preset["height"]
    width = height * aspect
    if width > preset["maxWidth"]:
        width = preset["maxWidth"]
        height = width / aspect
    radius = preset["distance"] * preset["curveRatio"] if preset["curveRatio"] else 0.0
    return {
        "width": width,
        "height": height,
        "y": preset["centerY"],
        "z": -preset["distance"],
        "radius": radius,
    }


def seat_offset(row, theater):
    """Port of applySeat(): seatRoot.position = (0, -row*riser, -row*rowDepth)."""
    return {"y": -row * theater["riser"], "z": -row * theater["rowDepth"]}


def surface_point(u, v, layout, offset):
    """A point on the screen in eye-relative coordinates, plus its outward normal.

    u runs along the screen's arc from the centre, v runs up from the centre.
    Mirrors bendAroundY, which moves vertices only and leaves arc length alone.
    """
    y = layout["y"] + offset["y"] + v
    radius = layout["radius"]
    if radius:
        angle = u / radius
        x = radius * math.sin(angle)
        z = layout["z"] + offset["z"] + radius * (1.0 - math.cos(angle))
        normal = (-math.sin(angle), 0.0, math.cos(angle))
    else:
        x = u
        z = layout["z"] + offset["z"]
        normal = (0.0, 0.0, 1.0)
    return (x, y, z), normal


def solid_angle(layout, offset, samples=600):
    """omega = || cos(theta)/d^2 dA over the screen surface, by midpoint rule."""
    half_w = layout["width"] / 2.0
    half_h = layout["height"] / 2.0
    du = layout["width"] / samples
    dv = layout["height"] / samples
    patch = du * dv
    total = 0.0
    for i in range(samples):
        u = -half_w + (i + 0.5) * du
        for j in range(samples):
            v = -half_h + (j + 0.5) * dv
            (x, y, z), normal = surface_point(u, v, layout, offset)
            d2 = x * x + y * y + z * z
            if d2 <= 1e-9:
                continue
            d = math.sqrt(d2)
            # cos(theta) between the surface normal and the line back to the eye
            cos_theta = -(normal[0] * x + normal[1] * y + normal[2] * z) / d
            if cos_theta <= 0:
                continue
            total += cos_theta / d2 * patch
    return total


def field_solid_angle(h_deg, v_deg, samples=900):
    """Solid angle of an elliptical field of view centred on the forward axis."""
    h = math.radians(h_deg) / 2.0
    v = math.radians(v_deg) / 2.0
    total = 0.0
    d_az = 2 * h / samples
    d_el = 2 * v / samples
    for i in range(samples):
        az = -h + (i + 0.5) * d_az
        for j in range(samples):
            el = -v + (j + 0.5) * d_el
            if (az / h) ** 2 + (el / v) ** 2 > 1.0:
                continue
            total += math.cos(el) * d_az * d_el
    return total


def extents(layout, offset):
    """Horizontal and vertical angular extents in degrees, as seen from the eye."""
    half_w = layout["width"] / 2.0
    half_h = layout["height"] / 2.0
    edge, _ = surface_point(half_w, 0.0, layout, offset)
    horizontal = 2.0 * math.degrees(math.atan2(edge[0], -edge[2]))
    centre, _ = surface_point(0.0, 0.0, layout, offset)
    depth = -centre[2]
    top = math.degrees(math.atan2(centre[1] + half_h, depth))
    bottom = math.degrees(math.atan2(centre[1] - half_h, depth))
    return {
        "h": horizontal,
        "v": top - bottom,
        "top": top,
        "bottom": bottom,
        "centre_el": math.degrees(math.atan2(centre[1], depth)),
        "distance": depth,
        "corner_distance": math.sqrt(edge[0] ** 2 + (centre[1] + half_h) ** 2 + edge[2] ** 2),
    }


def benchmark_for(h_deg):
    label = "below cinema minimum"
    for threshold, text in BENCHMARKS:
        if h_deg >= threshold:
            label = text
    return label


def describe(name, layout, offset, fields, samples, headset_ppd, headset_label):
    ext = extents(layout, offset)
    omega = solid_angle(layout, offset, samples)
    lines = [
        f"  {name}",
        f"    screen        {layout['width']:.2f} m x {layout['height']:.2f} m"
        f"  ({layout['width'] * layout['height']:.0f} m^2"
        + (f", curved r={layout['radius']:.1f} m)" if layout["radius"] else ", flat)"),
        f"    throw         {ext['distance']:.2f} m to centre, {ext['corner_distance']:.2f} m to top corner",
        f"    subtense      {ext['h']:.1f} deg wide x {ext['v']:.1f} deg tall"
        f"   (top {ext['top']:+.1f} deg, bottom {ext['bottom']:+.1f} deg, centre {ext['centre_el']:+.1f} deg)",
        f"    solid angle   {omega:.3f} sr  ({omega / (4 * math.pi) * 100:.1f}% of the full sphere)",
        f"    cinema ref    {benchmark_for(ext['h'])}",
        "    sharpness     "
        + "  ".join(
            f"{w // 1000}.{w % 1000 // 100}k/eye {w / ext['h']:.0f} ppd"
            + ("*" if w / ext["h"] >= headset_ppd else " ")
            for w in SOURCE_WIDTHS
        )
        + f"  (* meets the {headset_label} ~{headset_ppd:.0f} ppd)",
        "    coverage",
    ]
    for key, (label, h_fov, v_fov) in fields.items():
        omega_field = field_solid_angle(h_fov, v_fov)
        lines.append(
            f"      {label:<32} {omega / omega_field * 100:5.1f}% of field"
            f"   ({min(ext['h'] / h_fov, 1.0) * 100:5.1f}% of width,"
            f" {min(ext['v'] / v_fov, 1.0) * 100:5.1f}% of height)"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="plugin .js to read constants from")
    parser.add_argument("--aspect", type=float, default=16 / 9, help="display aspect of one eye (default 16:9)")
    parser.add_argument("--samples", type=int, default=400, help="integration grid per axis")
    parser.add_argument("--field", action="append", choices=sorted(FIELDS), help="limit the reference fields shown")
    parser.add_argument("--headset", choices=sorted(HEADSET_PPD), default="quest3",
                        help="which headset's angular resolution to judge sharpness against")
    args = parser.parse_args()

    if not args.source.exists():
        sys.exit(f"plugin source not found: {args.source}")
    constants = load_constants(args.source)
    fields = {k: FIELDS[k] for k in (args.field or FIELDS)}

    headset_ppd = HEADSET_PPD[args.headset]
    headset_label = FIELDS[args.headset][0]
    ratio = f"{args.aspect:.3f}:1"
    print(f"Screen coverage - source {args.source.name}, one-eye aspect {ratio}, "
          f"sharpness judged against {headset_label}\n")

    void = screen_layout(constants["SCREEN_LAYOUTS"]["void"], args.aspect)
    print("VOID (no room, the plain cinema plane)")
    print(describe("fixed position", void, {"y": 0.0, "z": 0.0}, fields, args.samples,
                   headset_ppd, headset_label))
    print()

    theater_preset = constants["SCREEN_LAYOUTS"]["theater"]
    theater = screen_layout(theater_preset, args.aspect)
    print("THEATER (curved screen, seat rows move the room past you)")
    for seat in constants["SEATS"]:
        offset = seat_offset(seat["row"], constants["THEATER"])
        print(describe(f"{seat['label']:<5} (row {seat['row']:+d})", theater, offset, fields,
                       args.samples, headset_ppd, headset_label))
        print()


if __name__ == "__main__":
    main()
