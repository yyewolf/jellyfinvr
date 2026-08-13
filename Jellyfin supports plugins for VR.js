/*
 * Jellyfin supports plugins for VR v1
 */
(function () {
  'use strict';

  if (window.__JELLYFIN_VR_V42__) return;
  window.__JELLYFIN_VR_V42__ = true;

  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js';
  const BUTTON_ID = 'jvr-v4-button';
  const OVERLAY_ID = 'jvr-v4-overlay';
  const PANEL_WIDTH = 1.82;
  const PANEL_HEIGHT = 0.82;
  const PANEL_HOME = { x: 0, y: -0.13, z: -1.32 };
  const TIMELINE = { x: 80, y: 164, width: 1440, height: 76, trackY: 192, trackHeight: 20 };

  let overlay = null;
  let statusEl = null;
  let sourceVideo = null;
  let activeVideo = null;
  let compatVideo = null;
  let originalState = null;
  let compatUrl = '';
  let compatOffset = 0;
  let sourceMode = 'original';
  let savedVideoId = '';
  let loadSerial = 0;

  let world = null;
  let camera = null;
  let renderer = null;
  let videoTexture = null;
  let videoRoot = null;
  let videoMeshes = [];
  let controllers = [];
  let panelMesh = null;
  let panelCanvas = null;
  let panelContext = null;
  let panelTexture = null;
  let panelBorder = null;
  let panelCursor = null;
  let panelVisible = false;
  let panelButtons = [];
  let hoverAction = '';
  let lastPanelDraw = 0;
  let lastStickAction = 0;
  let xrSession = null;
  let closing = false;

  let scanTimer = 0;
  let resizeHandler = null;
  const inputStates = new WeakMap();
  const triggerStates = new WeakMap();
  const gripTimers = new WeakMap();
  const dragState = {
    controller: null,
    type: '',
    startTime: 0,
    startDirection: null,
    startYaw: 0,
    startPitch: 0,
    startPanelPosition: null,
    startPanelQuaternion: null,
    seekTime: 0,
    moved: false
  };
  const currentMode = { projection: '180', stereo: 'sbs', swap: false };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.THREE?.WebGLRenderer) return resolve();
      const existing = Array.from(document.scripts).find((item) => item.src === src);
      const script = existing || document.createElement('script');
      if (!existing) {
        script.src = src;
        script.crossOrigin = 'anonymous';
        document.head.appendChild(script);
      }
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('Three.js 加载失败')), { once: true });
    });
  }

  async function ensureThree() {
    if (!window.THREE?.WebGLRenderer) await loadScript(THREE_URL);
    if (!window.THREE?.WebGLRenderer) throw new Error('Three.js 初始化失败');
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter((video) => video.id !== 'jvr-compat-video');
    return videos.find((video) => video.currentSrc && !video.paused)
      || videos.find((video) => video.currentSrc || video.src)
      || null;
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return '0:00';
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = Math.floor(value % 60).toString().padStart(2, '0');
    return hours
      ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}`
      : `${minutes}:${seconds}`;
  }

  function setQueryParam(url, name, value) {
    Array.from(url.searchParams.keys()).forEach((key) => {
      if (key.toLowerCase() === name.toLowerCase()) url.searchParams.delete(key);
    });
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  }

  function buildCompatStreamUrl(video) {
    const raw = video?.currentSrc || video?.src;
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      const match = url.pathname.match(/^(.*\/Videos\/)([^/]+)\/stream(?:\.[^/]*)?$/i);
      if (!match) return '';
      url.pathname = `${match[1]}${match[2]}/stream.mp4`;
      setQueryParam(url, 'Static', 'false');
      setQueryParam(url, 'VideoCodec', 'h264');
      setQueryParam(url, 'AudioCodec', 'aac');
      setQueryParam(url, 'EnableAutoStreamCopy', 'false');
      setQueryParam(url, 'AllowVideoStreamCopy', 'false');
      setQueryParam(url, 'AllowAudioStreamCopy', 'false');
      setQueryParam(url, 'MaxVideoBitDepth', '8');
      setQueryParam(url, 'RequireAvc', 'true');
      setQueryParam(url, 'VideoBitRate', '40000000');
      setQueryParam(url, 'AudioBitRate', '320000');
      setQueryParam(url, 'AudioChannels', '2');
      setQueryParam(url, 'MaxWidth', '4096');
      setQueryParam(url, 'MaxHeight', '4096');
      setQueryParam(url, 'Context', 'Streaming');
      setQueryParam(url, 'SubtitleStreamIndex', null);
      setQueryParam(url, 'SubtitleMethod', null);
      setQueryParam(url, 'StartTimeTicks', null);
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function getCurrentTime() {
    if (!activeVideo) return 0;
    return sourceMode === 'compat'
      ? compatOffset + (activeVideo.currentTime || 0)
      : (activeVideo.currentTime || 0);
  }

  function getDuration() {
    return originalState?.duration || sourceVideo?.duration || activeVideo?.duration || 0;
  }

  function addStyles() {
    if (document.getElementById('jvr-v4-style')) return;
    const style = document.createElement('style');
    style.id = 'jvr-v4-style';
    style.textContent = `
      #${OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
      #${OVERLAY_ID} .jvr-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
      #${OVERLAY_ID} .jvr-bar{position:absolute;top:0;left:0;right:0;z-index:5;display:flex;align-items:center;gap:7px;padding:10px;background:linear-gradient(#000e,transparent);pointer-events:auto}
      #${OVERLAY_ID} button{border:1px solid #ffffff45;border-radius:7px;background:#17191ddd;color:#fff;padding:8px 10px;font:inherit;cursor:pointer}
      #${OVERLAY_ID} button.active{border-color:#20b9ed;background:#075c78}
      #${OVERLAY_ID} button:disabled{opacity:.4;cursor:not-allowed}
      #${OVERLAY_ID} .jvr-enter{margin-left:auto;background:#008fbd;font-weight:700}
      #${OVERLAY_ID} .jvr-close{font-size:20px;padding:4px 12px}
      #${OVERLAY_ID} .jvr-status{position:absolute;left:50%;bottom:20px;z-index:5;transform:translateX(-50%);padding:8px 12px;border-radius:7px;background:#111e;color:#ccd3da;font-size:13px;white-space:nowrap;pointer-events:none}
      @media(max-width:780px){#${OVERLAY_ID} .jvr-bar{flex-wrap:wrap}.jvr-label{display:none}}
    `;
    document.head.appendChild(style);
  }

  function createButton(label, action, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    if (value) button.dataset.value = value;
    return button;
  }

  function buildOverlay() {
    addStyles();
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    const bar = document.createElement('div');
    bar.className = 'jvr-bar';
    const close = createButton('←', 'exit');
    close.className = 'jvr-close';
    bar.append(close);
    const version = document.createElement('span');
    version.className = 'jvr-label';
    version.textContent = 'Jellyfin VR v4.2';
    bar.append(version);
    [['360°', '360'], ['180° 经编', '180'], ['180° 鱼眼', 'fisheye'], ['影院', 'flat']]
      .forEach(([label, value]) => bar.append(createButton(label, 'projection', value)));
    [['单眼', 'mono'], ['SBS', 'sbs'], ['OU', 'ou']]
      .forEach(([label, value]) => bar.append(createButton(label, 'stereo', value)));
    bar.append(createButton('交换眼睛', 'swap'));
    const source = createButton('原始源', 'source');
    source.id = 'jvr-source-toggle';
    bar.append(source);
    const enter = createButton('进入 VR', 'enter');
    enter.className = 'jvr-enter';
    bar.append(enter);
    statusEl = document.createElement('div');
    statusEl.className = 'jvr-status';
    statusEl.textContent = '正在初始化原生 WebXR 渲染器…';
    overlay.append(bar, statusEl);
    document.body.appendChild(overlay);
    bar.addEventListener('click', handleToolbar);
  }

  function createPanel() {
    panelCanvas = document.createElement('canvas');
    panelCanvas.width = 1600;
    panelCanvas.height = 720;
    panelContext = panelCanvas.getContext('2d');
    panelTexture = new THREE.CanvasTexture(panelCanvas);
    panelTexture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
    const material = new THREE.MeshBasicMaterial({
      map: panelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    panelMesh = new THREE.Mesh(geometry, material);
    panelMesh.name = 'jvr-control-panel';
    panelMesh.position.set(PANEL_HOME.x, PANEL_HOME.y, PANEL_HOME.z);
    panelMesh.renderOrder = 10000;
    panelMesh.visible = false;
    camera.add(panelMesh);

    const borderGeometry = new THREE.EdgesGeometry(geometry);
    const borderMaterial = new THREE.LineBasicMaterial({ color: 0x35cfff, transparent: true, opacity: 0.95, depthTest: false });
    panelBorder = new THREE.LineSegments(borderGeometry, borderMaterial);
    panelBorder.name = 'jvr-panel-drag-border';
    panelBorder.position.z = 0.006;
    panelBorder.renderOrder = 10002;
    panelMesh.add(panelBorder);

    const cursorGeometry = new THREE.RingGeometry(0.013, 0.023, 32);
    const cursorMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    panelCursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
    panelCursor.name = 'jvr-panel-cursor';
    panelCursor.position.z = 0.012;
    panelCursor.renderOrder = 10003;
    panelCursor.visible = false;
    const cursorDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.008, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    );
    cursorDot.position.z = 0.001;
    panelCursor.add(cursorDot);
    panelMesh.add(panelCursor);
    drawPanel();
  }

  function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, radius);
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function addPanelButton(x, y, width, height, label, action, color = '#27303a') {
    const context = panelContext;
    const hovered = hoverAction === action;
    roundedRect(context, x, y, width, height, 18);
    context.fillStyle = hovered ? '#008fc2' : color;
    context.fill();
    context.strokeStyle = hovered ? '#83ddff' : '#ffffff30';
    context.lineWidth = hovered ? 5 : 2;
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '44px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + width / 2, y + height / 2);
    panelButtons.push({ x, y, width, height, action });
  }

  function fillFittedText(context, text, centerX, centerY, maxWidth, startSize, minSize = 26) {
    let size = startSize;
    do {
      context.font = `${size}px system-ui, sans-serif`;
      if (context.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size > minSize);
    let output = text;
    if (context.measureText(output).width > maxWidth) {
      while (output.length > 4 && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
      output += '…';
    }
    context.fillText(output, centerX, centerY);
  }

  function drawPanel() {
    if (!panelContext || !panelTexture) return;
    const context = panelContext;
    panelButtons = [];
    context.clearRect(0, 0, panelCanvas.width, panelCanvas.height);
    roundedRect(context, 0, 0, 1600, 720, 30);
    context.fillStyle = '#10151bf7';
    context.fill();
    context.strokeStyle = '#36d2ffff';
    context.lineWidth = 12;
    context.stroke();
    context.fillStyle = '#123848';
    context.fillRect(28, 18, 1544, 16);
    context.fillStyle = '#5edcff';
    context.font = '28px system-ui, sans-serif';
    context.textAlign = 'right';
    context.fillText('按住边框拖动面板', 1530, 52);
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const title = (document.title || 'Jellyfin VR').replace(/\s+/g, ' ');
    fillFittedText(context, title, 800, 76, 1440, 52, 30);
    context.fillStyle = '#aeb9c4';
    context.font = '42px system-ui, sans-serif';
    const shownTime = dragState.type === 'seek' ? dragState.seekTime : getCurrentTime();
    context.fillText(`${formatTime(shownTime)} / ${formatTime(getDuration())}`, 800, 125);
    const duration = getDuration();
    const progress = duration > 0 ? THREE.MathUtils.clamp(shownTime / duration, 0, 1) : 0;
    roundedRect(context, TIMELINE.x, TIMELINE.trackY, TIMELINE.width, TIMELINE.trackHeight, 10);
    context.fillStyle = '#34414c';
    context.fill();
    roundedRect(context, TIMELINE.x, TIMELINE.trackY, Math.max(20, TIMELINE.width * progress), TIMELINE.trackHeight, 10);
    context.fillStyle = '#f5f8fb';
    context.fill();
    context.beginPath();
    context.arc(TIMELINE.x + TIMELINE.width * progress, TIMELINE.trackY + TIMELINE.trackHeight / 2, 24, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.strokeStyle = '#171d22';
    context.lineWidth = 5;
    context.stroke();
    addPanelButton(55, 275, 170, 105, '-10', 'back');
    addPanelButton(245, 275, 220, 105, activeVideo?.paused ? 'PLAY' : 'PAUSE', 'play', '#006f96');
    addPanelButton(485, 275, 170, 105, '+10', 'forward');
    addPanelButton(675, 275, 210, 105, activeVideo?.muted ? 'MUTED' : 'SOUND', 'mute');
    addPanelButton(905, 275, 210, 105, currentMode.projection.toUpperCase(), 'projection');
    addPanelButton(1135, 275, 180, 105, currentMode.stereo.toUpperCase(), 'stereo');
    addPanelButton(1335, 275, 210, 105, sourceMode === 'compat' ? 'H264' : 'SOURCE', 'source', '#25536a');
    addPanelButton(55, 435, 330, 105, 'SWAP EYES', 'swap');
    addPanelButton(425, 435, 330, 105, 'RESET ALL', 'reset', '#365061');
    addPanelButton(795, 435, 330, 105, 'HIDE PANEL', 'hide');
    addPanelButton(1165, 435, 380, 105, 'EXIT VR', 'exit-vr', '#652d34');
    context.fillStyle = '#81909f';
    context.font = '36px system-ui, sans-serif';
    context.fillText('时间轴：按住拖动  ·  长按扳机拖动画面  ·  长按握柄：全部复位', 800, 635);
    panelTexture.needsUpdate = true;
  }

  function buildRenderer() {
    world = new THREE.Scene();
    world.background = new THREE.Color(0x000000);
    camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 120);
    camera.position.set(0, 1.6, 0);
    camera.layers.enable(0);
    camera.layers.enable(1);
    world.add(camera);
    videoRoot = new THREE.Group();
    videoRoot.name = 'jvr-video-view-root';
    videoRoot.position.set(0, 1.6, 0);
    world.add(videoRoot);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.domElement.className = 'jvr-canvas';
    overlay.prepend(renderer.domElement);
    createPanel();
    setupControllers();
    resizeHandler = () => {
      if (!renderer || !camera) return;
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    };
    window.addEventListener('resize', resizeHandler);
    renderer.setAnimationLoop(renderFrame);
  }

  function makeGeometry(projection, eye) {
    let geometry;
    if (projection === '360') {
      geometry = new THREE.SphereGeometry(50, 64, 32, 0, Math.PI * 2, 0, Math.PI);
      geometry.scale(-1, 1, 1);
    } else if (projection === 'flat') {
      geometry = new THREE.PlaneGeometry(7.2, 4.05, 1, 1);
    } else {
      geometry = new THREE.SphereGeometry(50, 64, 32, -Math.PI / 2, Math.PI, 0, Math.PI);
      geometry.scale(-1, 1, 1);
    }
    if (currentMode.stereo !== 'mono') {
      const selectedEye = currentMode.swap ? 1 - eye : eye;
      const uv = geometry.attributes.uv;
      for (let index = 0; index < uv.count; index += 1) {
        let u = uv.getX(index);
        let v = uv.getY(index);
        if (currentMode.stereo === 'sbs') u = u * 0.5 + selectedEye * 0.5;
        else v = v * 0.5 + (selectedEye === 0 ? 0.5 : 0);
        uv.setXY(index, u, v);
      }
      uv.needsUpdate = true;
    }
    return geometry;
  }

  function makeMaterial(eye) {
    if (currentMode.projection !== 'fisheye') {
      return new THREE.MeshBasicMaterial({
        map: videoTexture,
        side: currentMode.projection === 'flat' ? THREE.DoubleSide : THREE.FrontSide,
        toneMapped: false
      });
    }
    const selectedEye = currentMode.swap ? 1 - eye : eye;
    const stereoLine = currentMode.stereo === 'sbs'
      ? `p.x=p.x*0.5+${selectedEye ? '0.5' : '0.0'};`
      : currentMode.stereo === 'ou'
        ? `p.y=p.y*0.5+${selectedEye ? '0.0' : '0.5'};`
        : '';
    return new THREE.ShaderMaterial({
      side: THREE.FrontSide,
      uniforms: { map: { value: videoTexture } },
      vertexShader: `varying vec3 vLocal;void main(){vLocal=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform sampler2D map;varying vec3 vLocal;void main(){vec2 p=vLocal.xy*0.5+0.5;${stereoLine}gl_FragColor=texture2D(map,p);}`
    });
  }

  function disposeVideoMeshes() {
    videoMeshes.forEach((mesh) => {
      videoRoot?.remove(mesh);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    });
    videoMeshes = [];
  }

  function rebuildVideoMeshes() {
    if (!world || !videoTexture) return;
    disposeVideoMeshes();
    const stereo = currentMode.stereo !== 'mono';
    const left = new THREE.Mesh(makeGeometry(currentMode.projection, 0), makeMaterial(0));
    left.name = 'jvr-left-video';
    if (currentMode.projection === 'flat') left.position.set(0, 0, -4.5);
    else if (currentMode.projection !== '360') left.rotation.y = Math.PI / 2;
    left.layers.set(stereo ? 1 : 0);
      videoRoot.add(left);
    videoMeshes.push(left);
    if (stereo) {
      const right = new THREE.Mesh(makeGeometry(currentMode.projection, 1), makeMaterial(1));
      right.name = 'jvr-right-video';
      if (currentMode.projection === 'flat') right.position.set(0, 0, -4.5);
      else if (currentMode.projection !== '360') right.rotation.y = Math.PI / 2;
      right.layers.set(2);
      videoRoot.add(right);
      videoMeshes.push(right);
    }
    updateToolbar();
    drawPanel();
  }

  function replaceVideoTexture(video) {
    if (!video || !world) return;
    videoTexture?.dispose?.();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    rebuildVideoMeshes();
  }

  function configureEyeLayers() {
    if (!renderer?.xr?.isPresenting || !camera) return;
    const xrCamera = renderer.xr.getCamera(camera);
    const eyeCameras = xrCamera?.cameras || [];
    eyeCameras.forEach((eyeCamera, index) => {
      eyeCamera.layers.disableAll();
      eyeCamera.layers.enable(0);
      if (currentMode.stereo !== 'mono') eyeCamera.layers.enable(index === 0 ? 1 : 2);
    });
  }

  function setupControllers() {
    for (let index = 0; index < 2; index += 1) {
      const controller = renderer.xr.getController(index);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0028, 0.0028, 5, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthTest: false, depthWrite: false })
      );
      beam.name = 'jvr-ray';
      beam.rotation.x = -Math.PI / 2;
      beam.position.z = -2.5;
      beam.renderOrder = 9998;
      beam.visible = false;
      controller.add(beam);
      controller.addEventListener('selectstart', () => beginTrigger(controller));
      controller.addEventListener('selectend', () => endTrigger(controller));
      controller.addEventListener('squeezestart', () => {
        panelVisible ? hidePanel() : showPanel();
        const oldTimer = gripTimers.get(controller);
        if (oldTimer) clearTimeout(oldTimer);
        gripTimers.set(controller, setTimeout(() => {
          gripTimers.delete(controller);
          resetAll();
        }, 1200));
      });
      controller.addEventListener('squeezeend', () => {
        const timer = gripTimers.get(controller);
        if (timer) clearTimeout(timer);
        gripTimers.delete(controller);
      });
      world.add(controller);
      controllers.push(controller);
    }
  }

  function raycastPanel(controller) {
    if (!panelVisible || !panelMesh?.visible) return null;
    const rotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    return raycaster.intersectObject(panelMesh, false)[0] || null;
  }

  function panelActionFromIntersection(intersection) {
    if (!intersection?.uv) return '';
    const x = intersection.uv.x * panelCanvas.width;
    const y = (1 - intersection.uv.y) * panelCanvas.height;
    return panelButtons.find((button) => x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height)?.action || '';
  }

  function isTimelineArea(intersection) {
    const point = panelPoint(intersection);
    return Boolean(point
      && point.x >= TIMELINE.x - 35
      && point.x <= TIMELINE.x + TIMELINE.width + 35
      && point.y >= TIMELINE.y - 28
      && point.y <= TIMELINE.y + TIMELINE.height);
  }

  function timelineTimeFromIntersection(intersection) {
    const point = panelPoint(intersection);
    if (!point || !getDuration()) return getCurrentTime();
    const ratio = THREE.MathUtils.clamp((point.x - TIMELINE.x) / TIMELINE.width, 0, 1);
    return ratio * getDuration();
  }

  function panelPoint(intersection) {
    if (!intersection?.uv) return null;
    return {
      x: intersection.uv.x * panelCanvas.width,
      y: (1 - intersection.uv.y) * panelCanvas.height
    };
  }

  function isPanelDragArea(intersection) {
    const point = panelPoint(intersection);
    if (!point) return false;
    const edge = 62;
    return point.x < edge || point.x > panelCanvas.width - edge
      || point.y < 105 || point.y > panelCanvas.height - edge;
  }

  function controllerDirection(controller) {
    const direction = new THREE.Vector3(0, 0, -1);
    const quaternion = new THREE.Quaternion();
    controller.getWorldQuaternion(quaternion);
    return direction.applyQuaternion(quaternion).normalize();
  }

  function beginTrigger(controller) {
    if (dragState.controller) return;
    const intersection = raycastPanel(controller);
    const action = panelActionFromIntersection(intersection);
    dragState.controller = controller;
    dragState.type = panelVisible && intersection && isTimelineArea(intersection)
      ? 'seek'
      : panelVisible && intersection && isPanelDragArea(intersection) && !action
        ? 'panel'
        : panelVisible ? 'panel-click' : 'view';
    dragState.startTime = performance.now();
    dragState.startDirection = controllerDirection(controller);
    dragState.startYaw = videoRoot?.rotation.y || 0;
    dragState.startPitch = videoRoot?.rotation.x || 0;
    dragState.startPanelPosition = panelMesh?.position.clone() || null;
    dragState.startPanelQuaternion = panelMesh?.quaternion.clone() || null;
    dragState.seekTime = dragState.type === 'seek' ? timelineTimeFromIntersection(intersection) : getCurrentTime();
    dragState.moved = false;
    triggerStates.set(controller, { intersection, action });
  }

  function updateTriggerDrag() {
    const controller = dragState.controller;
    if (!controller) return;
    const elapsed = performance.now() - dragState.startTime;
    if (dragState.type === 'seek') {
      const intersection = raycastPanel(controller);
      if (intersection) {
        const nextTime = timelineTimeFromIntersection(intersection);
        dragState.moved = dragState.moved || Math.abs(nextTime - dragState.seekTime) > Math.max(1, getDuration() * 0.002);
        dragState.seekTime = nextTime;
        drawPanel();
      }
      return;
    }
    if (dragState.type === 'panel') {
      const direction = controllerDirection(controller);
      const distance = dragState.startPanelPosition?.length() || 1.35;
      const targetWorld = new THREE.Vector3().copy(direction).multiplyScalar(distance);
      const cameraWorld = new THREE.Vector3();
      camera.getWorldPosition(cameraWorld);
      targetWorld.add(cameraWorld);
      camera.worldToLocal(targetWorld);
      if (panelMesh && dragState.startPanelPosition) {
        panelMesh.position.lerp(targetWorld, 0.35);
        panelMesh.lookAt(cameraWorld);
        dragState.moved = dragState.moved || panelMesh.position.distanceToSquared(dragState.startPanelPosition) > 0.0004;
      }
      return;
    }
    if (dragState.type !== 'view' || elapsed < 280 || !videoRoot) return;
    const current = controllerDirection(controller);
    const start = dragState.startDirection;
    const startYaw = Math.atan2(start.x, -start.z);
    const currentYaw = Math.atan2(current.x, -current.z);
    const startPitch = Math.asin(THREE.MathUtils.clamp(start.y, -1, 1));
    const currentPitch = Math.asin(THREE.MathUtils.clamp(current.y, -1, 1));
    videoRoot.rotation.y = dragState.startYaw - (currentYaw - startYaw) * 1.35;
    videoRoot.rotation.x = THREE.MathUtils.clamp(dragState.startPitch + (currentPitch - startPitch) * 1.1, -Math.PI / 2, Math.PI / 2);
    dragState.moved = dragState.moved || Math.abs(currentYaw - startYaw) > 0.025 || Math.abs(currentPitch - startPitch) > 0.025;
  }

  function endTrigger(controller) {
    if (dragState.controller !== controller) return;
    const elapsed = performance.now() - dragState.startTime;
    const stored = triggerStates.get(controller) || {};
    if (dragState.type === 'seek') {
      seekAbsolute(dragState.seekTime);
      drawPanel();
    } else if (dragState.type === 'panel-click' && !dragState.moved) {
      const currentIntersection = raycastPanel(controller);
      const currentAction = panelActionFromIntersection(currentIntersection);
      if (stored.action && currentAction === stored.action) runAction(currentAction);
      else if (!stored.action && elapsed < 650) hidePanel();
    } else if (dragState.type === 'panel' && !dragState.moved && elapsed < 650) {
      hidePanel();
    } else if (dragState.type === 'view' && elapsed < 280 && !dragState.moved) {
      showPanel();
    }
    triggerStates.delete(controller);
    dragState.controller = null;
    dragState.type = '';
    dragState.startDirection = null;
    dragState.startPanelPosition = null;
    dragState.startPanelQuaternion = null;
    dragState.seekTime = 0;
    dragState.moved = false;
  }

  function updateControllerHover() {
    if (!panelVisible) {
      if (panelCursor) panelCursor.visible = false;
      return;
    }
    let nextHover = '';
    let cursorIntersection = null;
    for (const controller of controllers) {
      const intersection = raycastPanel(controller);
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) {
        const distance = intersection ? Math.max(0.03, intersection.distance) : 5;
        ray.scale.y = distance / 5;
        ray.position.z = -distance / 2;
      }
      if (intersection && !cursorIntersection) cursorIntersection = intersection;
      nextHover = panelActionFromIntersection(intersection);
      if (nextHover) { cursorIntersection = intersection; break; }
    }
    if (panelCursor) {
      panelCursor.visible = Boolean(cursorIntersection?.uv);
      if (cursorIntersection?.uv) {
        panelCursor.position.x = (cursorIntersection.uv.x - 0.5) * PANEL_WIDTH;
        panelCursor.position.y = (cursorIntersection.uv.y - 0.5) * PANEL_HEIGHT;
      }
    }
    if (nextHover !== hoverAction) {
      hoverAction = nextHover;
      drawPanel();
    }
  }

  function pollGamepads() {
    if (!xrSession) return;
    for (const inputSource of xrSession.inputSources) {
      const gamepad = inputSource.gamepad;
      if (!gamepad) continue;
      const previous = inputStates.get(inputSource) || [];
      const pressed = gamepad.buttons.map((button) => button.pressed);
      if (pressed[4] && !previous[4]) runAction('play');
      if (pressed[5] && !previous[5]) panelVisible ? hidePanel() : showPanel();
      const x = Math.abs(gamepad.axes[2] || 0) > Math.abs(gamepad.axes[0] || 0) ? gamepad.axes[2] : gamepad.axes[0];
      if (Date.now() - lastStickAction > 650) {
        if (x > 0.8) { lastStickAction = Date.now(); runAction('forward'); }
        else if (x < -0.8) { lastStickAction = Date.now(); runAction('back'); }
      }
      inputStates.set(inputSource, pressed);
    }
  }

  function showPanel() {
    panelVisible = true;
    if (panelMesh) panelMesh.visible = true;
    controllers.forEach((controller) => {
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) ray.visible = true;
    });
    drawPanel();
  }

  function hidePanel() {
    panelVisible = false;
    hoverAction = '';
    if (panelMesh) panelMesh.visible = false;
    if (panelCursor) panelCursor.visible = false;
    controllers.forEach((controller) => {
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) { ray.visible = false; ray.scale.y = 1; ray.position.z = -2.5; }
    });
  }

  function resetAll() {
    if (videoRoot) videoRoot.rotation.set(0, 0, 0);
    if (panelMesh) {
      panelMesh.position.set(PANEL_HOME.x, PANEL_HOME.y, PANEL_HOME.z);
      panelMesh.quaternion.identity();
      panelMesh.scale.set(1, 1, 1);
    }
    showPanel();
    if (statusEl) statusEl.textContent = '控制面板和视频视角已复位。';
    drawPanel();
  }

  function renderFrame(time) {
    if (!renderer || !world || !camera) return;
    configureEyeLayers();
    pollGamepads();
    updateTriggerDrag();
    updateControllerHover();
    if (time - lastPanelDraw > 250) {
      lastPanelDraw = time;
      drawPanel();
    }
    renderer.render(world, camera);
  }

  function bindMediaEvents(video, enabled) {
    if (!video) return;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    video[method]('timeupdate', drawPanel);
    video[method]('play', handleMediaReady);
    video[method]('pause', drawPanel);
    video[method]('loadedmetadata', handleMediaReady);
    video[method]('canplay', handleMediaReady);
    video[method]('error', handleMediaError);
  }

  function handleMediaReady() {
    if (this !== activeVideo) return;
    replaceVideoTexture(activeVideo);
    const label = sourceMode === 'compat' ? 'H.264/8-bit 兼容源' : '原始源';
    statusEl.textContent = `${label}已连接 · ${activeVideo.videoWidth || '?'}×${activeVideo.videoHeight || '?'} · 可进入 VR`;
    drawPanel();
  }

  function handleMediaError() {
    if (this !== activeVideo) return;
    const code = activeVideo.error?.code;
    statusEl.textContent = `视频源播放失败${code ? `（MediaError ${code}）` : ''}，请检查 Jellyfin 转码日志。`;
  }

  async function startCompatAt(position, shouldPlay = true) {
    if (!compatUrl) throw new Error('当前地址无法生成 Jellyfin H264 兼容源');
    const serial = ++loadSerial;
    const duration = getDuration();
    const target = Math.max(0, Math.min(Number(position) || 0, duration ? duration - 0.25 : Infinity));
    const url = new URL(compatUrl);
    setQueryParam(url, 'StartTimeTicks', Math.round(target * 10000000));
    const muted = activeVideo?.muted ?? sourceVideo.muted;
    const volume = activeVideo?.volume ?? sourceVideo.volume;
    bindMediaEvents(activeVideo, false);
    activeVideo?.pause?.();
    if (compatVideo) {
      compatVideo.removeAttribute('src');
      compatVideo.load();
      compatVideo.remove();
    }
    compatVideo = document.createElement('video');
    compatVideo.id = 'jvr-compat-video';
    compatVideo.preload = 'auto';
    compatVideo.playsInline = true;
    compatVideo.setAttribute('playsinline', '');
    compatVideo.setAttribute('webkit-playsinline', '');
    compatVideo.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
    compatVideo.muted = muted;
    compatVideo.volume = volume;
    compatOffset = target;
    sourceMode = 'compat';
    activeVideo = compatVideo;
    bindMediaEvents(activeVideo, true);
    overlay.appendChild(compatVideo);
    replaceVideoTexture(activeVideo);
    updateToolbar();
    statusEl.textContent = `正在从 ${formatTime(target)} 启动 H.264/8-bit 转码…`;
    compatVideo.src = url.href;
    compatVideo.load();
    if (shouldPlay) {
      try {
        await compatVideo.play();
      } catch (_) {
        if (serial === loadSerial) statusEl.textContent = '兼容源已建立；请按 PLAY 开始播放。';
      }
    }
  }

  async function useOriginalSource() {
    const position = getCurrentTime();
    const shouldPlay = !activeVideo?.paused;
    const muted = activeVideo?.muted ?? false;
    const volume = activeVideo?.volume ?? 1;
    ++loadSerial;
    bindMediaEvents(activeVideo, false);
    activeVideo?.pause?.();
    sourceMode = 'original';
    sourceVideo.currentTime = Math.max(0, Math.min(position, sourceVideo.duration || position));
    sourceVideo.muted = muted;
    sourceVideo.volume = volume;
    activeVideo = sourceVideo;
    bindMediaEvents(activeVideo, true);
    replaceVideoTexture(activeVideo);
    updateToolbar();
    statusEl.textContent = '已切回原始源。';
    if (shouldPlay) await sourceVideo.play().catch(() => {});
  }

  function toggleSource() {
    if (!compatUrl) return;
    const position = getCurrentTime();
    const shouldPlay = !activeVideo?.paused;
    if (sourceMode === 'compat') useOriginalSource();
    else startCompatAt(position, shouldPlay).catch((error) => {
      statusEl.textContent = `兼容源启动失败：${error?.message || error}`;
    });
  }

  function seekAbsolute(position) {
    const target = Math.max(0, Math.min(Number(position) || 0, getDuration() || Infinity));
    if (sourceMode !== 'compat') {
      activeVideo.currentTime = target;
      return;
    }
    const relative = target - compatOffset;
    if (relative >= 0 && Number.isFinite(activeVideo.duration) && relative <= activeVideo.duration) {
      activeVideo.currentTime = relative;
    } else {
      startCompatAt(target, !activeVideo.paused).catch((error) => {
        statusEl.textContent = `兼容源跳转失败：${error?.message || error}`;
      });
    }
  }

  function cycleProjection() {
    const values = ['360', '180', 'fisheye', 'flat'];
    currentMode.projection = values[(values.indexOf(currentMode.projection) + 1) % values.length];
    rebuildVideoMeshes();
  }

  function cycleStereo() {
    const values = ['mono', 'sbs', 'ou'];
    currentMode.stereo = values[(values.indexOf(currentMode.stereo) + 1) % values.length];
    rebuildVideoMeshes();
  }

  function runAction(action) {
    if (!activeVideo) return;
    if (action === 'play') activeVideo.paused ? activeVideo.play().catch(() => {}) : activeVideo.pause();
    else if (action === 'back') seekAbsolute(getCurrentTime() - 10);
    else if (action === 'forward') seekAbsolute(getCurrentTime() + 10);
    else if (action === 'mute') activeVideo.muted = !activeVideo.muted;
    else if (action === 'projection') cycleProjection();
    else if (action === 'stereo') cycleStereo();
    else if (action === 'swap') { currentMode.swap = !currentMode.swap; rebuildVideoMeshes(); }
    else if (action === 'source') toggleSource();
    else if (action === 'reset') resetAll();
    else if (action === 'hide') hidePanel();
    else if (action === 'exit-vr') exitVrOnly(true);
    drawPanel();
  }

  function updateToolbar() {
    if (!overlay) return;
    overlay.querySelectorAll('[data-action="projection"][data-value]').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === currentMode.projection);
    });
    overlay.querySelectorAll('[data-action="stereo"][data-value]').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === currentMode.stereo);
    });
    const sourceButton = overlay.querySelector('#jvr-source-toggle');
    if (sourceButton) {
      sourceButton.textContent = sourceMode === 'compat' ? 'H264 兼容源 ✓' : '原始源';
      sourceButton.classList.toggle('active', sourceMode === 'compat');
      sourceButton.disabled = !compatUrl;
    }
  }

  async function enterVr() {
    if (!window.isSecureContext) return alert('WebXR 需要 HTTPS。');
    if (!navigator.xr) return alert('当前浏览器没有 WebXR。');
    if (!renderer) return alert('WebXR 渲染器尚未初始化。');
    try {
      // requestSession must run directly in the Enter VR click's user-activation task.
      const sessionPromise = navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      });
      activeVideo?.play?.().catch(() => {});
      xrSession = await sessionPromise;
      xrSession.addEventListener('end', () => {
        xrSession = null;
        hidePanel();
        if (!closing && statusEl) statusEl.textContent = '已退出 VR，可再次进入或返回 Jellyfin。';
      }, { once: true });
      await renderer.xr.setSession(xrSession);
      statusEl.textContent = '已进入原生 WebXR。按扳机打开控制面板。';
      setTimeout(showPanel, 350);
    } catch (error) {
      alert(`进入 VR 失败：${error?.message || error}`);
    }
  }

  async function exitVrOnly(closeAfter = false) {
    try {
      const session = xrSession || renderer?.xr?.getSession?.();
      if (session) await session.end();
    } catch (_) {}
    if (closeAfter) closePlayer();
  }

  function handleToolbar(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, value } = button.dataset;
    if (action === 'exit') closePlayer();
    else if (action === 'enter') enterVr();
    else if (action === 'projection') { currentMode.projection = value; rebuildVideoMeshes(); }
    else if (action === 'stereo') { currentMode.stereo = value; rebuildVideoMeshes(); }
    else if (action === 'swap') { currentMode.swap = !currentMode.swap; rebuildVideoMeshes(); }
    else if (action === 'source') toggleSource();
  }

  async function openPlayer() {
    if (overlay) return;
    sourceVideo = findVideo();
    if (!sourceVideo) return alert('请先在 Jellyfin 中开始播放视频。');
    try {
      activeVideo = sourceVideo;
      compatUrl = buildCompatStreamUrl(sourceVideo);
      originalState = {
        currentTime: sourceVideo.currentTime || 0,
        duration: sourceVideo.duration || 0,
        paused: sourceVideo.paused,
        muted: sourceVideo.muted,
        volume: sourceVideo.volume
      };
      await ensureThree();
      buildOverlay();
      savedVideoId = sourceVideo.id;
      if (!sourceVideo.id) sourceVideo.id = 'jvr-source-video';
      buildRenderer();
      bindMediaEvents(sourceVideo, true);
      replaceVideoTexture(sourceVideo);
      updateToolbar();
      statusEl.textContent = `原生 WebXR 已就绪 · 原始源 ${sourceVideo.videoWidth || '?'}×${sourceVideo.videoHeight || '?'}`;
      sourceVideo.play().catch(() => {});
    } catch (error) {
      closePlayer();
      alert(`VR 播放器初始化失败：${error?.message || error}`);
    }
  }

  function closePlayer() {
    if (closing) return;
    closing = true;
    const finalTime = getCurrentTime();
    const finalMuted = activeVideo?.muted;
    const finalVolume = activeVideo?.volume;
    const session = xrSession || renderer?.xr?.getSession?.();
    session?.end?.().catch?.(() => {});
    xrSession = null;
    ++loadSerial;
    bindMediaEvents(activeVideo, false);
    if (compatVideo) {
      compatVideo.pause();
      compatVideo.removeAttribute('src');
      compatVideo.load();
      compatVideo.remove();
      compatVideo = null;
    }
    if (sourceVideo) {
      bindMediaEvents(sourceVideo, false);
      if (Number.isFinite(finalTime)) sourceVideo.currentTime = Math.min(finalTime, sourceVideo.duration || finalTime);
      if (typeof finalMuted === 'boolean') sourceVideo.muted = finalMuted;
      if (Number.isFinite(finalVolume)) sourceVideo.volume = finalVolume;
      sourceVideo.id = savedVideoId;
      sourceVideo.play().catch(() => {});
    }
    renderer?.setAnimationLoop?.(null);
    disposeVideoMeshes();
    videoTexture?.dispose?.();
    panelMesh?.geometry?.dispose?.();
    panelMesh?.material?.dispose?.();
    panelBorder?.geometry?.dispose?.();
    panelBorder?.material?.dispose?.();
    panelCursor?.traverse?.((object) => {
      if (object !== panelCursor) object.geometry?.dispose?.();
      if (object !== panelCursor) object.material?.dispose?.();
    });
    panelCursor?.geometry?.dispose?.();
    panelCursor?.material?.dispose?.();
    panelTexture?.dispose?.();
    controllers.forEach((controller) => {
      const gripTimer = gripTimers.get(controller);
      if (gripTimer) clearTimeout(gripTimer);
      gripTimers.delete(controller);
      controller.children.forEach((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
    });
    renderer?.dispose?.();
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    overlay?.remove();
    overlay = null;
    statusEl = null;
    sourceVideo = null;
    activeVideo = null;
    originalState = null;
    compatUrl = '';
    compatOffset = 0;
    sourceMode = 'original';
    savedVideoId = '';
    world = null;
    camera = null;
    renderer = null;
    videoTexture = null;
    videoMeshes = [];
    videoRoot = null;
    controllers = [];
    panelMesh = null;
    panelCanvas = null;
    panelContext = null;
    panelTexture = null;
    panelBorder = null;
    panelCursor = null;
    panelButtons = [];
    panelVisible = false;
    hoverAction = '';
    resizeHandler = null;
    dragState.controller = null;
    dragState.type = '';
    dragState.startDirection = null;
    dragState.startPanelPosition = null;
    dragState.startPanelQuaternion = null;
    dragState.seekTime = 0;
    dragState.moved = false;
    closing = false;
  }

  function locateControls() {
    const fullscreen = document.querySelector('.btnFullscreen,[aria-label="Fullscreen"],[aria-label="全屏"],[title="Fullscreen"],[title="全屏"],.button-fullscreen');
    if (fullscreen?.parentElement) return { parent: fullscreen.parentElement, before: fullscreen };
    const bar = document.querySelector('.videoOsdBottom .buttons,.videoOsdBottom,.osdControls,.videoControls,[class*="videoOsdBottom"]');
    return bar ? { parent: bar, before: null } : null;
  }

  function addVrButton() {
    if (document.getElementById(BUTTON_ID) || !findVideo()) return;
    const target = locateControls();
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'VR';
    button.title = 'Jellyfin VR Player v4.2';
    button.setAttribute('aria-label', 'VR Player');
    button.onclick = openPlayer;
    if (target) {
      button.className = 'autoSize paper-icon-button-light';
      button.style.cssText = 'min-width:42px;height:42px;border:0;background:transparent;color:inherit;font-weight:800;font-size:13px;cursor:pointer';
      target.parent.insertBefore(button, target.before);
    } else {
      button.style.cssText = 'position:fixed;right:18px;bottom:90px;z-index:2147483000;width:50px;height:50px;border:1px solid #ffffff55;border-radius:50%;background:#006d91e8;color:#fff;font-weight:800;cursor:pointer';
      document.body.append(button);
    }
  }

  function scan() {
    const button = document.getElementById(BUTTON_ID);
    if (findVideo()) addVrButton();
    else button?.remove();
  }

  function init() {
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scanTimer = setInterval(scan, 1000);
    window.addEventListener('beforeunload', () => clearInterval(scanTimer), { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
