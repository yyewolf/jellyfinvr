/*
 * Drives a camera tour of the plugin's own auditorium.
 *
 * Nothing here rebuilds or re-describes the room: `window.__JVR__.run` is a
 * direct eval inside the plugin's IIFE, so every shot calls the real
 * buildTheater / applySeat / applyLightLevel and renders the same geometry the
 * headset does. If the room changes, this tour changes with it.
 *
 * With the seat on MID the scene graph cancels out - videoRoot sits at +EYE and
 * environmentRoot at -EYE - so camera paths are authored directly in the
 * auditorium's own coordinates: floor at y = 0, viewer at the origin, screen
 * down -z. That is the same frame `THEATER` is written in.
 */
(function () {
  const run = window.__JVR__.run;

  let renderer = null;
  let world = null;
  let camera = null;
  let caption = null;
  let hud = null;
  let progress = null;
  let applied = { seat: null, lights: null };
  let screenTexture = null;
  let EYE = 1.6;

  const DEG = 180 / Math.PI;

  // --- shot list -----------------------------------------------------------
  // `p` is the camera position, `t` the point it looks at, both in room
  // coordinates. A shot with `seat` is filmed from the viewer's actual seat:
  // the camera stays at the origin and the room moves, which is how the plugin
  // does it, so the framing is exactly what the headset shows.
  const SHOTS = [
    {
      id: 'house', seconds: 9, title: 'THE HOUSE',
      detail: '308 seats on a thirteen-tread stadium rake',
      lights: 'half', fov: 50,
      from: { p: [0, 4.2, 6.6], t: [0, 1.5, -13.1] },
      to: { p: [0, 2.9, 1.2], t: [0, 1.7, -13.1] },
    },
    {
      id: 'rake', seconds: 8, title: 'THE RAKE',
      detail: 'Treads of 1.25 m stepping 0.42 m, eight rows in front of you',
      lights: 'half', fov: 45,
      from: { p: [-8.4, 1.7, 5.0], t: [-1.0, 0.0, -3.0] },
      to: { p: [-8.4, 3.0, -3.5], t: [-1.0, -0.8, -8.0] },
    },
    {
      id: 'details', seconds: 8, title: 'FIXTURES',
      detail: 'Wall sconces, aisle markers laid flat on the tread, EXIT signs',
      lights: 'half', fov: 45,
      from: { p: [-5.2, 1.3, 2.6], t: [-9.8, 2.4, 0.5] },
      to: { p: [-3.4, 1.0, -4.0], t: [-9.8, 2.0, -6.5] },
    },
    {
      id: 'back', seconds: 8, title: 'BEHIND YOU',
      detail: 'Projection booth ports, EXIT signs, the back wall',
      lights: 'half', fov: 55,
      // A turn has to interpolate the yaw. Lerping a look-at target instead
      // drags it through the camera's own position and the shot whips round.
      p: [0, 2.7, 2.0], yawFrom: 30, yawTo: 185, pitch: 4,
    },
    {
      id: 'screen', seconds: 8, title: 'THE SCREEN',
      detail: '15.6 m x 8.8 m, aspect-matched to the file, 13.1 m away',
      lights: 'low', fov: 50,
      from: { p: [0, 2.4, -1.0], t: [0, 1.8, -13.1] },
      to: { p: [0, 2.0, -8.0], t: [0, 1.8, -13.1] },
    },
    {
      id: 'curve', seconds: 8, title: 'THE CURVE',
      detail: 'Cylindrical, radius 2.2x the throw - the bend a real screen has',
      lights: 'low', fov: 55,
      from: { p: [-8.0, 2.0, -8.0], t: [0, 1.8, -13.1] },
      to: { p: [8.0, 2.0, -8.0], t: [0, 1.8, -13.1] },
    },
    { id: 'seat-front', seconds: 5, title: 'SEAT: FRONT', seat: 'front', lights: 'low' },
    { id: 'seat-close', seconds: 5, title: 'SEAT: CLOSE', seat: 'close', lights: 'low' },
    { id: 'seat-mid', seconds: 5, title: 'SEAT: MID', seat: 'mid', lights: 'low' },
    { id: 'seat-back', seconds: 5, title: 'SEAT: BACK', seat: 'back', lights: 'low' },
    {
      id: 'lights', seconds: 12, title: 'HOUSE LIGHTS',
      detail: 'Four levels, multipliers on the room that the picture does not follow',
      lightCycle: ['out', 'low', 'half', 'full'], fov: 50,
      from: { p: [0, 2.7, 3.0], t: [0, 1.4, -13.1] },
      to: { p: [0, 2.5, 1.2], t: [0, 1.5, -13.1] },
    },
    { id: 'finale', seconds: 7, title: 'YOUR SEAT', seat: 'mid', lights: 'low' },
  ];

  const SEAT_FOV = 62;
  const FLY_FOV = 48;

  function ease(x) {
    return x * x * (3 - 2 * x);
  }

  function lerp3(a, b, k) {
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }

  function duration() {
    return SHOTS.reduce((total, shot) => total + shot.seconds, 0);
  }

  function shotAt(time) {
    let start = 0;
    for (const shot of SHOTS) {
      if (time < start + shot.seconds || shot === SHOTS[SHOTS.length - 1]) {
        return { shot, local: Math.min(1, Math.max(0, (time - start) / shot.seconds)) };
      }
      start += shot.seconds;
    }
    return { shot: SHOTS[0], local: 0 };
  }

  // --- geometry readouts ---------------------------------------------------
  // Same maths as tools/screen-coverage.py, run against the live layout so the
  // caption cannot claim a framing the render is not showing.
  function seatMetrics(seatId) {
    const layout = run('computeScreenLayout()');
    const theater = run('THEATER');
    const seat = run('SEATS').find((entry) => entry.id === seatId);
    const offsetY = -seat.row * theater.riser;
    const offsetZ = -seat.row * theater.rowDepth;
    const halfW = layout.width / 2;
    const halfH = layout.height / 2;
    const centreY = layout.y + offsetY;
    const centreZ = layout.z + offsetZ;
    let edgeX = halfW;
    let edgeZ = centreZ;
    if (layout.radius) {
      const angle = halfW / layout.radius;
      edgeX = layout.radius * Math.sin(angle);
      edgeZ = centreZ + layout.radius * (1 - Math.cos(angle));
    }
    const depth = -centreZ;
    return {
      throw: depth,
      h: 2 * Math.atan2(edgeX, -edgeZ) * DEG,
      v: (Math.atan2(centreY + halfH, depth) - Math.atan2(centreY - halfH, depth)) * DEG,
      centreY,
    };
  }

  // --- state ---------------------------------------------------------------

  function applySeat(seatId) {
    if (applied.seat === seatId) return;
    run(`seatId = ${JSON.stringify(seatId)}`);
    run('applySeat()');
    applied.seat = seatId;
  }

  function applyLights(levelId) {
    if (applied.lights === levelId) return;
    run(`lightLevelId = ${JSON.stringify(levelId)}`);
    run('applyLightLevel()');
    applied.lights = levelId;
  }

  function boot(options) {
    const { width, height } = options;
    EYE = run('EYE_HEIGHT');

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    document.getElementById('stage').appendChild(renderer.domElement);

    world = new THREE.Scene();
    world.background = new THREE.Color(0x000000);
    camera = new THREE.PerspectiveCamera(options.fov || 62, width / height, 0.05, 200);
    camera.layers.enable(0);
    camera.layers.enable(1);
    world.add(camera);

    const videoRoot = new THREE.Group();
    videoRoot.position.set(0, EYE, 0);
    world.add(videoRoot);
    const seatRoot = new THREE.Group();
    videoRoot.add(seatRoot);
    const environmentRoot = new THREE.Group();
    environmentRoot.position.set(0, -EYE, 0);
    environmentRoot.visible = false;
    seatRoot.add(environmentRoot);

    window.__stage = { renderer, world, camera, videoRoot, seatRoot, environmentRoot };
    for (const key of ['renderer', 'world', 'camera', 'videoRoot', 'seatRoot', 'environmentRoot']) {
      run(`${key} = window.__stage.${key}`);
    }
    // The 2D toolbar and the in-VR panel do not exist here, and
    // rebuildVideoMeshes calls both on its way out.
    run('updateToolbar = function () {}');
    run('drawPanel = function () {}');
    run("environmentBuilt = ''");
    run("environmentName = 'theater'");
    run("Object.assign(currentMode, { projection: 'flat', stereo: 'mono', swap: false })");

    run('syncEnvironment()');

    applied = { seat: null, lights: null };
    applySeat('mid');
    applyLights('low');

    caption = document.getElementById('caption');
    hud = document.getElementById('hud');
    progress = document.getElementById('progress');
    return { duration: duration(), shots: SHOTS.map((shot) => shot.id) };
  }

  /* Called after boot, never before: creating the WebGL context first and only
   * then starting a decoder keeps the two out of each other's way. Booting in
   * the other order loses the GL context to the video pipeline. */
  function setScreen(video) {
    window.__stage.video = video;
    run('activeVideo = window.__stage.video');
    run('replaceVideoTexture(activeVideo)');
    screenTexture = run('videoTexture');
  }

  function renderAt(time) {
    const { shot, local } = shotAt(time);
    const eased = ease(local);

    if (shot.lightCycle) {
      const index = Math.min(shot.lightCycle.length - 1, Math.floor(local * shot.lightCycle.length));
      applyLights(shot.lightCycle[index]);
    } else if (shot.lights) {
      applyLights(shot.lights);
    }

    const fov = shot.fov || (shot.seat ? SEAT_FOV : FLY_FOV);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    let detail = shot.detail || '';
    if (shot.seat) {
      applySeat(shot.seat);
      const metrics = seatMetrics(shot.seat);
      detail = `${metrics.throw.toFixed(1)} m throw · `
        + `${metrics.h.toFixed(0)}° wide × ${metrics.v.toFixed(0)}° tall`;
      // Filmed from the seat itself: the viewer never moves, the room does.
      camera.position.set(0, EYE, 0);
      camera.lookAt(0, EYE + metrics.centreY, -metrics.throw);
      // A slow drift keeps the shot alive without pretending the viewer walked.
      camera.rotateY(Math.sin(local * Math.PI * 2) * 0.012);
    } else if (shot.yawFrom !== undefined) {
      applySeat('mid');
      camera.position.set(shot.p[0], shot.p[1], shot.p[2]);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(
        (shot.pitch || 0) / DEG,
        (shot.yawFrom + (shot.yawTo - shot.yawFrom) * eased) / DEG,
        0
      );
    } else {
      applySeat('mid');
      const p = lerp3(shot.from.p, shot.to.p, eased);
      const t = lerp3(shot.from.t, shot.to.t, eased);
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(t[0], t[1], t[2]);
    }

    // Fade the lower third in and out so cuts do not snap.
    const fade = Math.min(1, local / 0.12, (1 - local) / 0.12);
    caption.style.opacity = String(Math.max(0, fade));
    caption.querySelector('.title').textContent = shot.title;
    caption.querySelector('.detail').textContent = detail;
    hud.querySelector('.seat').textContent = `SEAT ${applied.seat.toUpperCase()}`;
    hud.querySelector('.lights').textContent = `LIGHTS ${applied.lights.toUpperCase()}`;
    progress.style.width = `${(time / duration()) * 100}%`;

    // THREE.VideoTexture only marks itself dirty from requestVideoFrameCallback,
    // which needs a frame tick we never run: capture renders on demand, not in
    // a loop. After a seek the new frame is decoded but not uploaded, so say so.
    if (screenTexture) screenTexture.needsUpdate = true;
    renderer.render(world, camera);
  }

  window.JVRShowcase = { boot, setScreen, renderAt, duration, shots: SHOTS };
})();
