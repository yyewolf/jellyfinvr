#!/usr/bin/env python3
"""Generate a suite of test clips for the Jellyfin VR plugin.

Every clip is drawn procedurally - no assets - and encoded with ffmpeg. Each one
is named so the plugin's own auto-detection (PROJECTION_TOKENS / STEREO_TOKENS /
LENS_TOKEN in the plugin source) picks the right mode from the filename, which
means dropping them into a Jellyfin library also tests the detection table.

The clips are a guided tour: the picture carries a scripted checklist that tells
you which control to press and what you should see when you do, so one pass
through the tour clip exercises the whole feature set.

    python3 tools/make-test-video.py --out ~/media/jvr-tests
    python3 tools/make-test-video.py --list
    python3 tools/make-test-video.py --only theater --step-seconds 6
    python3 tools/make-test-video.py --only vr180-sbs --preview 3   # PNG, no ffmpeg

Requires ffmpeg on PATH (Arch: sudo pacman -S ffmpeg) and Pillow.
"""

import argparse
import math
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: pip install --user Pillow")

# --- palette -----------------------------------------------------------------

BG = (18, 20, 24)
GRID = (92, 104, 118)
GRID_MAJOR = (176, 190, 205)
ACCENT = (0, 168, 232)
WARN = (236, 84, 92)
OK = (86, 208, 128)
EDGE = (232, 0, 168)
TEXT = (238, 244, 250)
DIM = (140, 152, 166)

# Each drawn area is either static (painted once into the base image) or dynamic
# (cleared and repainted every frame). Dynamic zones are fractions of the eye
# image, so nothing moving ever overlaps something static and the base can be
# reused frame to frame.
ZONE_SWEEP = (0.00, 0.105, 1.00, 0.165)
ZONE_STEP = (0.06, 0.615, 0.94, 0.790)
ZONE_CLOCK = (0.06, 0.800, 0.94, 0.895)

# On a sphere the layout is in degrees, not fractions: the readable band is the
# front of the horizon, and a panel has to subtend a sane angle whether the file
# covers 180 or 360 degrees of longitude.
SPHERE_SPAN = 38.0
SPHERE_LAT = {
    "badge": 42.0, "sweep": (24.0, 18.0), "targets": 10.0, "cardinal": -5.0,
    "step": (-9.0, -31.0), "clock": (-34.0, -47.0),
    "burst": (-50.0, -58.0), "wedge": (-62.0, -70.0),
}

FONT_CANDIDATES = [
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/LiberationSans-Bold.ttf",
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
]
_FONTS = {}


def font(size):
    size = max(8, int(size))
    if size not in _FONTS:
        for path in FONT_CANDIDATES:
            if Path(path).exists():
                _FONTS[size] = ImageFont.truetype(path, size)
                break
        else:
            # Pillow >= 10.1 ships a scalable default; older ones give a fixed 11px.
            try:
                _FONTS[size] = ImageFont.load_default(size=size)
            except TypeError:
                _FONTS[size] = ImageFont.load_default()
    return _FONTS[size]


def text_at(draw, xy, message, size, fill=TEXT, anchor="la"):
    draw.text(xy, message, font=font(size), fill=fill, anchor=anchor)


def wrap(draw, message, size, max_width):
    face = font(size)
    words, lines, line = message.split(), [], ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=face) <= max_width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


# --- clip definitions --------------------------------------------------------

# Every tour is a list of (heading, instruction). One step is shown at a time,
# for --step-seconds each, so the clip length follows the checklist.
TOUR_THEATER = [
    ("TEST CARD", "Flat 2D reference. The centre circle must be round, the grid square, "
                  "and all 16 grey steps distinct. The curved screen bows the grid slightly: that is the 2.2x curve."),
    ("EDGES", "Magenta corner marks must all be visible and none cut off. If an edge is missing, "
              "the screen UVs are cropping the picture."),
    ("PANEL", "Squeeze GRIP to toggle the control panel. Row 1 must read FLAT and MONO."),
    ("ROOM ON", "Press ENVIRONMENT until it reads THEATER. The auditorium builds and the projection "
                "snaps to FLAT. The screen grows to 15.6 x 8.8 m."),
    ("SEAT FRONT", "Press SEAT until FRONT. Throw 8.1 m, picture 95 deg wide, top edge 37 deg up. "
                   "Your row's seats must be empty and the tread under you flat."),
    ("SEAT CLOSE", "SEAT -> CLOSE. Throw 10.6 m, 78 deg wide. The room should move, not rescale."),
    ("SEAT MID", "SEAT -> MID. Throw 13.1 m, 65 deg wide, screen centre at eye level. This is the default."),
    ("SEAT BACK", "SEAT -> BACK. Throw 16.9 m, 52 deg wide. You are now looking slightly down at the screen."),
    ("LIGHTS", "Cycle LIGHTS: OUT, LOW, HALF, FULL. Walls, seats and carpet must lift together; "
               "the picture's own brightness must not change."),
    ("ROOM DETAIL", "Look around. Raked floor, 300+ seats, aisle markers on the treads, wall sconces, "
                    "EXIT signs, booth ports behind you. Nothing should be floating or z-fighting."),
    ("DEPTH", "In a room, both eyes see the same geometry. Seat backs in front of you should have real "
              "depth. Close one eye, then the other: the room must not shift."),
    ("PAN", "Trigger-drag on empty space. Yaw only, and the horizon must stay level: pitch is clamped "
            "while a room is up."),
    ("SCRUB", "Hold the trigger on the panel timeline and scrub. The sweeping bar and the timecode "
              "below must agree with where you drop it."),
    ("STICK", "Thumbstick left/right = -10 s / +10 s, repeating. Button 4 = play/pause. "
              "Button 5 = panel. Thumbstick click = recentre."),
    ("AV SYNC", "The corner flash and the beep must land together. A visible offset means audio "
                "and video have drifted."),
    ("SOURCE", "Press SOURCE to switch to H264. The transcode restarts at this position: "
               "playback should resume within a second or two, at the same timecode."),
    ("QUALITY", "Cycle QUALITY down to 720 and watch the resolution wedges go soft, then back to MAX. "
                "Each change restarts the compat stream."),
    ("VOID", "ENVIRONMENT -> VOID. The room vanishes and the screen drops to 7.2 x 4.05 m at 4.5 m: "
             "77 deg wide, wider than MID but with nothing around it."),
    ("RESET", "Hold GRIP for 1.2 s to RESET ALL. Panel back to its home position, view recentred."),
    ("EXIT", "EXIT VR. Jellyfin's own player must resume at this timecode, unmuted, "
             "and the watch progress must have been reported."),
]

TOUR_FLAT_3D = [
    ("STEREO CHECK", "Close your right eye: you should see only L. Close your left: only R. "
                     "If you see both, the eye layers are not splitting."),
    ("GEOMETRY", "The circle must be round. If it is an oval, the half-packing was misread and the "
                 "picture is anamorphic."),
    ("DEPTH", "NEAR floats in front of the screen, SCREEN sits on it, FAR sits behind. "
              "If that order is reversed, press SWAP EYES."),
    ("ROOM", "ENVIRONMENT -> THEATER. 3D on a curved cinema screen. Check the depth targets again: "
             "the curve must not change their order."),
    ("SEATS", "Cycle the seats. Stereo separation is baked into the UVs, so depth must hold at every row."),
]

TOUR_SPHERE = [
    ("HORIZON", "The horizon line must be dead straight and at eye level all the way round. "
                "A wavy or tilted horizon means the projection is wrong."),
    ("FRONT", "FRONT must be straight ahead after a recentre. RIGHT, BACK and LEFT at 90 deg steps."),
    ("CIRCLES", "The white circles are true spherical circles. They must look round in the headset, "
                "not egg-shaped, at every latitude including near the poles."),
    ("POLES", "Look straight up and straight down. ZENITH and NADIR must converge to a point "
              "with no pinching or tearing."),
    ("STEREO", "Close one eye at a time for the L / R labels, then check the depth targets ahead of you."),
    ("PANEL", "The panel and its laser must stay readable against the sphere. "
              "LIGHTS and SEAT must be greyed out: there is no room in a sphere."),
]

TOUR_FISHEYE = [
    ("RINGS", "Rings are every 15 deg from the lens axis. The 90 deg ring is the edge of a 180 deg lens, "
              "95 deg is a 190 lens, 100 deg is a 200 lens."),
    ("KNOWN GAP", "The plugin's fisheye shader has no FOV parameter, so 190/200 deg content is not "
                  "undistorted correctly. Expect the outer rings to be wrong; the centre should be close."),
    ("SPACING", "With a correct equidistant mapping the rings are evenly spaced. "
                "Bunching towards the edge is the error above."),
    ("STEREO", "L / R labels and the depth targets, as in the other stereo clips."),
]

TOUR_DETECTION = [
    ("DETECTION", "This file carries NO mode markers in its name. The plugin must fall back to the "
                  "aspect-ratio rules and land on 180 / SBS from the 2:1 frame."),
    ("OVERRIDE", "Change the mode by hand on the panel. Close the player and reopen it: "
                 "your choice must come back from localStorage, not the aspect guess."),
]


class Clip:
    def __init__(self, key, filename, tour, eye_w, eye_h, projection,
                 stereo="mono", packing="full", fov=180.0, swap=False, note=""):
        self.key = key
        self.filename = filename
        self.tour = tour
        self.eye_w = eye_w
        self.eye_h = eye_h
        self.projection = projection
        self.stereo = stereo
        self.packing = packing
        self.fov = fov
        self.swap = swap
        self.note = note

    @property
    def frame_size(self):
        """Encoded frame size. Half packing squeezes both eyes into one frame."""
        if self.stereo == "mono":
            return self.eye_w, self.eye_h
        if self.stereo == "sbs":
            return (self.eye_w, self.eye_h) if self.packing == "half" else (self.eye_w * 2, self.eye_h)
        return (self.eye_w, self.eye_h) if self.packing == "half" else (self.eye_w, self.eye_h * 2)

    @property
    def eyes(self):
        return (0,) if self.stereo == "mono" else (0, 1)


# Filenames are the detection test: each one is tokenised by the plugin on
# non-alphanumerics, so `vr180` -> 180, `hsbs` -> sbs, `mkx200` -> fisheye,
# `rl` -> sbs + swapped eyes. `unlabelled` deliberately carries nothing.
CLIPS = [
    Clip("theater", "JVR Test 01 - Theater Tour (2D)", TOUR_THEATER,
         1920, 1080, "flat", note="the main tour; flat 2D, detected from the 16:9 aspect"),
    Clip("flat-hsbs", "JVR Test 02 - Flat 3D HSBS", TOUR_FLAT_3D,
         1920, 1080, "flat", stereo="sbs", packing="half", note="half-SBS 3D movie on the cinema screen"),
    Clip("flat-htb", "JVR Test 03 - Flat 3D HTB", TOUR_FLAT_3D,
         1920, 1080, "flat", stereo="ou", packing="half", note="half-OU 3D movie"),
    Clip("vr180-sbs", "JVR Test 04 - VR180 SBS", TOUR_SPHERE,
         1920, 1920, "180", stereo="sbs", note="full-SBS VR180, 2:1 frame"),
    Clip("vr180-tb", "JVR Test 05 - VR180 TB", TOUR_SPHERE,
         1920, 1920, "180", stereo="ou", note="full-OU VR180, 1:2 frame"),
    Clip("vr360-mono", "JVR Test 06 - VR360 Mono", TOUR_SPHERE,
         3840, 1920, "360", note="monoscopic 360; the name has to beat the 2:1 aspect rule"),
    Clip("vr360-tb", "JVR Test 07 - VR360 TB", TOUR_SPHERE,
         3840, 1920, "360", stereo="ou", note="over-under 360, square frame"),
    Clip("fisheye", "JVR Test 08 - Fisheye MKX200 SBS", TOUR_FISHEYE,
         1920, 1920, "fisheye", stereo="sbs", fov=200.0, note="lens profile drives fisheye detection"),
    Clip("swap", "JVR Test 09 - VR180 SBS RL", TOUR_SPHERE,
         1920, 1920, "180", stereo="sbs", swap=True,
         note="eyes deliberately swapped in the file; _RL must correct them"),
    Clip("unlabelled", "JVR Test 10 - Unlabelled", TOUR_DETECTION,
         1920, 1920, "180", stereo="sbs", note="no markers: exercises the aspect-ratio fallback"),
]


# --- shared test-card elements ----------------------------------------------

def box_px(zone, w, h):
    x0, y0, x1, y1 = zone
    return [int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)]


def zones(clip, w, h):
    """Pixel rectangles that get cleared and repainted every frame.

    Placement differs per projection: on a sphere the readable area is the front
    of the horizon, not the middle of the image.
    """
    if clip.projection == "flat":
        return {
            "sweep": box_px(ZONE_SWEEP, w, h),
            "step": box_px(ZONE_STEP, w, h),
            "clock": box_px(ZONE_CLOCK, w, h),
        }
    if clip.projection == "fisheye":
        return {
            "sweep": [int(w * 0.20), int(h * 0.20), int(w * 0.80), int(h * 0.245)],
            "step": [int(w * 0.18), int(h * 0.58), int(w * 0.82), int(h * 0.70)],
            "clock": [int(w * 0.24), int(h * 0.715), int(w * 0.76), int(h * 0.775)],
        }
    left = eq_x(-SPHERE_SPAN, w, clip.fov)
    right = eq_x(SPHERE_SPAN, w, clip.fov)
    return {
        key: [left, eq_y(SPHERE_LAT[key][0], h), right, eq_y(SPHERE_LAT[key][1], h)]
        for key in ("sweep", "step", "clock")
    }


def draw_edges(draw, w, h):
    """Markers hard against the frame boundary: anything missing is cropped."""
    draw.rectangle([0, 0, w - 1, h - 1], outline=EDGE, width=max(2, w // 480))
    arm = int(min(w, h) * 0.07)
    thick = max(3, w // 320)
    for cx, cy, dx, dy, label, anchor in (
        (0, 0, 1, 1, "TL", "la"), (w - 1, 0, -1, 1, "TR", "ra"),
        (0, h - 1, 1, -1, "BL", "ld"), (w - 1, h - 1, -1, -1, "BR", "rd"),
    ):
        draw.line([cx, cy, cx + dx * arm, cy], fill=EDGE, width=thick)
        draw.line([cx, cy, cx, cy + dy * arm], fill=EDGE, width=thick)
        text_at(draw, (cx + dx * int(arm * 0.28), cy + dy * int(arm * 0.28)),
                label, min(w, h) * 0.022, EDGE, anchor=anchor)
    # Mid-edge ticks give you an alignment reference for the curved screen.
    for x in (w // 2,):
        draw.line([x, 0, x, arm // 2], fill=EDGE, width=thick)
        draw.line([x, h - 1, x, h - 1 - arm // 2], fill=EDGE, width=thick)
    for y in (h // 2,):
        draw.line([0, y, arm // 2, y], fill=EDGE, width=thick)
        draw.line([w - 1, y, w - 1 - arm // 2, y], fill=EDGE, width=thick)


def draw_colour_bars(draw, box):
    x0, y0, x1, y1 = box
    bars = [(192, 192, 192), (192, 192, 0), (0, 192, 192), (0, 192, 0),
            (192, 0, 192), (192, 0, 0), (0, 0, 192), (16, 16, 16)]
    step = (x1 - x0) / len(bars)
    for index, colour in enumerate(bars):
        draw.rectangle([x0 + index * step, y0, x0 + (index + 1) * step, y1], fill=colour)


def draw_grey_wedge(draw, box, size):
    """16 steps: any two that merge mean the video is being crushed or banded."""
    x0, y0, x1, y1 = box
    steps = 16
    step = (x1 - x0) / steps
    for index in range(steps):
        value = int(round(255 * index / (steps - 1)))
        draw.rectangle([x0 + index * step, y0, x0 + (index + 1) * step, y1], fill=(value,) * 3)
        text_at(draw, (x0 + (index + 0.5) * step, y0 + size * 0.25), str(index),
                size * 0.75, (0, 0, 0) if value > 128 else (255, 255, 255), anchor="ma")


def draw_multiburst(draw, box, size):
    """Alternating bars at 1, 2, 3, 4, 6 and 8 px. The finest pitch you can still
    resolve tells you what the transcode and the headset are actually delivering."""
    x0, y0, x1, y1 = box
    height = y1 - y0
    label_h = min(max(size, height * 0.22), height * 0.34)
    size = min(size, label_h * 0.95)
    top, bottom = y0 + height * 0.08, y1 - label_h
    pitches = [1, 2, 3, 4, 6, 8]
    width = (x1 - x0) / len(pitches)
    for index, pitch in enumerate(pitches):
        bx = x0 + index * width
        draw.rectangle([bx, y0, bx + width - 2, y1], fill=(24, 24, 24))
        x = bx + 4
        while x < bx + width - 6:
            draw.rectangle([x, top, x + pitch - 1, bottom], fill=(235, 235, 235))
            x += pitch * 2
        text_at(draw, (bx + width / 2, y1), f"{pitch}px", size * 0.8, DIM, anchor="md")


def draw_checkerboard(draw, cx, cy, side, cell=1):
    """A 1px checkerboard reads as flat grey the moment anything resamples it."""
    half = side // 2
    for y in range(cy - half, cy + half, cell):
        for x in range(cx - half, cx + half, cell):
            if ((x - cx + half) // cell + (y - cy + half) // cell) % 2 == 0:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(240, 240, 240))
            else:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(12, 12, 12))


def draw_depth_targets(draw, cx, cy, size, eye, disparity):
    """Three targets at crossed, zero and uncrossed disparity.

    Near objects carry crossed disparity: the left eye sees them further right.
    If NEAR reads as the furthest of the three, the eyes are swapped.
    """
    sign = 1 if eye == 0 else -1
    targets = [("NEAR", -1, OK), ("SCREEN", 0, TEXT), ("FAR", 1, ACCENT)]
    spacing = size * 3.2
    for index, (label, depth, colour) in enumerate(targets):
        ox = cx + (index - 1) * spacing - depth * disparity * sign
        draw.rectangle([ox - size / 2, cy - size / 2, ox + size / 2, cy + size / 2],
                       outline=colour, width=max(2, int(size * 0.09)))
        draw.line([ox - size * 0.3, cy, ox + size * 0.3, cy], fill=colour, width=max(2, int(size * 0.06)))
        text_at(draw, (ox, cy + size * 0.75), label, size * 0.36, colour, anchor="ma")


def draw_eye_badge(draw, w, h, eye, clip, cx=None, cy=None, radius=None):
    label = "L" if eye == 0 else "R"
    colour = OK if eye == 0 else WARN
    size = radius if radius is not None else min(w, h) * 0.06
    cx = cx if cx is not None else w * 0.5
    cy = cy if cy is not None else h * 0.255
    draw.ellipse([cx - size, cy - size, cx + size, cy + size], outline=colour, width=max(3, int(size * 0.12)))
    text_at(draw, (cx, cy), label, size * 1.25, colour, anchor="mm")
    note = "LEFT EYE" if eye == 0 else "RIGHT EYE"
    if clip.swap:
        note += " (packed swapped)"
    text_at(draw, (cx, cy + size * 1.35), note, size * 0.32, colour, anchor="ma")


# --- equirectangular helpers -------------------------------------------------

def eq_x(lon, w, fov):
    return (lon + fov / 2.0) / fov * w


def eq_y(lat, h):
    return (90.0 - lat) / 180.0 * h


def spherical_circle(lon0, lat0, radius_deg, steps=180):
    """A true circle on the sphere, as (lon, lat) points.

    Drawn in equirect it comes out distorted - increasingly so towards the poles
    - which is the point: in the headset it must come back to a round circle.
    """
    lon0, lat0, rho = map(math.radians, (lon0, lat0, radius_deg))
    points = []
    for index in range(steps + 1):
        bearing = 2 * math.pi * index / steps
        lat = math.asin(math.sin(lat0) * math.cos(rho) +
                        math.cos(lat0) * math.sin(rho) * math.cos(bearing))
        lon = lon0 + math.atan2(math.sin(bearing) * math.sin(rho) * math.cos(lat0),
                                math.cos(rho) - math.sin(lat0) * math.sin(lat))
        points.append((math.degrees(lon), math.degrees(lat)))
    return points


def draw_polyline(draw, points, w, h, fov, fill, width):
    """Draws a (lon, lat) polyline, splitting it where it wraps off the frame."""
    run = []
    for lon, lat in points:
        lon = (lon + 180.0) % 360.0 - 180.0
        if abs(lon) > fov / 2.0 + 1e-6:
            if len(run) > 1:
                draw.line(run, fill=fill, width=width)
            run = []
            continue
        x, y = eq_x(lon, w, fov), eq_y(lat, h)
        if run and abs(x - run[-1][0]) > w * 0.5:
            if len(run) > 1:
                draw.line(run, fill=fill, width=width)
            run = []
        run.append((x, y))
    if len(run) > 1:
        draw.line(run, fill=fill, width=width)


def draw_sphere_base(img, clip, eye):
    """Equirectangular grid. All our sphere clips are proportional (the frame is
    fov x 180 degrees), so one pixels-per-degree scale drives the whole layout."""
    w, h = img.size
    draw = ImageDraw.Draw(img)
    fov = 360.0 if clip.projection == "360" else 180.0
    ppd = h / 180.0
    thin = max(1, w // 1400)
    thick = max(3, w // 500)

    def at(lon, lat):
        return eq_x(lon, w, fov), eq_y(lat, h)

    # A sky-to-floor ramp so up and down are obvious even before the grid reads.
    for row in range(h):
        blend = 1.0 - row / h
        draw.line([0, row, w, row],
                  fill=(int(14 + 26 * blend), int(16 + 30 * blend), int(24 + 44 * blend)))

    for lat in range(-75, 76, 15):
        draw_polyline(draw, [(lon, lat) for lon in range(-180, 181, 2)], w, h, fov,
                      GRID_MAJOR if lat == 0 else GRID, thick if lat == 0 else thin)
    for lon in range(-180, 181, 15):
        if abs(lon) > fov / 2.0:
            continue
        major = lon % 90 == 0
        draw_polyline(draw, [(lon, lat / 2.0) for lat in range(-178, 179)], w, h, fov,
                      GRID_MAJOR if major else GRID, thick if major else thin)

    # Cardinal labels sit just under the horizon, clear of the panels above it.
    for lon, label in ((0, "FRONT 0"), (90, "RIGHT 90"), (180, "BACK 180"), (-90, "LEFT 270")):
        if abs(lon) > fov / 2.0:
            continue
        x, y = at(lon, SPHERE_LAT["cardinal"])
        # At the seam of a VR180 frame the label would hang off the edge.
        at_seam = abs(abs(lon) - fov / 2.0) <= 1.0
        anchor = "ma" if not at_seam else ("la" if lon < 0 else "ra")
        inset = 0.0 if not at_seam else (ppd if lon < 0 else -ppd)
        text_at(draw, (x + inset, y), label, ppd * 3.0, GRID_MAJOR, anchor=anchor)
    for lat in (60, 30, -30, -60):
        text_at(draw, (eq_x(-fov / 2.0, w, fov) + ppd * 2, eq_y(lat, h)),
                f"{lat:+d}", ppd * 2.4, DIM, anchor="lm")
    text_at(draw, at(0, 86), "ZENITH", ppd * 3.0, ACCENT, anchor="mm")
    text_at(draw, at(0, -86), "NADIR", ppd * 3.0, ACCENT, anchor="mm")

    # The 180 boundary: on a VR180 file these must sit exactly at your shoulders.
    if clip.projection == "180":
        for lon in (-90, 90):
            draw_polyline(draw, [(lon * 0.995, lat / 2.0) for lat in range(-178, 179)],
                          w, h, fov, WARN, thick)
            text_at(draw, at(lon * 0.84, -74), "180 EDGE", ppd * 2.6, WARN, anchor="mm")

    for lon, lat in ((0, 70), (45, 35), (-45, 35), (60, 0), (-60, 0), (48, -55), (-48, -55)):
        if abs(lon) > fov / 2.0 - 12:
            continue
        draw_polyline(draw, spherical_circle(lon, lat, 9.0), w, h, fov, TEXT, thick)

    badge_x, badge_y = at(0, SPHERE_LAT["badge"])
    if clip.stereo == "mono":
        text_at(draw, (badge_x, badge_y), "MONO", ppd * 5.0, DIM, anchor="mm")
    else:
        draw_eye_badge(draw, w, h, eye, clip, cx=badge_x, cy=badge_y, radius=ppd * 7.0)
        draw_depth_targets(draw, *at(0, SPHERE_LAT["targets"]), ppd * 5.2, eye, ppd * 1.1)
    burst_top, burst_bottom = SPHERE_LAT["burst"]
    draw_multiburst(draw, [at(-26, burst_top)[0], at(0, burst_top)[1],
                           at(26, burst_top)[0], at(0, burst_bottom)[1]], ppd * 2.2)
    wedge_top, wedge_bottom = SPHERE_LAT["wedge"]
    draw_grey_wedge(draw, [at(-26, wedge_top)[0], at(0, wedge_top)[1],
                           at(26, wedge_top)[0], at(0, wedge_bottom)[1]], ppd * 2.4)
    return img


def draw_fisheye_base(img, clip, eye):
    """Circular fisheye under an equidistant mapping: r = (theta / halfFov) * R."""
    w, h = img.size
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w, h], fill=(8, 9, 11))
    cx, cy = w / 2.0, h / 2.0
    radius = min(w, h) / 2.0 - 2
    half_fov = clip.fov / 2.0
    unit = min(w, h)
    thin = max(1, w // 1400)

    def ring_radius(theta):
        return radius * theta / half_fov

    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=BG, outline=GRID_MAJOR, width=thin * 3)
    for theta in range(15, int(half_fov) + 1, 15):
        r = ring_radius(theta)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GRID, width=thin)
        bearing = math.radians(-58)
        text_at(draw, (cx + r * math.cos(bearing), cy + r * math.sin(bearing)),
                f"{theta}", unit * 0.020, DIM, anchor="mm")
    lens_rings = ((90, "180 lens", WARN, 214), (95, "190 lens", (236, 160, 60), 146), (100, "200 lens", OK, 34))
    for theta, label, colour, bearing in lens_rings:
        if theta > half_fov:
            continue
        r = ring_radius(theta)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=colour, width=thin * 3)
        angle = math.radians(bearing)
        text_at(draw, (cx + r * 0.82 * math.cos(angle), cy + r * 0.82 * math.sin(angle)),
                label, unit * 0.024, colour, anchor="mm")
    for spoke in range(0, 360, 15):
        angle = math.radians(spoke)
        draw.line([cx, cy, cx + radius * math.cos(angle), cy + radius * math.sin(angle)],
                  fill=GRID if spoke % 90 else GRID_MAJOR, width=thin if spoke % 90 else thin * 3)
    draw.ellipse([cx - unit * 0.01, cy - unit * 0.01, cx + unit * 0.01, cy + unit * 0.01], fill=WARN)

    if clip.stereo == "mono":
        text_at(draw, (cx, h * 0.36), "MONO", unit * 0.06, DIM, anchor="mm")
    else:
        draw_eye_badge(draw, w, h, eye, clip, cx=cx, cy=h * 0.36, radius=unit * 0.055)
        draw_depth_targets(draw, cx, h * 0.47, unit * 0.05, eye, unit * 0.011)
    draw_multiburst(draw, [w * 0.26, h * 0.80, w * 0.74, h * 0.855], unit * 0.020)
    return img


def draw_flat_base(img, clip, eye):
    """Cinema test card. Bands are laid out top to bottom so nothing overlaps the
    dynamic zones, and the roundness circle owns the middle of the picture."""
    w, h = img.size
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w, h], fill=BG)
    unit = min(w, h)
    thin = max(1, w // 1600)

    for index in range(1, 16):
        x = w * index / 16
        draw.line([x, h * 0.175, x, h * 0.905], fill=GRID, width=thin)
    for index in range(1, 9):
        y = h * 0.175 + (h * 0.730) * index / 9
        draw.line([0, y, w, y], fill=GRID, width=thin)

    draw_colour_bars(draw, [0, h * 0.030, w, h * 0.095])
    draw_grey_wedge(draw, [0, h * 0.905, w, h], unit * 0.030)
    draw_multiburst(draw, [w * 0.12, h * 0.175, w * 0.88, h * 0.245], unit * 0.022)

    for px, py in ((0.07, 0.32), (0.93, 0.32), (0.07, 0.56), (0.93, 0.56)):
        draw_checkerboard(draw, int(w * px), int(h * py), int(unit * 0.075))
        text_at(draw, (w * px, h * py - unit * 0.048), "1px", unit * 0.020, DIM, anchor="md")

    # Roundness: a circle that reads as an oval means the anamorphic half-packing
    # was misjudged and videoAspect() picked the wrong display ratio.
    cx, cy, r = w / 2.0, h * 0.415, h * 0.160
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ACCENT, width=max(3, w // 480))
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        draw.line([cx + dx * r * 0.88, cy + dy * r * 0.88, cx + dx * r * 1.12, cy + dy * r * 1.12],
                  fill=ACCENT, width=thin * 3)
    text_at(draw, (cx + r * 1.15, cy), "MUST BE ROUND", unit * 0.026, ACCENT, anchor="lm")

    badge_x, badge_y = w * 0.215, h * 0.400
    if clip.stereo != "mono":
        draw_eye_badge(draw, w, h, eye, clip, cx=badge_x, cy=badge_y, radius=unit * 0.060)
        draw_depth_targets(draw, cx, cy + r * 0.42, unit * 0.050, eye, unit * 0.013)
    else:
        text_at(draw, (badge_x, badge_y), "2D", unit * 0.075, DIM, anchor="mm")

    draw_edges(draw, w, h)
    return img


def build_base(clip, eye):
    img = Image.new("RGB", (clip.eye_w, clip.eye_h), BG)
    if clip.projection == "flat":
        return draw_flat_base(img, clip, eye)
    if clip.projection == "fisheye":
        return draw_fisheye_base(img, clip, eye)
    return draw_sphere_base(img, clip, eye)


# --- per-frame content -------------------------------------------------------

def format_time(seconds):
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes):02d}:{rest:06.3f}"


def draw_dynamic(img, clip, eye, frame_index, fps, tour, step_seconds, total_frames):
    """Repaints the cleared zones. Everything that moves lives in one of them."""
    w, h = img.size
    draw = ImageDraw.Draw(img)
    unit = min(w, h)
    area = zones(clip, w, h)
    now = frame_index / fps
    step_index = min(int(now // step_seconds), len(tour) - 1)
    heading, instruction = tour[step_index]
    step_progress = (now - step_index * step_seconds) / step_seconds

    # Motion band: a bar at constant velocity. Judder, smearing or a bar that
    # stutters at a steady playback rate is a rendering problem, not a file one.
    x0, y0, x1, y1 = area["sweep"]
    draw.rectangle([x0, y0, x1, y1], fill=(10, 11, 13))
    draw.rectangle([x0, y0, x1, y1], outline=GRID, width=max(1, w // 1600))
    for tick in range(11):
        tx = x0 + (x1 - x0) * tick / 10
        draw.line([tx, y1 - (y1 - y0) * 0.25, tx, y1], fill=GRID, width=max(1, w // 1600))
    sweep = (now / 4.0) % 2.0
    sweep = sweep if sweep <= 1.0 else 2.0 - sweep  # ping-pong, so it never jumps
    bar = x0 + (x1 - x0) * sweep
    draw.rectangle([bar - (x1 - x0) * 0.008, y0, bar + (x1 - x0) * 0.008, y1], fill=WARN)

    # Checklist.
    x0, y0, x1, y1 = area["step"]
    draw.rectangle([x0, y0, x1, y1], fill=(10, 12, 15))
    draw.rectangle([x0, y0, x1, y1], outline=ACCENT, width=max(2, w // 900))
    pad = (x1 - x0) * 0.022
    head_size = (y1 - y0) * 0.22
    text_at(draw, (x0 + pad, y0 + pad), heading, head_size, ACCENT)
    text_at(draw, (x1 - pad, y0 + pad), f"STEP {step_index + 1}/{len(tour)}", head_size * 0.72, DIM, anchor="ra")
    body_size = (y1 - y0) * 0.135
    lines = wrap(draw, instruction, body_size, (x1 - x0) - pad * 2)
    for index, line in enumerate(lines[:4]):
        text_at(draw, (x0 + pad, y0 + pad * 1.4 + head_size * 1.25 + index * body_size * 1.22), line, body_size)
    draw.rectangle([x0, y1 - (y1 - y0) * 0.045, x0 + (x1 - x0) * step_progress, y1], fill=ACCENT)

    # Clock, frame counter and the A/V sync flash. Laid out along the row's
    # width rather than its height: on a sphere this panel is narrow.
    x0, y0, x1, y1 = area["clock"]
    width, height = x1 - x0, y1 - y0
    draw.rectangle([x0, y0, x1, y1], fill=(10, 11, 13))
    middle = (y0 + y1) / 2
    text_at(draw, (x0 + width * 0.03, middle), format_time(now), width * 0.068, TEXT, anchor="lm")
    text_at(draw, (x0 + width * 0.40, middle),
            f"f{frame_index:05d}/{total_frames - 1:05d}", width * 0.042, DIM, anchor="lm")

    # Second hand: one turn per second, so a dropped frame shows as a jump.
    hand_r = min(height * 0.38, width * 0.055)
    hx = x0 + width * 0.78
    draw.ellipse([hx - hand_r, middle - hand_r, hx + hand_r, middle + hand_r],
                 outline=DIM, width=max(1, w // 1600))
    angle = 2 * math.pi * (now % 1.0) - math.pi / 2
    draw.line([hx, middle, hx + hand_r * 0.88 * math.cos(angle), middle + hand_r * 0.88 * math.sin(angle)],
              fill=OK, width=max(2, int(unit * 0.004)))

    # Flashes white for the first 100 ms of every second, with the beep on the
    # audio track. Any visible offset between them is A/V drift.
    fx = x0 + width * 0.93
    flash = (now % 1.0) < 0.1
    draw.rectangle([fx - hand_r, middle - hand_r, fx + hand_r, middle + hand_r],
                   fill=(255, 255, 255) if flash else (26, 28, 32))
    return img


def pack(images, clip):
    """Lay the eye pictures into the encoded frame.

    `swap` packs them the wrong way round on purpose - that is what an `_RL`
    file is - so the plugin's swap handling has something real to correct.
    """
    frame_w, frame_h = clip.frame_size
    if clip.stereo == "mono":
        return images[0]
    if clip.stereo == "sbs":
        slot_w, slot_h = frame_w // 2, frame_h
        origins = [(0, 0), (slot_w, 0)]
    else:
        slot_w, slot_h = frame_w, frame_h // 2
        origins = [(0, 0), (0, slot_h)]
    frame = Image.new("RGB", (frame_w, frame_h), BG)
    for eye, image in enumerate(images):
        if image.size != (slot_w, slot_h):
            image = image.resize((slot_w, slot_h), Image.LANCZOS)
        frame.paste(image, origins[eye ^ (1 if clip.swap else 0)])
    return frame


# --- encoding ----------------------------------------------------------------

def encode(clip, path, fps, step_seconds, preset, crf, progress=True):
    total_frames = int(round(len(clip.tour) * step_seconds * fps))
    frame_w, frame_h = clip.frame_size
    duration = total_frames / fps
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{frame_w}x{frame_h}", "-r", str(fps), "-i", "-",
        # One beep per second, matched to the white flash in the picture.
        "-f", "lavfi", "-i", f"sine=frequency=440:beep_factor=4:sample_rate=48000:duration={duration:.3f}",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-g", str(int(fps * 2)),
        "-c:a", "aac", "-b:a", "128k",
        "-metadata", f"title={clip.filename}",
        "-movflags", "+faststart", "-shortest", str(path),
    ]
    bases = [build_base(clip, eye) for eye in clip.eyes]
    proc = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for index in range(total_frames):
            images = [
                draw_dynamic(base.copy(), clip, eye, index, fps, clip.tour, step_seconds, total_frames)
                for eye, base in zip(clip.eyes, bases)
            ]
            proc.stdin.write(pack(images, clip).tobytes())
            if progress and index % max(1, int(fps * 2)) == 0:
                done = index / total_frames * 100
                print(f"\r    {done:5.1f}%  frame {index}/{total_frames}", end="", flush=True)
        proc.stdin.close()
    except BrokenPipeError:
        sys.exit(f"\nffmpeg exited early while writing {path.name}")
    if proc.wait() != 0:
        sys.exit(f"\nffmpeg failed on {path.name}")
    if progress:
        print(f"\r    100.0%  {total_frames} frames, {duration:.0f}s, {frame_w}x{frame_h}")


def preview(clip, out_dir, count, fps, step_seconds):
    total_frames = int(round(len(clip.tour) * step_seconds * fps))
    bases = [build_base(clip, eye) for eye in clip.eyes]
    written = []
    for shot in range(count):
        index = int(total_frames * (shot + 0.35) / count)
        images = [
            draw_dynamic(base.copy(), clip, eye, index, fps, clip.tour, step_seconds, total_frames)
            for eye, base in zip(clip.eyes, bases)
        ]
        path = out_dir / f"{clip.key}-{shot:02d}.png"
        pack(images, clip).save(path)
        written.append(path)
    return written


def scaled(clip, scale):
    if scale != 1.0:
        clip.eye_w = max(64, int(clip.eye_w * scale) // 2 * 2)
        clip.eye_h = max(64, int(clip.eye_h * scale) // 2 * 2)
    return clip


def expectation(clip):
    return f"{clip.projection}/{clip.stereo}" + (" + swap" if clip.swap else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("jvr-test-clips"), help="output directory")
    parser.add_argument("--only", action="append", help="clip key (repeatable); default is all")
    parser.add_argument("--list", action="store_true", help="list the clips and exit")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--step-seconds", type=float, default=8.0, help="seconds per checklist step")
    parser.add_argument("--scale", type=float, default=1.0, help="multiply every clip's resolution")
    parser.add_argument("--preset", default="medium", help="x264 preset")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--preview", type=int, metavar="N",
                        help="write N PNG stills per clip instead of encoding (no ffmpeg needed)")
    args = parser.parse_args()

    selected = [clip for clip in CLIPS if not args.only or clip.key in args.only]
    if args.only:
        unknown = set(args.only) - {clip.key for clip in CLIPS}
        if unknown:
            sys.exit(f"unknown clip key(s): {', '.join(sorted(unknown))}")
    for clip in selected:
        scaled(clip, args.scale)

    if args.list:
        print(f"{'key':<12} {'frame':<12} {'expect':<18} file")
        for clip in CLIPS:
            size = "x".join(str(value) for value in clip.frame_size)
            print(f"{clip.key:<12} {size:<12} {expectation(clip):<18} {clip.filename}.mp4")
            print(f"{'':<12} {clip.note}")
        return

    args.out.mkdir(parents=True, exist_ok=True)

    if args.preview:
        for clip in selected:
            paths = preview(clip, args.out, args.preview, args.fps, args.step_seconds)
            print(f"{clip.key}: {len(paths)} stills -> {paths[0].parent}")
        return

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is not on PATH (Arch: sudo pacman -S ffmpeg). "
                 "Use --preview N to render stills without it.")

    for clip in selected:
        path = args.out / f"{clip.filename}.mp4"
        print(f"{clip.key}  ->  {path.name}   [{expectation(clip)}]")
        encode(clip, path, args.fps, args.step_seconds, args.preset, args.crf)
    print(f"\n{len(selected)} clip(s) in {args.out.resolve()}")
    print("Point a Jellyfin library at that directory; the filenames carry the mode markers.")


if __name__ == "__main__":
    main()
