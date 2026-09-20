#!/usr/bin/env node
/*
 * Renders a camera tour of the plugin's theater and encodes it to MP4.
 *
 * The room is not re-created here. The plugin source is wrapped so its IIFE
 * scope can be reached from outside, loaded into a headless Chromium page, and
 * driven through its own buildTheater / applySeat / applyLightLevel. What you
 * see in the video is the geometry the headset draws, at the same 16 draw calls
 * and ~19k triangles.
 *
 *   node tools/make-showcase.mjs
 *   node tools/make-showcase.mjs --out demo.mp4 --width 2560 --height 1440
 *   node tools/make-showcase.mjs --video "out/JVR Test 01 - Theater Tour (2D).mp4"
 *   node tools/make-showcase.mjs --stills 12    # PNG contact sheet, no encode
  node tools/make-showcase.mjs --at 70.5 --at 73.5   # stills at exact times
 *
 * Needs ffmpeg on PATH and a Playwright Chromium. Rendering is software
 * (SwiftShader), so it is nowhere near real time - budget a few minutes.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PLUGIN = join(ROOT, 'Jellyfin supports plugins for VR.js');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js';
const THREE_CACHE = join(homedir(), '.cache', 'jellyfinvr-tools', 'three-0.160.1.min.js');

const DEFAULT_SCREEN_VIDEOS = [
  join(ROOT, 'out', 'JVR Test 01 - Theater Tour (2D).mp4'),
  join(ROOT, 'jvr-test-clips', 'JVR Test 01 - Theater Tour (2D).mp4'),
];

function parseArgs(argv) {
  const options = {
    out: join(ROOT, 'jvr-theater-showcase.mp4'),
    width: 1920, height: 1080, fps: 30, fov: 62,
    crf: 18, preset: 'medium', video: null, stills: 0, at: [], keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--out') options.out = resolve(next());
    else if (arg === '--width') options.width = Number(next());
    else if (arg === '--height') options.height = Number(next());
    else if (arg === '--fps') options.fps = Number(next());
    else if (arg === '--fov') options.fov = Number(next());
    else if (arg === '--crf') options.crf = Number(next());
    else if (arg === '--preset') options.preset = next();
    else if (arg === '--video') options.video = resolve(next());
    else if (arg === '--no-video') options.video = false;
    else if (arg === '--stills') options.stills = Number(next());
    else if (arg === '--at') options.at.push(Number(next()));
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--help' || arg === '-h') { console.log(helpText()); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  return options;
}

function helpText() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('*/')[0].replace(/^#!.*\n/, '').replace(/\/\*\n?/, '').replace(/^ \* ?/gm, '');
}

function which(binary) {
  return spawnSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).stdout.trim();
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const specifier of ['playwright', 'playwright-core',
    join(process.env.HOME, '.nvm/versions/node', process.version, 'lib/node_modules/playwright')]) {
    try { return require(specifier); } catch (_) { /* keep looking */ }
  }
  const global = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
  if (global) { try { return require(join(global, 'playwright')); } catch (_) { /* fall through */ } }
  console.error('Playwright not found. Install it with:  npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

async function ensureThree() {
  if (existsSync(THREE_CACHE)) return THREE_CACHE;
  mkdirSync(dirname(THREE_CACHE), { recursive: true });
  process.stdout.write('fetching three.js r160.1 ... ');
  const response = await fetch(THREE_URL);
  if (!response.ok) throw new Error(`three.js download failed: HTTP ${response.status}`);
  writeFileSync(THREE_CACHE, Buffer.from(await response.arrayBuffer()));
  console.log('cached');
  return THREE_CACHE;
}

/*
 * The plugin is one IIFE in strict mode with no exports. Prefixing an
 * assignment and injecting a `return` before its closing `})();` hands back a
 * direct `eval` bound to that scope - enough to read its constants, swap its
 * DOM-bound functions for stubs and call its builders, without copying a line
 * of it. Nothing else about the file is touched.
 */
function exposePlugin(source) {
  const tail = source.trimEnd();
  const marker = '})();';
  if (!tail.endsWith(marker)) {
    throw new Error('plugin source does not end in the expected IIFE - cannot expose its scope');
  }
  return `window.__JVR__ = ${tail.slice(0, -marker.length)}
  return { run: (code) => eval(code) };
})();
`;
}

const CONTENT_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

/* Chromium gives every file:// document an opaque origin, so a video loaded
 * that way taints the WebGL context and cannot be used as a texture. Serving
 * the harness over loopback keeps page and video on one real origin. */
function serve(directory) {
  return new Promise((ready) => {
    const server = createServer((request, response) => {
      const path = join(directory, decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, ''));
      if (!path.startsWith(directory) || !existsSync(path)) {
        response.writeHead(404).end('not found');
        return;
      }
      const size = statSync(path).size;
      const type = CONTENT_TYPES[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream';
      // Range support: the video element asks for one before it will seek.
      const range = request.headers.range;
      if (range) {
        const [start, end] = range.replace('bytes=', '').split('-');
        const from = Number(start);
        const to = end ? Number(end) : size - 1;
        response.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${from}-${to}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': to - from + 1,
        });
        createReadStream(path, { start: from, end: to }).pipe(response);
        return;
      }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(path).pipe(response);
    });
    server.listen(0, '127.0.0.1', () => ready({ server, port: server.address().port }));
  });
}

/* Playwright's Chromium ships without the proprietary H.264 decoder, so an MP4
 * loads its metadata and then dies with a decode error. VP9 is built in, and
 * the result is cached next to the source so a re-render does not pay for it
 * twice. */
function prepareScreenVideo(source, ffmpeg, destination) {
  if (source.toLowerCase().endsWith('.webm')) {
    copyFileSync(source, destination);
    return;
  }
  const cache = join(dirname(THREE_CACHE), `screen-${Buffer.from(source).toString('base64url').slice(-40)}.webm`);
  if (!existsSync(cache) || statSync(cache).mtimeMs < statSync(source).mtimeMs) {
    process.stdout.write('transcoding screen video to VP9 ... ');
    const result = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-an',
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34',
      '-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1', cache,
    ], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('screen video transcode failed');
    console.log('cached');
  }
  copyFileSync(cache, destination);
}

function pickScreenVideo(options) {
  if (options.video === false) return null;
  if (options.video) {
    if (!existsSync(options.video)) { console.error(`--video not found: ${options.video}`); process.exit(1); }
    return options.video;
  }
  return DEFAULT_SCREEN_VIDEOS.find((path) => existsSync(path)) || null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) {
    console.error('ffmpeg is not on PATH (Arch: sudo pacman -S ffmpeg). '
      + 'It is needed to encode the tour, and to transcode the screen video for Chromium.');
    process.exit(1);
  }
  const { chromium } = loadPlaywright();
  const threePath = await ensureThree();

  const work = mkdtempSync(join(tmpdir(), 'jvr-showcase-'));
  copyFileSync(threePath, join(work, 'three.min.js'));
  copyFileSync(join(HERE, 'showcase', 'showcase.js'), join(work, 'showcase.js'));
  copyFileSync(join(HERE, 'showcase', 'harness.html'), join(work, 'harness.html'));
  writeFileSync(join(work, 'plugin-exposed.js'), exposePlugin(readFileSync(PLUGIN, 'utf8')));

  const screenVideo = pickScreenVideo(options);
  if (screenVideo) prepareScreenVideo(screenVideo, ffmpeg, join(work, 'screen.webm'));
  const { server, port } = await serve(work);
  console.log(`room     : ${PLUGIN.split('/').pop()}`);
  console.log(`screen   : ${screenVideo ? screenVideo.split('/').pop() : 'none (screen stays dark)'}`);
  console.log(`output   : ${options.width}x${options.height} @ ${options.fps}fps`);

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           // Keep video decode off the GPU process; it shares one with WebGL,
           // and a software VP9 decode there takes the GL context down with it.
           '--disable-accelerated-video-decode', '--disable-gpu-memory-buffer-video-frames',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
  });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });

  await page.goto(`http://127.0.0.1:${port}/harness.html`);
  if (screenVideo) await page.addScriptTag({ content: "window.__screenVideoSrc = 'screen.webm';" });

  const info = await page.evaluate(
    (opts) => window.JVRShowcase.boot(opts),
    { width: options.width, height: options.height, fov: options.fov }
  );
  if (screenVideo) {
    await page.evaluate(async () => {
      const video = document.createElement('video');
      video.src = window.__screenVideoSrc;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      document.body.appendChild(video);
      await new Promise((done, fail) => {
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', () => {
          const error = video.error || {};
          fail(new Error(`screen video failed to load: code ${error.code} ${error.message || ''}`));
        }, { once: true });
      });
      video.pause();
      window.JVRShowcase.setScreen(video);
    });
  }

  if (failures.length) { console.error('page errors:\n  ' + failures.join('\n  ')); await browser.close(); process.exit(1); }
  console.log(`tour     : ${info.duration}s, ${info.shots.length} shots\n`);

  const totalFrames = Math.round(info.duration * options.fps);

  if (options.stills || options.at.length) {
    const dir = options.out.replace(/\.mp4$/, '') + '-stills';
    mkdirSync(dir, { recursive: true });
    const times = options.at.length
      ? options.at
      : Array.from({ length: options.stills }, (_, shot) => (info.duration * (shot + 0.45)) / options.stills);
    for (const [index, time] of times.entries()) {
      await renderFrame(page, time, screenVideo);
      const name = options.at.length ? `at-${time.toFixed(1)}s` : `still-${String(index).padStart(2, '0')}`;
      await page.screenshot({ path: join(dir, `${name}.png`) });
      process.stdout.write(`\r  still ${index + 1}/${times.length}`);
    }
    console.log(`\n  -> ${dir}`);
    await browser.close();
    server.close();
    return;
  }

  const encoder = spawn(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(options.fps), '-i', '-',
    '-c:v', 'libx264', '-preset', options.preset, '-crf', String(options.crf),
    '-pix_fmt', 'yuv420p', '-g', String(options.fps * 2),
    '-movflags', '+faststart', options.out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const started = Date.now();
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / options.fps;
    await renderFrame(page, time, screenVideo);
    const png = await page.screenshot({ type: 'png' });
    if (!encoder.stdin.write(png)) await new Promise((done) => encoder.stdin.once('drain', done));
    if (frame % options.fps === 0 || frame === totalFrames - 1) {
      const done = (frame + 1) / totalFrames;
      const elapsed = (Date.now() - started) / 1000;
      const eta = done > 0 ? elapsed / done - elapsed : 0;
      process.stdout.write(`\r  ${(done * 100).toFixed(1)}%  frame ${frame + 1}/${totalFrames}  `
        + `${(elapsed / (frame + 1)).toFixed(2)}s/frame  eta ${Math.round(eta)}s   `);
    }
  }
  encoder.stdin.end();
  await new Promise((done, fail) => {
    encoder.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
  });
  await browser.close();
  server.close();
  console.log(`\n\n${options.out}`);
  if (!options.keepTemp) console.log(`(harness left in ${work})`);
}

/* Video frames are pulled by seeking rather than by playing: capture runs far
 * slower than real time, so a playing element would race ahead of the render. */
async function renderFrame(page, time, screenVideo) {
  if (screenVideo) {
    await page.evaluate(async (t) => {
      const video = window.__stage.video;
      if (!video || !video.duration) return;
      const target = t % video.duration;
      if (Math.abs(video.currentTime - target) < 0.001) return;
      await new Promise((done) => {
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = target;
      });
    }, time);
  }
  await page.evaluate((t) => window.JVRShowcase.renderAt(t), time);
}

main().catch((error) => { console.error(error); process.exit(1); });
