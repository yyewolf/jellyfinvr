# Architecture map — Jellyfin VR

Snapshot of the codebase as a base for future upgrades.
All line references point at `Jellyfin supports plugins for VR.js`.

## 1. What the repo actually contains

| Path | Role |
| --- | --- |
| `Jellyfin supports plugins for VR.js` | The entire product. ~1770 lines, one IIFE, no build step, no imports. |
| `ARCHITECTURE.md` | This file. |
| `README.md` | Bilingual EN/中文 install guide. |
| `LICENSE` | GPL-3.0. |

There is no `package.json`, no bundler, no linter, no test runner. The only
runtime dependency is Three.js **r160.1**, fetched from jsDelivr at first use
(line 10). The script is designed to be pasted whole into the Jellyfin
*JavaScript Injector* plugin, so it must stay a single self-contained file that
runs in Jellyfin Web's page context.

Naming is still inconsistent and worth unifying: the file header says `v1`, the
re-entry guard is `__JELLYFIN_VR_V42__` (line 8), the toolbar renders
`Jellyfin VR v4.2`, and the README tells users to install a file called
`jellyfin-vr-player-v2.js` that does not exist here.

## 2. Lifecycle

```
init (2345)                     DOMContentLoaded
  └─ scan (2329)                MutationObserver (rAF-coalesced) + 1s interval
       └─ augmentSheet (2320)   adds "Watch in VR" to the player's options menu
            └─ openPlayer (2117) ← click
                 ├─ findVideo (148)              pick Jellyfin's <video>
                 ├─ readJellyfinContext (179)    derive API credentials from the stream URL
                 ├─ buildCompatStreamUrl (456)   precompute H.264 fallback URL
                 ├─ loadItemText (432)           fetch item name/path for mode detection
                 ├─ ensureThree (143)             lazy-load Three.js from CDN
                 ├─ buildOverlay (526)           full-screen DOM overlay + 2D toolbar
                 ├─ buildRenderer (718)          scene, camera, WebGLRenderer, xr.enabled
                 │    ├─ environmentRoot        empty group for the room (section 4)
                 │    ├─ createPanel (560)       canvas-textured in-VR control panel
                 │    └─ setupControllers (1606)  2 controllers, laser beams, event wiring
                 ├─ bindMediaEvents (1882)
                 └─ replaceVideoTexture (1584) → rebuildVideoMeshes (1556)
                                              └─ syncEnvironment (1465) builds/shows the room
                                              ↓
                 autoDetectMode (397)         fires once dimensions + metadata are known
                                              ↓
                 enterVr (2072) ← "Enter VR" click → navigator.xr.requestSession
                                              ↓
                 renderFrame (1869)           setAnimationLoop, runs every XR frame
                                              ↓
                 closePlayer (2158)           tears everything down, restores <video>
```

`openPlayer` never replaces Jellyfin's player. It leaves the original `<video>`
element in the DOM, playing, and stretches an overlay (`z-index: 2147483646`)
on top of it. That is why library, metadata and watch-history behaviour survive
— and it is the constraint any redesign has to respect.

## 3. The 3D / stereo rendering path (the part to preserve)

This is the core feature set, and it is built from three cooperating pieces.

**3.1 Mode state** — `currentMode` (line 94):

```js
{ projection: '180' | '360' | 'fisheye' | 'flat', stereo: 'mono' | 'sbs' | 'ou', swap: bool }
```

Every mutation goes through `applyMode(changes, remember)` (line 391), which
assigns, rebuilds the meshes, and optionally persists the choice. User-driven
call sites pass `remember: true`; auto-detection passes `false`, so a detection
bug can never be frozen into storage as though the user had chosen it.

**3.2 Geometry per eye** — `makeGeometry(projection, eye)` (line 1497):

- `360` → inverted sphere, full 2π sweep, radius 50.
- `180` → inverted half-sphere (`-π/2` start, π length), rotated `y = π/2` when placed.
- `flat` → plane sized and placed by `computeScreenLayout` (line 798). **This is
  the 3D-movie / cinema mode**, and the surface an environment is built around;
  see section 4.
- `fisheye` → same half-sphere as `180`, but the stereo split moves into a shader.

For `sbs`/`ou`, the stereo split is **baked into the UV attribute** of the
geometry, per eye: `sbs` maps `u → u*0.5 + eye*0.5`, `ou` maps
`v → v*0.5 + (eye===0 ? 0.5 : 0)` (top half = left eye). `swap` inverts the eye
index before the mapping. Consequence: **any mode change forces a full geometry
rebuild** via `rebuildVideoMeshes` (line 1556).

**3.3 Eye separation via Three.js layers** — this is the load-bearing trick:

| Mesh | Layer |
| --- | --- |
| mono video | 0 |
| left-eye video | 1 |
| right-eye video | 2 |
| everything else (panel, rays) | 0 |

`configureEyeLayers` (line 1595) runs every frame, grabs `renderer.xr.getCamera()`,
and for each of the two XR eye cameras does `disableAll()` then enables layer 0
plus layer 1 (left) or 2 (right). The desktop preview camera enables 0 and 1, so
a non-VR preview shows the left eye only.

`fisheye` is the exception: it skips UV baking and uses a `ShaderMaterial`
(line 999) that maps `vLocal.xy * 0.5 + 0.5` and applies the stereo offset in
the fragment shader. It has no FOV parameter, so 180°/190°/200° (MKX200, RF52)
content is not correctly undistorted — a known gap.

`flat` + `sbs`/`ou` is what gives 3D (half-SBS/half-OU) movie playback on a
virtual screen. Keep `makeGeometry`'s `flat` branch, the layer assignment in
`rebuildVideoMeshes`, and `configureEyeLayers` intact through any refactor —
those three together *are* the 3D feature.

## 4. Environments (cinema rooms)

An *environment* is 3D room geometry placed around the `flat` screen. It is
orthogonal to `currentMode`: a separate state slot, `environmentName`, one of
`'void' | 'theater'`, persisted **globally** in `localStorage` under
`jvr.env.v1`. That is deliberately not per-item the way projection is — the room
you want to sit in is a taste preference, not a property of the file.

`environmentActive()` (line 771) is the gate: an environment only renders when
`projection === 'flat'`. The 180/360/fisheye paths wrap the viewer in a
radius-50 sphere that would swallow any room, so there is nothing to show. The
reverse also holds — `applyEnvironment` (line 1480) switches the projection to
`flat` when a room is chosen, because asking for the room means asking for the
screen the room is built around.

### 4.1 Scene graph

```
world
 └─ videoRoot            (y = +1.6, rotated by drag-to-pan)
     ├─ left/right video meshes   layers 1 / 2 (or 0 when mono)
     └─ environmentRoot  (y = -1.6 → room floor lands at world y = 0)
         ├─ room shell, seats, aisle lights, 3 lights   layer 0
         └─ jvr-screen-surround   masking frame + additive bleed
```

Parenting the room to `videoRoot` rather than to `world` is what keeps the room
and the screen rotation-locked when the user drags to pan. The -1.6 offset lets
`buildTheater` be authored in ordinary room coordinates with the floor at y = 0.

**Everything in the room is on layer 0.** `configureEyeLayers` (line 1595)
enables layer 0 for both XR eye cameras, so the room is drawn to both eyes and
the headset's own stereo cameras give it real depth for free. Putting a room
object on layer 1 or 2 by accident would make it visible to one eye only.

### 4.2 Screen sizing

`computeScreenLayout` (line 798) replaced the hardcoded 7.2 × 4.05 plane. It
returns `{ width, height, y, z, radius }` in `videoRoot`-local space from a
per-environment preset plus the video's aspect ratio:

| Environment | Height | Max width | Distance | Centre (eye-relative) | Curve |
| --- | --- | --- | --- | --- | --- |
| `void` | 4.05 | 9.0 | 4.5 m | 0 | flat |
| `theater` | 8.8 | 17.0 | 13.1 m | +0.12 | r = 2.2 × distance |

At 16:9 that is a 15.6 × 8.8 m screen subtending 62° horizontally — a good seat
in a large auditorium. Height is fixed and width follows the aspect until it
hits `maxWidth`, at which point height gives way instead, so the screen centre
never moves.

Void at 16:9 still evaluates to exactly 7.2 × 4.05 at z = -4.5, so nothing about
the pre-existing cinema mode moved.

`videoAspect` (line 781) is the subtle part. **Pixel dimensions alone do not
give the display aspect of one eye.** In *half*-SBS/OU each eye is squeezed back
into an ordinary frame, so the eye's pixels are anamorphic and the container
aspect already *is* the display aspect; in *full*-SBS/OU the frame is genuinely
twice as wide (or tall) and must be halved. The two are told apart by which
reading lands in the normal range of display ratios (1.2 – 2.7), with the half
packing tried first so an SBS frame at 2.4:1 reads as half-SBS scope rather than
full-SBS of 1.2:1 content. All four packings of a 16:9 master — half/full × SBS/OU
— converge on a 16:9 screen.

### 4.3 Curvature

Real cinema screens are gently curved, and in a headset the curve does a lot of
work: it kills the "picture taped to a flat wall" read. `SCREEN_LAYOUTS` carries
a `curveRatio` — the cylinder radius as a multiple of the viewing distance — and
`bendAroundY` maps each vertex `x -> r·sin(x/r)`, `z += r·(1-cos(x/r))`. At 2.2
that is a sagitta of ~6.7% of the screen width, which is the curve a commercial
screen actually has. `void` keeps `curveRatio: 0` and stays flat.

Two properties make the bend safe:

- **It preserves arc length**, so the screen still shows `width` metres of picture.
- **It never touches UVs**, which is what lets the stereo UV baking in
  `makeGeometry` (line 1497) run afterwards exactly as before.

Anything bent has to carry enough segments to follow the arc — a bend only moves
vertices, so a single-quad strip cuts the curve as a flat chord. The masking
frame is tessellated at roughly one segment per 0.4 m for this reason; without
it the picture bulges a metre through its own frame.

### 4.4 Theater geometry

`buildTheater` (line 1340) assembles five pieces, all authored with the floor at
y = 0 and the viewer standing at the origin.

`buildFloor` (line 1141) is the load-bearing one. The floor is a **stadium
rake**: thirteen 1.25 m treads stepping 0.42 m, eight in front of the viewer and
four behind. Without the rake a screen taller than eye height would have its
bottom edge below the floor the viewer is standing on. Every tread and riser is
merged into one geometry and given box-projected UVs (`boxProjectUV`, line 1003)
so one carpet scale holds across horizontal and vertical faces alike. Risers face
-z: the exposed face of a step down is on the far side, so they are seen looking
back up the rake and never from a seat.

`buildSeating` (line 1116) places 308 seats. Rows arc around a point 110 m
behind the screen and each seat yaws to face it. The radius is not cosmetic: the
offset of an outer seat grows as `span² / 2r`, and it has to stay inside the
half-depth of its own tread or the seat floats off the step. Four seats are
dropped at each aisle and four more where the viewer is standing.

`buildShell` (line 1167) is the room box plus the stage apron and two screen
speaker stacks. `buildFixtures` (line 1233) adds wall sconces, aisle markers,
ceiling downlights, EXIT signs and the projection booth ports. Aisle markers sit
flat on the tread rather than in the riser, because riser-mounted lights face
away from every seat.

The seat is five boxes merged into one vertex-coloured geometry
(`makeSeatGeometry`, line 1010) and drawn as a single `InstancedMesh`. Three's
`BufferGeometryUtils` lives under `examples/`, which a single pasteable file
cannot import, so `mergeParts` (line 978) does the merge by hand — converting to
non-indexed first reduces it to concatenating attribute arrays.

Budget for the whole room: **17 draw calls, ~19k triangles, 4 lights, 8
textures**.

### 4.5 Textures, albedo and light

The file ships no image assets, so every surface is painted into a canvas at
build time: carpet, fabric-wrapped acoustic battens, pleated drapes, a radial
glow, the screen wash and the EXIT sign. The acoustic panel bakes its vertical
zoning (skirting, field, upper band) down the canvas and maps it once over the
wall height, so only the horizontal rib rhythm repeats.

**Albedo has to be chosen in linear space.** Three runs a correct colour
pipeline, so a hex like `0x22262f` that reads as "dark grey" in a colour picker
is an albedo of ~0.015 and renders as a black void no matter how bright the
lights are. The room's surfaces sit around 0.05–0.10 linear, which is roughly
`0x3f`–`0x55` in hex: dark to the eye, but actually present once the screen
lights them.

Lighting is one `AmbientLight` and three `PointLight`s, all with **`decay = 0`**.
That switches off the inverse-square term and leaves a plain distance window,
which is far easier to tune than physical candela for a room this size. The key
light sits at the screen with a deliberately short window so the light dies
before the back of the house; a warm house light lifts the rear. Ambient is kept
low on purpose — a real auditorium is lit almost entirely by its screen, so the
falloff has to come from the point lights rather than from a uniform fill.

`FogExp2` adds depth to the far corners. It is attached and detached with the
room, because the 180/360 sphere sits at radius 50 and would be fogged into a
flat wash; the screen and the control panel opt out via `fog: false` on their
own materials.

### 4.6 Lifecycle hooks

- `buildRenderer` (line 718) creates the empty `environmentRoot`.
- `rebuildVideoMeshes` (line 1556) recomputes `screenLayout` and calls
  `syncEnvironment` (line 1465) *before* the video-texture guard, so the room
  tracks mode changes even before a texture exists.
- `buildEnvironment` (line 1451) is idempotent via `environmentBuilt`; the room
  is constructed once and then only shown/hidden.
- `updateTriggerDrag` clamps pitch to 0 while an environment is active, so
  drag-to-pan is yaw-only and the room cannot be tilted off-level.
- `closePlayer` disposes the whole `environmentRoot` tree, including
  `InstancedMesh.dispose()` for the seat instance buffers.

## 5. Mode auto-detection

`resolveMode` (line 347) picks a projection/stereo pair from three tiers, highest
priority first:

1. **Saved override** for the Jellyfin item id — `readStoredModes` (line 367) /
   `rememberMode` (line 375), in `localStorage` under `jvr.modes.v1`, capped at
   200 entries with oldest-first eviction.
2. **Markers in the item name or file path** — `detectFromText` (line 319)
   tokenises on non-alphanumerics and matches `PROJECTION_TOKENS` /
   `STEREO_TOKENS`. `stereoFromToken` (line 313) additionally strips `half`,
   `full` and `3d` affixes so `HalfOU`, `FullSBS`, `SBS3D` and `3DTB` resolve.
   Lens profiles (`MKX200`, `RF52`, `VRCA220`, `fisheye190`) imply `fisheye`;
   `_RL` implies side-by-side with swapped eyes.
3. **Aspect ratio** — `detectFromAspect` (line 331): 4:1 → 360/SBS,
   3.56:1 → flat/SBS, 2:1 → 180/SBS, 1:1 → 180/mono, 0.5:1 → 180/OU,
   0.89:1 → flat/OU, 1.6–2.45 → flat/mono.

Two rules matter more than they look:

- **Name markers must outrank aspect.** Half-SBS and half-OU are squeezed back
  into an ordinary 16:9 frame, so the aspect ratio sees only one eye and cannot
  distinguish them from a 2D video. For the same reason a bare `3D` marker
  overrides an aspect-derived `mono`.
- **The VR aspect rules are gated on width** (≥3000px for 2:1, ≥2000px for 1:1).
  Without that gate a 2.00:1 or 2.35:1 cinema master is misread as 180/SBS.

Because the stream URL carries no file name, `loadItemText` (line 432) fetches
the item record for `Name`, `OriginalTitle`, `Path` and `MediaSources[].Path`.
It tries the user-scoped route (`/Users/{userId}/Items/{id}`) before the flat one
(`/Items/{id}`), since the endpoint moved between Jellyfin versions, and falls
back to `document.title`. `autoDetectMode` (line 397) waits for both the video
dimensions and the metadata fetch, with a 2.5 s timeout so a hung API cannot
block detection.

Known false positive: a 2D film with `3D` glued into its filename
(`Spy_Kids_3D_Game_Over`) is read as stereo. The user's correction persists, so
it is a one-time fix per item.

## 6. Jellyfin API adapter

`readJellyfinContext` (line 179) derives everything needed to call the API —
`itemId`, `MediaSourceId`, `PlaySessionId`, `api_key`, `DeviceId` — straight out
of the stream URL Jellyfin already built for its own player, consulting
`window.ApiClient` only to fill gaps. That keeps the adapter independent of
ApiClient's method signatures. `jellyfinRequest` (line 206) and
`jellyfinGetJson` (line 418) are the two transports; both authenticate with an
`X-Emby-Token` header and fail closed by returning `false`/`null`.

## 7. The dual-source model (original vs. H.264 compat)

Quest Browser cannot always decode what Jellyfin direct-plays (HEVC, 10-bit)
into a WebGL texture. The script handles this with a second, hidden video:

- `buildCompatStreamUrl` (line 456) rewrites `/Videos/{id}/stream` to
  `/Videos/{id}/stream.mp4` and forces `VideoCodec=h264`, `AudioCodec=aac`,
  `MaxVideoBitDepth=8`, `RequireAvc=true`, 40 Mbps, 4096×4096 cap, stream-copy
  disabled. It **strips `SubtitleStreamIndex` and `SubtitleMethod`**.
- `startCompatAt(position)` (line 1925) creates a 2×2 px `#jvr-compat-video`,
  bakes `StartTimeTicks` into the URL, and records `compatOffset`.
- Because the transcode starts at an offset, all time math goes through
  `getCurrentTime()` (line 487) = `compatOffset + video.currentTime`, and
  `seekAbsolute` (line 2009) restarts the transcode whenever the target falls
  outside the loaded segment.
- `loadSerial` is the stale-response guard for overlapping loads.

**Progress reporting.** Jellyfin stops advancing watch history while its own
`<video>` is parked, so `reportProgress` (line 226) POSTs to
`/Sessions/Playing/Progress` on a 10 s interval plus on play/pause/seek,
deduplicated by position+paused state. Reports go out under Jellyfin's
*original* `PlaySessionId` so they land on the session the server already knows.

This is an improvement, not a complete fix: Jellyfin's own `playbackManager`
still periodically reports the paused source element's frozen position, so the
server's known position can flap mid-playback. The final position is
authoritative because `closePlayer` syncs `sourceVideo.currentTime` before
handing back. Fully removing the flap means either suppressing Jellyfin's
reporter or keeping the source element seeked in sync — the latter risks
triggering transcode restarts on the original stream, which is worse.

**Transcode cleanup.** The compat stream gets its own generated
`PlaySessionId` (`newCompatSessionId`, line 212) rather than reusing Jellyfin's.
That is a safety property, not cosmetics: `stopEncoding` (line 267) issues
`DELETE /Videos/ActiveEncodings`, and keyed on the shared id it would have
killed Jellyfin's own transcode of the original source. Cleanup fires on
seek-restart, source switch, player close and `pagehide`; requests use
`keepalive: true` so teardown survives the headset sleeping.

## 8. In-VR UI

The control panel is a 1600×720 `<canvas>` painted by `drawPanel` (line 659) and
mapped onto a 1.82 × 0.82 m plane **parented to the camera**, so it is
head-locked until dragged.

- Hit-testing is UV-based: `raycastPanel` (line 1640) → `panelActionFromIntersection`
  (line 1649) converts `intersection.uv` to canvas pixels and matches against the
  `panelButtons` rect list that `addPanelButton` (line 627) rebuilds on every draw.
- Three interaction zones share the trigger, disambiguated in `beginTrigger`
  (line 1695): the timeline strip → scrub; the 62 px border → drag the panel in
  space; anything else → button click, or when the panel is hidden,
  drag-to-rotate the video sphere (`videoRoot.rotation`).
- Grip toggles the panel; holding grip 1200 ms calls `resetAll` (line 1857).
- `pollGamepads` (line 1818) reads raw `xrSession.inputSources`: button 4 = play/pause,
  button 5 = panel toggle, thumbstick X = ±10 s with a 650 ms repeat gate.
- `drawPanel` repaints the whole canvas on every `timeupdate` **and** every 250 ms
  from `renderFrame`. That is a full 1600×720 CPU repaint plus a texture upload,
  several times a second, for a panel that is mostly static.

There is also a 2D DOM toolbar (`buildOverlay`, line 481) used before entering
VR, handled by `handleToolbar` (line 2104). It duplicates the panel's actions.

UI strings are English and there is no i18n layer, but the *entry point* no
longer depends on one. The VR entry is added to Jellyfin's own options menu by
`augmentSheet` (line 2320), which clones a real item out of the sheet it is
augmenting and rewrites its label and icon. That is what keeps it looking native
across Jellyfin versions and skins without matching any class name or
translated string — the previous control-bar button had to carry Chinese
selectors to find its anchor, and those are gone.

The trade is that the entry now depends on Jellyfin rendering its menus through
the `actionSheet` component. `window.jellyfinVR.open()` is kept as an escape
hatch for builds where it does not.

## 9. Upgrade surfaces

Ranked roughly by value-per-effort, all compatible with keeping the 3D path.

**High value**

1. **Subtitles.** Currently impossible by construction — the compat URL strips
   subtitle params. Fetch the external/extracted track via the API and render it
   onto a canvas plane in front of the video (on layer 0 so both eyes see it,
   with a small depth offset).
2. **Self-hostable Three.js.** The CDN fetch breaks LAN-only / offline NAS
   deployments and adds a third-party dependency to every playback start. Either
   vendor it inline or make `THREE_URL` configurable.
3. **Tests for the detection table.** `resolveMode` and its helpers are pure and
   the highest-churn logic in the file, but the repo has no test runner. They
   currently have to be extracted by hand to be exercised.

**Medium value**

4. **Panel repaint cost.** Split static chrome from the timeline/clock, repaint
   only on a dirty flag, and stop redrawing on every `timeupdate`.
5. **Fisheye FOV parameter.** Make the shader take a real FOV (180/190/200) and
   an equidistant mapping instead of the current fixed approximation. Detection
   already recognises the lens profiles; the renderer ignores them.
6. **Cinema mode depth.** Done — section 4 adds the `theater` environment, a
   curved aspect-correct screen and procedural surfacing. Still open: a
   user-adjustable screen size/distance, and more rooms than the one.
7. **Volume control.** Only a mute toggle exists; no slider, no audio track picker.
8. **Seek desync.** `seekAbsolute` writes `video.currentTime` directly, bypassing
   Jellyfin's player controller, so Jellyfin's own OSD can drift out of sync.

**Structural**

9. **Split the file**, then bundle back to a single injectable artifact. Natural
    seams: `xr/` (renderer, layers, controllers), `media/` (source switching,
    compat URL), `ui/` (panel canvas, toolbar), `jellyfin/` (API adapter,
    detection). Add `package.json` + esbuild + a lint pass; keep the single-file
    output.
10. **Rename the file** to something without spaces (`jellyfin-vr-player.js`) and
    reconcile the four conflicting version strings.
11. **i18n**, given the README is bilingual and the UI is now English-only.
12. **Hand tracking** is requested as an optional feature in `enterVr` but never used.

## 10. Invariants to respect

- Must remain one file, pasteable into JS Injector, no module syntax at top level.
- Must not replace or detach Jellyfin's `<video>` element; the overlay sits on top.
- `closePlayer` (line 2158) must keep restoring `currentTime`, `muted`, `volume`
  and the original element `id` — that is what makes the return to Jellyfin seamless.
- `stopEncoding` must only ever be handed a `PlaySessionId` we generated. Passing
  Jellyfin's own id would kill the original stream out from under its player.
- Requires a secure context; `enterVr` bails without HTTPS.
