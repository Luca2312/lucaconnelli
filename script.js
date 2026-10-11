// Scroll-driven "video": the animation is fixed behind the whole site and its frame follows the page scroll.
// Scroll down → plays forward, stop scrolling → pauses, scroll up → plays backward.
//
// Instead of seeking a <video> (slow and glitchy: every seek decodes a heavy H.264 frame),
// the video is pre-exported as an AVIF image sequence (see estrai_frame.py) and drawn on a <canvas>.
// Showing a frame is then a single drawImage call, which runs smoothly even on basic computers.

const FRAME_COUNT = 501;   // number of files in each assets/frames/<set>/ folder
const FPS = 25;            // frame rate of the source video
const DURATION = FRAME_COUNT / FPS;
const PX_PER_SECOND = 450; // scroll distance for one second of video: the page length is derived from the duration
const SMOOTHING = 0.25;    // 0–1, how fast the image catches up with the scroll (1 = instant)
const MAX_PARALLEL = 6;    // simultaneous image downloads

const canvas = document.getElementById('scrubCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const fill = document.getElementById('progressFill');
const frameNum = document.getElementById('frameNum');
const timeNum = document.getElementById('timeNum');
const loader = document.getElementById('loader');
const loadPct = document.getElementById('loadPct');
const ticks = document.getElementById('progressTicks');
const blocks = [...document.querySelectorAll('.block')];
const footer = document.querySelector('.footer');
const hero = document.querySelector('.hero');
const heroInner = document.getElementById('heroInner');

const frames = new Array(FRAME_COUNT); // Image once loaded, undefined before
let targetFrame = 0;
let currentFrame = 0;
let drawnFrame = -1;
let shownIndex = -1;

// ---------- Frame set ----------
// Full original resolution on large screens, 1080 px on phones/small windows (they could not show more).
// AVIF keeps the original quality at a small weight; WebP only for old browsers without AVIF.
const SOURCE_SIZE = 1920; // side of the original video, in px

// Try to decode a real (small) AVIF frame: if the browser can't, fall back to WebP.
function supportsAvif() {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = 'assets/frames/avif-1080/0000.avif';
  });
}

let frameUrl;
async function pickFrameSet() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const needed = Math.max(window.innerWidth, window.innerHeight) * dpr;
  if (!(await supportsAvif())) {
    frameUrl = i => `assets/frames/webp-1080/${String(i).padStart(4, '0')}.webp`;
  } else {
    const folder = needed > 1100 ? 'avif-full' : 'avif-1080';
    frameUrl = i => `assets/frames/${folder}/${String(i).padStart(4, '0')}.avif`;
  }
}

// ---------- Progressive loading ----------
// Every 16th frame first, then every 8th, 4th, 2nd, all: the site is usable almost
// immediately with a coarse animation that gets finer while the rest downloads.
function loadOrder() {
  const order = [];
  const seen = new Set();
  for (const step of [16, 8, 4, 2, 1]) {
    for (let i = 0; i < FRAME_COUNT; i += step) {
      if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
    if (!seen.has(FRAME_COUNT - 1)) { seen.add(FRAME_COUNT - 1); order.push(FRAME_COUNT - 1); }
  }
  return order;
}

function loadFrames() {
  const queue = loadOrder();
  const firstPass = Math.ceil(FRAME_COUNT / 16) + 1;
  let loaded = 0;

  return new Promise(resolveFirstPass => {
    const next = () => {
      const i = queue.shift();
      if (i === undefined) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = img.onerror = () => {
        if (img.naturalWidth) frames[i] = img;
        loaded++;
        if (loaded <= firstPass) loadPct.textContent = Math.round((loaded / firstPass) * 100);
        if (loaded === firstPass) resolveFirstPass();
        drawnFrame = -1; // a closer frame may now be available
        next();
      };
      img.src = frameUrl(i);
    };
    for (let k = 0; k < MAX_PARALLEL; k++) next();
  });
}

// Nearest frame that has already been downloaded
function nearestLoaded(i) {
  for (let d = 0; d < FRAME_COUNT; d++) {
    if (frames[i - d]) return i - d;
    if (frames[i + d]) return i + d;
  }
  return -1;
}

// ---------- Canvas drawing (object-fit: cover on landscape screens) ----------
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = window.innerWidth * dpr;
  let h = window.innerHeight * dpr;
  // Never render more pixels than the source has: same sharpness, less work for weak GPUs
  const over = Math.max(w, h) / SOURCE_SIZE;
  if (over > 1) { w /= over; h /= over; }
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  ctx.imageSmoothingQuality = 'high';
  drawnFrame = -1;
}

// Portrait screens (phones): "cover" would crop the square video at the sides and cut the glasses.
// There the frame is fitted to the width instead, and the empty bands above and below are filled
// with the frame's own edge colours, blended in with a short gradient so no seam shows.
const probe = document.createElement('canvas');
probe.width = 1; probe.height = 2;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
const edgeColors = new Array(FRAME_COUNT); // cached [top, bottom] per frame

function getEdgeColors(i, img) {
  if (!edgeColors[i]) {
    // average of the top and bottom 4% rows of the frame, squeezed into 1 × 2 pixels
    const sw = img.naturalWidth, sh = Math.round(img.naturalHeight * 0.04);
    probeCtx.drawImage(img, 0, 0, sw, sh, 0, 0, 1, 1);
    probeCtx.drawImage(img, 0, img.naturalHeight - sh, sw, sh, 0, 1, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 2).data;
    edgeColors[i] = [`${d[0]},${d[1]},${d[2]}`, `${d[4]},${d[5]},${d[6]}`]; // "r,g,b" strings
  }
  return edgeColors[i];
}

function draw(index) {
  const i = nearestLoaded(index);
  if (i < 0 || i === drawnFrame) return;
  const img = frames[i];
  const cw = canvas.width, ch = canvas.height;
  const portrait = ch > cw;
  const scale = portrait
    ? cw / img.naturalWidth
    : Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const x = (cw - w) / 2, y = (ch - h) / 2;

  if (portrait && h < ch) {
    const [top, bottom] = getEdgeColors(i, img);
    ctx.fillStyle = `rgb(${top})`;    ctx.fillRect(0, 0, cw, ch / 2);
    ctx.fillStyle = `rgb(${bottom})`; ctx.fillRect(0, ch / 2, cw, ch / 2);
    ctx.drawImage(img, x, y, w, h);
    const fade = h * 0.12;
    let g = ctx.createLinearGradient(0, y, 0, y + fade);
    g.addColorStop(0, `rgb(${top})`); g.addColorStop(1, `rgba(${top},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, y, cw, fade);
    g = ctx.createLinearGradient(0, y + h, 0, y + h - fade);
    g.addColorStop(0, `rgb(${bottom})`); g.addColorStop(1, `rgba(${bottom},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, y + h - fade, cw, fade);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  drawnFrame = i;
}

// ---------- Page length & scroll ----------
// Size the page so the total scroll distance is exactly DURATION × PX_PER_SECOND:
// the sections share that length evenly and the site ends on the last frame of the video.
function layout() {
  const scrollable = DURATION * PX_PER_SECOND;
  const free = scrollable + window.innerHeight - footer.offsetHeight - hero.offsetHeight;
  document.documentElement.style.setProperty('--block-h', `${free / blocks.length}px`);
  updateTarget();
}

// Timeline labels in seconds, one every quarter of the video.
function renderTicks() {
  ticks.innerHTML = [0, 0.25, 0.5, 0.75, 1]
    .map(f => `<span>${(f * DURATION).toFixed(1)}s</span>`).join('');
}

function scrollProgress() {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  return scrollable > 0 ? Math.min(Math.max(window.scrollY / scrollable, 0), 1) : 0;
}

function updateTarget() {
  const p = scrollProgress();
  targetFrame = p * (FRAME_COUNT - 1);
  fill.style.transform = `scaleX(${p})`;

  // Hero text stays pinned in the bottom band and fades out within the first ~third of a screen,
  // so it never scrolls up across the subject
  const h = Math.min(window.scrollY / (window.innerHeight * 0.3), 1);
  heroInner.style.opacity = 1 - h;
  heroInner.style.transform = `translateY(${Math.min(window.scrollY, window.innerHeight * 0.3)}px)`;
  heroInner.style.visibility = h >= 1 ? 'hidden' : '';
}

function tick() {
  currentFrame += (targetFrame - currentFrame) * SMOOTHING;
  if (Math.abs(targetFrame - currentFrame) < 0.05) currentFrame = targetFrame;

  const index = Math.round(currentFrame);
  if (index !== shownIndex) {
    frameNum.textContent = String(index).padStart(4, '0');
    timeNum.textContent = (index / FPS).toFixed(2).padStart(5, '0');
    shownIndex = index;
  }
  draw(index);
  requestAnimationFrame(tick);
}

// ---------- Gallery: deck → fan (hover) → grid (click) → single image ----------
// One deck per project; its data-gallery attribute names the grid <dialog> holding that project's images.
const DECK_SIZE = 5; // cards shown in each stacked deck
const lightbox = document.getElementById('lightbox');
const lbImg = lightbox.querySelector('img');
const lbCaption = document.getElementById('lbCaption');
const lbCount = document.getElementById('lbCount');
let lbItems = [];
let lbIndex = 0;

document.querySelectorAll('.deck').forEach(deck => {
  const gridDialog = document.getElementById(deck.dataset.gallery);
  const gridItems = [...gridDialog.querySelectorAll('.grid-item')];
  deck.parentElement.querySelector('.deck-count').textContent = gridItems.length;

  // Build the deck from the first grid images; the first image ends up on top
  const deckItems = gridItems.slice(0, DECK_SIZE).reverse();
  deckItems.forEach((item, i) => {
    const card = document.createElement('span');
    card.className = 'deck-card';
    card.style.setProperty('--i', deckItems.length - 1 - i);     // offset in the pile
    card.style.setProperty('--off', i - (deckItems.length - 1)); // position in the fan: top card stays, the others spread out
    const img = item.querySelector('img').cloneNode();
    img.alt = '';
    card.append(img);
    deck.append(card);
  });

  // Open the grid: each image flies out from the deck to its place in the grid
  deck.addEventListener('click', () => {
    gridDialog.showModal();
    gridDialog.scrollTop = 0;
    const from = deck.getBoundingClientRect();
    gridItems.forEach((item, i) => {
      const to = item.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const scale = from.width / to.width;
      const rot = (i - (gridItems.length - 1) / 2) * 4;
      item.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${rot}deg)`, opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: 'none', opacity: 1 },
      ], { duration: 650, delay: i * 35, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'backwards' });
    });
  });

  // The whole project card (title, "Open gallery") opens it too, not just the deck
  deck.closest('.project').addEventListener('click', e => { if (!deck.contains(e.target)) deck.click(); });

  gridItems.forEach((item, i) => item.addEventListener('click', () => {
    lbItems = gridItems;
    showImage(i);
    lightbox.showModal();
  }));
});

// Single image view with previous / next, within the current project
function showImage(i) {
  lbIndex = (i + lbItems.length) % lbItems.length;
  const item = lbItems[lbIndex];
  const alt = item.querySelector('img').alt;
  lbImg.src = item.dataset.full;
  lbImg.alt = alt;
  lbCaption.textContent = alt;
  lbCount.textContent = `${String(lbIndex + 1).padStart(2, '0')} / ${String(lbItems.length).padStart(2, '0')}`;
  // preload the neighbours so next / previous are instant
  [lbIndex - 1, lbIndex + 1].forEach(n => {
    new Image().src = lbItems[(n + lbItems.length) % lbItems.length].dataset.full;
  });
}
lightbox.querySelector('.lb-prev').addEventListener('click', () => showImage(lbIndex - 1));
lightbox.querySelector('.lb-next').addEventListener('click', () => showImage(lbIndex + 1));
lightbox.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') showImage(lbIndex - 1);
  if (e.key === 'ArrowRight') showImage(lbIndex + 1);
});

// Close buttons, and a click on the empty area around the content (Esc works natively)
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
});

// ---------- Start ----------
resizeCanvas();
renderTicks();
layout();
window.addEventListener('scroll', updateTarget, { passive: true });
window.addEventListener('resize', () => { resizeCanvas(); layout(); });

pickFrameSet().then(loadFrames).then(() => {
  loader.classList.add('done');
  requestAnimationFrame(tick);
});
