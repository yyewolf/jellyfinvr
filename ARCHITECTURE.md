# Architecture map — Jellyfin VR

Snapshot of the codebase as forked, written as a base for future upgrades.
All line references point at `Jellyfin supports plugins for VR.js`.

## 1. What the repo actually contains

| Path | Role |
| --- | --- |
| `Jellyfin supports plugins for VR.js` | The entire product. 1144 lines, one IIFE, no build step, no imports. |
| `README.md` | Bilingual EN/中文 install guide. |
| `LICENSE` | GPL-3.0. |
| `.kilo/worktrees/enchanting-copy/` | Byte-identical untracked copy left by an AI tool. Not part of the project. |

There is no `package.json`, no bundler, no linter, no tests, no CI. The only
runtime dependency is Three.js **r160.1**, fetched from jsDelivr at first use
(line 10). The script is designed to be pasted whole into the Jellyfin
*JavaScript Injector* plugin, so it must stay a single self-contained file that
runs in Jellyfin Web's page context.

Naming is inconsistent across the repo and is worth unifying early: the file
header says `v1`, the re-entry guard is `__JELLYFIN_VR_V42__` (line 7), the
toolbar renders `Jellyfin VR v4.2` (line 195), and the README tells users to
install a file called `jellyfin-vr-player-v2.js` that does not exist here.

## 2. Lifecycle

```
init (1133)                     DOMContentLoaded
  └─ scan (1126)                MutationObserver on <html> subtree + 1s interval
       └─ addVrButton (1103)    injects "VR" button next to Jellyfin's fullscreen button
            └─ openPlayer (983) ← click
                 ├─ findVideo (90)               pick Jellyfin's <video>
                 ├─ buildCompatStreamUrl (114)   precompute H.264 fallback URL
                 ├─ ensureThree (85)             lazy-load Three.js from CDN
                 ├─ buildOverlay (184)           full-screen DOM overlay + 2D toolbar
                 ├─ buildRenderer (372)          scene, camera, WebGLRenderer, xr.enabled
                 │    ├─ createPanel (216)       canvas-textured in-VR control panel
                 │    └─ setupControllers (507)  2 controllers, laser beams, event wiring
                 ├─ bindMediaEvents (780)
                 └─ replaceVideoTexture (485) → rebuildVideoMeshes (461)
                                              ↓
                 enterVr (925) ← "进入 VR" click → navigator.xr.requestSession
                                              ↓
                 renderFrame (770)            setAnimationLoop, runs every XR frame
                                              ↓
                 closePlayer (1013)           tears everything down, restores <video>
```

`openPlayer` never replaces Jellyfin's player. It leaves the original `<video>`
element in the DOM, playing, and stretches an overlay (`z-index: 2147483646`)
on top of it. That is why library, metadata and watch-history behaviour survive
— and it is the constraint any redesign has to respect.

## 3. The 3D / stereo rendering path (the part to preserve)

This is the core feature set, and it is built from three cooperating pieces.

**3.1 Mode state** — `currentMode` (line 65):

```js
{ projection: '180' | '360' | 'fisheye' | 'flat', stereo: 'mono' | 'sbs' | 'ou', swap: bool }
```

Hardcoded default is `180 / sbs`. It is never auto-detected and never persisted.

**3.2 Geometry per eye** — `makeGeometry(projection, eye)` (line 404):

- `360` → inverted sphere, full 2π sweep, radius 50.
- `180` → inverted half-sphere (`-π/2` start, π length), rotated `y = π/2` when placed.
- `flat` → 7.2 × 4.05 plane at `z = -4.5`. **This is the 3D-movie / cinema mode.**
- `fisheye` → same half-sphere as `180`, but the stereo split moves into a shader.

For `sbs`/`ou`, the stereo split is **baked into the UV attribute** of the
geometry, per eye (lines 419–429): `sbs` maps `u → u*0.5 + eye*0.5`, `ou` maps
`v → v*0.5 + (eye===0 ? 0.5 : 0)` (top half = left eye). `swap` inverts the eye
index before the mapping. Consequence: **any mode change forces a full geometry
rebuild** via `rebuildVideoMeshes` (line 461).

**3.3 Eye separation via Three.js layers** — this is the load-bearing trick:

| Mesh | Layer |
| --- | --- |
| mono video | 0 |
| left-eye video | 1 |
| right-eye video | 2 |
| everything else (panel, rays) | 0 |

`configureEyeLayers` (line 496) runs every frame, grabs `renderer.xr.getCamera()`,
and for each of the two XR eye cameras does `disableAll()` then enables layer 0
plus layer 1 (left) or 2 (right). The desktop preview camera enables 0 and 1, so
a non-VR preview shows the left eye only.

`fisheye` is the exception: it skips UV baking and uses a `ShaderMaterial`
(line 430) that maps `vLocal.xy * 0.5 + 0.5` and applies the stereo offset in
the fragment shader. It has no FOV parameter, so 180°/190°/200° (MKX200, RF52)
content is not correctly undistorted — a known gap, not a regression.

`flat` + `sbs`/`ou` is what gives 3D (half-SBS/half-OU) movie playback on a
virtual screen. Keep `makeGeometry`'s `flat` branch, the layer assignment in
`rebuildVideoMeshes` (lines 470–480), and `configureEyeLayers` intact through
any refactor — those three together *are* the 3D feature.

## 4. The dual-source model (original vs. H.264 compat)

Quest Browser cannot always decode what Jellyfin direct-plays (HEVC, 10-bit)
into a WebGL texture. The script handles this with a second, hidden video:

- `buildCompatStreamUrl` (line 114) rewrites `/Videos/{id}/stream` to
  `/Videos/{id}/stream.mp4` and forces `VideoCodec=h264`, `AudioCodec=aac`,
  `MaxVideoBitDepth=8`, `RequireAvc=true`, 40 Mbps, 4096×4096 cap, stream-copy
  disabled. It **strips `SubtitleStreamIndex` and `SubtitleMethod`**.
- `startCompatAt(position)` (line 806) creates a 2×2 px `#jvr-compat-video`,
  bakes `StartTimeTicks` into the URL, and records `compatOffset`.
- Because the transcode starts at an offset, all time math goes through
  `getCurrentTime()` (line 145) = `compatOffset + video.currentTime`, and
  `seekAbsolute` (line 876) restarts the transcode whenever the target falls
  outside the loaded segment.
- `loadSerial` (line 28) is the stale-response guard for overlapping loads.

Things to be aware of before extending this:

- In compat mode, Jellyfin's own `<video>` is **paused**, so the server's
  playback-progress reporting stalls. Watch history does not advance while the
  compat source is in use.
- The compat URL inherits the original query string, including `PlaySessionId`
  and `api_key`. Two concurrent transcodes share a session id, and nothing calls
  `DELETE /Videos/ActiveEncodings` on teardown, so ffmpeg processes can be left
  orphaned on the server after each source switch or seek-restart.

## 5. In-VR UI

The control panel is a 1600×720 `<canvas>` painted by `drawPanel` (line 314) and
mapped onto a 1.82 × 0.82 m plane **parented to the camera** (line 247), so it
is head-locked until dragged.

- Hit-testing is UV-based: `raycastPanel` (line 540) → `panelActionFromIntersection`
  (line 549) converts `intersection.uv` to canvas pixels and matches against the
  `panelButtons` rect list that `addPanelButton` (line 282) rebuilds on every draw.
- Three interaction zones share the trigger, disambiguated in `beginTrigger`
  (line 591): the timeline strip (`TIMELINE`, line 16) → scrub; the 62 px border
  → drag the panel in space; anything else → button click, or when the panel is
  hidden, drag-to-rotate the video sphere (`videoRoot.rotation`).
- Grip toggles the panel; holding grip 1200 ms calls `resetAll` (line 754).
- `pollGamepads` (line 719) reads raw `xrSession.inputSources`: button 4 = play/pause,
  button 5 = panel toggle, thumbstick X = ±10 s with a 650 ms repeat gate.
- `drawPanel` repaints the whole canvas on every `timeupdate` **and** every 250 ms
  from `renderFrame` (line 776). That is a full 1600×720 CPU repaint plus a
  texture upload, several times a second, for a panel that is mostly static.

There is also a 2D DOM toolbar (`buildOverlay`, line 184) used before entering
VR, handled by `handleToolbar` (line 963). It duplicates the panel's actions.

All UI strings are hardcoded Chinese. There is no i18n layer.

## 6. Upgrade surfaces

Ranked roughly by value-per-effort, and all compatible with keeping the 3D path.

**High value**

1. **Auto-detect projection/stereo.** Today every title needs manual mode picking.
   Parse the Jellyfin item name/path for the usual markers (`SBS`, `HSBS`, `TB`,
   `OU`, `180`, `VR180`, `MKX200`, `fisheye190`, `_LR`) and fall back to aspect
   ratio (`videoWidth/videoHeight` ≈ 2:1 → SBS 180; ≈ 1:1 → OU). Persist the
   final choice per item id in `localStorage`, keyed by Jellyfin item id.
2. **Talk to the Jellyfin API.** `window.ApiClient` is available in page context
   and the script never uses it. It unlocks the item id, media streams, correct
   `PlaySessionId` handling, progress reporting during compat playback, and
   proper `stopEncodingProcess` cleanup.
3. **Subtitles.** Currently impossible by construction — the compat URL strips
   subtitle params. Fetch the external/extracted subtitle track via the API and
   render it onto a canvas plane in front of the video (it needs to live on
   layer 0 so both eyes see it, with a small depth offset).
4. **Self-hostable Three.js.** The CDN fetch breaks LAN-only / offline NAS
   deployments and adds a third-party dependency to every playback start. Either
   vendor it inline or make `THREE_URL` configurable.

**Medium value**

5. **Panel repaint cost.** Split static chrome from the timeline/clock, repaint
   only on a dirty flag, and stop redrawing on every `timeupdate`.
6. **Fisheye FOV parameter.** Make the shader take a real FOV (180/190/200) and
   an equidistant mapping instead of the current fixed approximation.
7. **Cinema mode depth.** `flat` is a bare plane in a black void. A curved screen,
   an adjustable size/distance, and a minimal environment would make 3D movie
   playback — the feature to preserve — substantially better.
8. **Volume control.** Only a mute toggle exists; no slider, no audio track picker.
9. **`scan()` debouncing.** The MutationObserver fires on every mutation of
   Jellyfin's very busy DOM with no throttle, alongside a 1 s interval.
10. **Seek desync.** `seekAbsolute` writes `video.currentTime` directly, bypassing
    Jellyfin's player controller, so Jellyfin's own OSD can drift out of sync.

**Structural**

11. **Split the file**, then bundle back to a single injectable artifact. Natural
    seams: `xr/` (renderer, layers, controllers), `media/` (source switching,
    compat URL), `ui/` (panel canvas, toolbar), `jellyfin/` (API adapter).
    Add `package.json` + esbuild + a lint pass; keep the single-file output.
12. **Rename the file** to something without spaces (`jellyfin-vr-player.js`) and
    reconcile the four conflicting version strings.
13. **i18n**, given the README is already bilingual.
14. **Hand tracking** is requested as an optional feature (line 933) but never used.

## 7. Invariants to respect

- Must remain one file, pasteable into JS Injector, no module syntax at top level.
- Must not replace or detach Jellyfin's `<video>` element; the overlay sits on top.
- `closePlayer` (line 1013) must keep restoring `currentTime`, `muted`, `volume`
  and the original element `id` — that is what makes the return to Jellyfin seamless.
- Requires a secure context; `enterVr` bails without HTTPS (line 926).
