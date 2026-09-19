# Architecture map — Jellyfin VR

Snapshot of the codebase as a base for future upgrades.
All line references point at `Jellyfin supports plugins for VR.js`.

## 1. What the repo actually contains

| Path | Role |
| --- | --- |
| `Jellyfin supports plugins for VR.js` | The entire product. ~1490 lines, one IIFE, no build step, no imports. |
| `ARCHITECTURE.md` | This file. |
| `README.md` | Bilingual EN/中文 install guide. |
| `LICENSE` | GPL-3.0. |

There is no `package.json`, no bundler, no linter, no test runner. The only
runtime dependency is Three.js **r160.1**, fetched from jsDelivr at first use
(line 10). The script is designed to be pasted whole into the Jellyfin
*JavaScript Injector* plugin, so it must stay a single self-contained file that
runs in Jellyfin Web's page context.

Naming is still inconsistent and worth unifying: the file header says `v1`, the
re-entry guard is `__JELLYFIN_VR_V42__` (line 7), the toolbar renders
`Jellyfin VR v4.2`, and the README tells users to install a file called
`jellyfin-vr-player-v2.js` that does not exist here.

## 2. Lifecycle

```
init (1480)                     DOMContentLoaded
  └─ scan (1474)                MutationObserver on <html> subtree + 1s interval
       └─ addVrButton (1454)    injects "VR" button next to Jellyfin's fullscreen button
            └─ openPlayer (1308) ← click
                 ├─ findVideo (103)              pick Jellyfin's <video>
                 ├─ readJellyfinContext (134)    derive API credentials from the stream URL
                 ├─ buildCompatStreamUrl (411)   precompute H.264 fallback URL
                 ├─ loadItemText (387)           fetch item name/path for mode detection
                 ├─ ensureThree (98)             lazy-load Three.js from CDN
                 ├─ buildOverlay (481)           full-screen DOM overlay + 2D toolbar
                 ├─ buildRenderer (669)          scene, camera, WebGLRenderer, xr.enabled
                 │    ├─ createPanel (513)       canvas-textured in-VR control panel
                 │    └─ setupControllers (804)  2 controllers, laser beams, event wiring
                 ├─ bindMediaEvents (1078)
                 └─ replaceVideoTexture (782) → rebuildVideoMeshes (758)
                                              ↓
                 autoDetectMode (352)         fires once dimensions + metadata are known
                                              ↓
                 enterVr (1264) ← "Enter VR" click → navigator.xr.requestSession
                                              ↓
                 renderFrame (1065)           setAnimationLoop, runs every XR frame
                                              ↓
                 closePlayer (1348)           tears everything down, restores <video>
```

`openPlayer` never replaces Jellyfin's player. It leaves the original `<video>`
element in the DOM, playing, and stretches an overlay (`z-index: 2147483646`)
on top of it. That is why library, metadata and watch-history behaviour survive
— and it is the constraint any redesign has to respect.

## 3. The 3D / stereo rendering path (the part to preserve)

This is the core feature set, and it is built from three cooperating pieces.

**3.1 Mode state** — `currentMode` (line 81):

```js
{ projection: '180' | '360' | 'fisheye' | 'flat', stereo: 'mono' | 'sbs' | 'ou', swap: bool }
```

Every mutation goes through `applyMode(changes, remember)` (line 346), which
assigns, rebuilds the meshes, and optionally persists the choice. User-driven
call sites pass `remember: true`; auto-detection passes `false`, so a detection
bug can never be frozen into storage as though the user had chosen it.

**3.2 Geometry per eye** — `makeGeometry(projection, eye)` (line 701):

- `360` → inverted sphere, full 2π sweep, radius 50.
- `180` → inverted half-sphere (`-π/2` start, π length), rotated `y = π/2` when placed.
- `flat` → 7.2 × 4.05 plane at `z = -4.5`. **This is the 3D-movie / cinema mode.**
- `fisheye` → same half-sphere as `180`, but the stereo split moves into a shader.

For `sbs`/`ou`, the stereo split is **baked into the UV attribute** of the
geometry, per eye: `sbs` maps `u → u*0.5 + eye*0.5`, `ou` maps
`v → v*0.5 + (eye===0 ? 0.5 : 0)` (top half = left eye). `swap` inverts the eye
index before the mapping. Consequence: **any mode change forces a full geometry
rebuild** via `rebuildVideoMeshes` (line 758).

**3.3 Eye separation via Three.js layers** — this is the load-bearing trick:

| Mesh | Layer |
| --- | --- |
| mono video | 0 |
| left-eye video | 1 |
| right-eye video | 2 |
| everything else (panel, rays) | 0 |

`configureEyeLayers` (line 793) runs every frame, grabs `renderer.xr.getCamera()`,
and for each of the two XR eye cameras does `disableAll()` then enables layer 0
plus layer 1 (left) or 2 (right). The desktop preview camera enables 0 and 1, so
a non-VR preview shows the left eye only.

`fisheye` is the exception: it skips UV baking and uses a `ShaderMaterial`
(line 727) that maps `vLocal.xy * 0.5 + 0.5` and applies the stereo offset in
the fragment shader. It has no FOV parameter, so 180°/190°/200° (MKX200, RF52)
content is not correctly undistorted — a known gap.

`flat` + `sbs`/`ou` is what gives 3D (half-SBS/half-OU) movie playback on a
virtual screen. Keep `makeGeometry`'s `flat` branch, the layer assignment in
`rebuildVideoMeshes`, and `configureEyeLayers` intact through any refactor —
those three together *are* the 3D feature.

## 4. Mode auto-detection

`resolveMode` (line 302) picks a projection/stereo pair from three tiers, highest
priority first:

1. **Saved override** for the Jellyfin item id — `readStoredModes` (line 322) /
   `rememberMode` (line 330), in `localStorage` under `jvr.modes.v1`, capped at
   200 entries with oldest-first eviction.
2. **Markers in the item name or file path** — `detectFromText` (line 274)
   tokenises on non-alphanumerics and matches `PROJECTION_TOKENS` /
   `STEREO_TOKENS`. `stereoFromToken` (line 268) additionally strips `half`,
   `full` and `3d` affixes so `HalfOU`, `FullSBS`, `SBS3D` and `3DTB` resolve.
   Lens profiles (`MKX200`, `RF52`, `VRCA220`, `fisheye190`) imply `fisheye`;
   `_RL` implies side-by-side with swapped eyes.
3. **Aspect ratio** — `detectFromAspect` (line 286): 4:1 → 360/SBS,
   3.56:1 → flat/SBS, 2:1 → 180/SBS, 1:1 → 180/mono, 0.5:1 → 180/OU,
   0.89:1 → flat/OU, 1.6–2.45 → flat/mono.

Two rules matter more than they look:

- **Name markers must outrank aspect.** Half-SBS and half-OU are squeezed back
  into an ordinary 16:9 frame, so the aspect ratio sees only one eye and cannot
  distinguish them from a 2D video. For the same reason a bare `3D` marker
  overrides an aspect-derived `mono`.
- **The VR aspect rules are gated on width** (≥3000px for 2:1, ≥2000px for 1:1).
  Without that gate a 2.00:1 or 2.35:1 cinema master is misread as 180/SBS.

Because the stream URL carries no file name, `loadItemText` (line 387) fetches
the item record for `Name`, `OriginalTitle`, `Path` and `MediaSources[].Path`.
It tries the user-scoped route (`/Users/{userId}/Items/{id}`) before the flat one
(`/Items/{id}`), since the endpoint moved between Jellyfin versions, and falls
back to `document.title`. `autoDetectMode` (line 352) waits for both the video
dimensions and the metadata fetch, with a 2.5 s timeout so a hung API cannot
block detection.

Known false positive: a 2D film with `3D` glued into its filename
(`Spy_Kids_3D_Game_Over`) is read as stereo. The user's correction persists, so
it is a one-time fix per item.

## 5. Jellyfin API adapter

`readJellyfinContext` (line 134) derives everything needed to call the API —
`itemId`, `MediaSourceId`, `PlaySessionId`, `api_key`, `DeviceId` — straight out
of the stream URL Jellyfin already built for its own player, consulting
`window.ApiClient` only to fill gaps. That keeps the adapter independent of
ApiClient's method signatures. `jellyfinRequest` (line 161) and
`jellyfinGetJson` (line 373) are the two transports; both authenticate with an
`X-Emby-Token` header and fail closed by returning `false`/`null`.

## 6. The dual-source model (original vs. H.264 compat)

Quest Browser cannot always decode what Jellyfin direct-plays (HEVC, 10-bit)
into a WebGL texture. The script handles this with a second, hidden video:

- `buildCompatStreamUrl` (line 411) rewrites `/Videos/{id}/stream` to
  `/Videos/{id}/stream.mp4` and forces `VideoCodec=h264`, `AudioCodec=aac`,
  `MaxVideoBitDepth=8`, `RequireAvc=true`, 40 Mbps, 4096×4096 cap, stream-copy
  disabled. It **strips `SubtitleStreamIndex` and `SubtitleMethod`**.
- `startCompatAt(position)` (line 1121) creates a 2×2 px `#jvr-compat-video`,
  bakes `StartTimeTicks` into the URL, and records `compatOffset`.
- Because the transcode starts at an offset, all time math goes through
  `getCurrentTime()` (line 442) = `compatOffset + video.currentTime`, and
  `seekAbsolute` (line 1205) restarts the transcode whenever the target falls
  outside the loaded segment.
- `loadSerial` is the stale-response guard for overlapping loads.

**Progress reporting.** Jellyfin stops advancing watch history while its own
`<video>` is parked, so `reportProgress` (line 181) POSTs to
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
That is a safety property, not cosmetics: `stopEncoding` (line 222) issues
`DELETE /Videos/ActiveEncodings`, and keyed on the shared id it would have
killed Jellyfin's own transcode of the original source. Cleanup fires on
seek-restart, source switch, player close and `pagehide`; requests use
`keepalive: true` so teardown survives the headset sleeping.

## 7. In-VR UI

The control panel is a 1600×720 `<canvas>` painted by `drawPanel` (line 611) and
mapped onto a 1.82 × 0.82 m plane **parented to the camera**, so it is
head-locked until dragged.

- Hit-testing is UV-based: `raycastPanel` (line 838) → `panelActionFromIntersection`
  (line 847) converts `intersection.uv` to canvas pixels and matches against the
  `panelButtons` rect list that `addPanelButton` (line 579) rebuilds on every draw.
- Three interaction zones share the trigger, disambiguated in `beginTrigger`
  (line 893): the timeline strip → scrub; the 62 px border → drag the panel in
  space; anything else → button click, or when the panel is hidden,
  drag-to-rotate the video sphere (`videoRoot.rotation`).
- Grip toggles the panel; holding grip 1200 ms calls `resetAll` (line 1053).
- `pollGamepads` (line 1014) reads raw `xrSession.inputSources`: button 4 = play/pause,
  button 5 = panel toggle, thumbstick X = ±10 s with a 650 ms repeat gate.
- `drawPanel` repaints the whole canvas on every `timeupdate` **and** every 250 ms
  from `renderFrame`. That is a full 1600×720 CPU repaint plus a texture upload,
  several times a second, for a panel that is mostly static.

There is also a 2D DOM toolbar (`buildOverlay`, line 481) used before entering
VR, handled by `handleToolbar` (line 1296). It duplicates the panel's actions.

UI strings are English. There is no i18n layer, so the Chinese-locale selectors
in `locateControls` (line 1447) are load-bearing — they are how the VR button
finds its anchor on a Chinese Jellyfin install.

## 8. Upgrade surfaces

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
6. **Cinema mode depth.** `flat` is a bare plane in a black void. A curved screen,
   an adjustable size/distance, and a minimal environment would make 3D movie
   playback — the feature to preserve — substantially better.
7. **Volume control.** Only a mute toggle exists; no slider, no audio track picker.
8. **`scan()` debouncing.** The MutationObserver fires on every mutation of
   Jellyfin's very busy DOM with no throttle, alongside a 1 s interval.
9. **Seek desync.** `seekAbsolute` writes `video.currentTime` directly, bypassing
   Jellyfin's player controller, so Jellyfin's own OSD can drift out of sync.

**Structural**

10. **Split the file**, then bundle back to a single injectable artifact. Natural
    seams: `xr/` (renderer, layers, controllers), `media/` (source switching,
    compat URL), `ui/` (panel canvas, toolbar), `jellyfin/` (API adapter,
    detection). Add `package.json` + esbuild + a lint pass; keep the single-file
    output.
11. **Rename the file** to something without spaces (`jellyfin-vr-player.js`) and
    reconcile the four conflicting version strings.
12. **i18n**, given the README is bilingual and the UI is now English-only.
13. **Hand tracking** is requested as an optional feature in `enterVr` but never used.

## 9. Invariants to respect

- Must remain one file, pasteable into JS Injector, no module syntax at top level.
- Must not replace or detach Jellyfin's `<video>` element; the overlay sits on top.
- `closePlayer` (line 1348) must keep restoring `currentTime`, `muted`, `volume`
  and the original element `id` — that is what makes the return to Jellyfin seamless.
- `stopEncoding` must only ever be handed a `PlaySessionId` we generated. Passing
  Jellyfin's own id would kill the original stream out from under its player.
- Requires a secure context; `enterVr` bails without HTTPS.
