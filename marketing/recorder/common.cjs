// Shared helpers for recording Gem Jam ad clips from the game's ?capture mode.
// Usage: node <clip>.cjs <outDir>. Needs `npx vite preview --port 4191 --base /critter-jam/` running.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FPS = 30;

const AD_CSS = `
  #hint, #toast, .hud-top, .hud-mid { display: none !important; }
  .ad-layer { position: absolute; inset: 0; pointer-events: none; z-index: 50; font-family: 'Inter', 'Noto Color Emoji', sans-serif; }
  .ad-cap { position: absolute; left: 0; right: 0; top: 10px; text-align: center; }
  .ad-cap span { display: inline-block; background: #ffe14d; color: #2a2414; font-weight: 900; font-size: 24px; line-height: 1.15;
    padding: 9px 16px 10px; border-radius: 16px; box-shadow: 0 5px 0 rgba(0,0,0,0.22); transform: rotate(-2deg); max-width: 300px; }
  .ad-cap.white span { background: #ffffff; }
  .ad-count { position: absolute; left: 0; right: 0; top: 88px; text-align: center; color: #fff; font-weight: 900; font-size: 40px;
    text-shadow: 0 4px 0 rgba(0,0,0,0.3), 0 0 18px rgba(0,0,0,0.25); }
  .ad-end { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    background: radial-gradient(circle at 50% 38%, rgba(255,120,200,0.35), rgba(0,0,0,0) 55%), linear-gradient(180deg, #2a2f55 0%, #1e2a44 60%, #171c33 100%); color: #ffffff; text-align: center; }
  .ad-end h1 { font-size: 54px; font-weight: 900; margin: 0; color: #fff; text-shadow: 0 5px 0 #7a2fa0, 0 10px 24px rgba(255,90,200,0.35); letter-spacing: -1px; line-height: 1; }
  .ad-end p { font-size: 22px; font-weight: 800; margin: 0 24px; color: #e8e6ff; }
  .ad-end .cta { margin-top: 10px; background: #ff8a3d; color: #fff; font-size: 26px; font-weight: 900; padding: 14px 34px; border-radius: 40px; box-shadow: 0 6px 0 #c4561a; }
  .ad-end .em { font-size: 74px; line-height: 1; }
`;

async function open(url, { dpr = 3 } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(url);
  await page.waitForTimeout(1500);
  await installLayer(page);
  return { browser, page };
}

/** The caption/counter/end-card layer. Call again after any page.goto, which wipes it. */
async function installLayer(page) {
  await page.addStyleTag({ content: AD_CSS });
  await page.evaluate(() => {
    document.querySelector('.ad-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'ad-layer';
    layer.innerHTML = '<div class="ad-cap"></div><div class="ad-count"></div><div class="ad-end" style="display:none"></div>';
    document.getElementById('stage').appendChild(layer);
  });
}

async function setCaption(page, html, cls = '') {
  await page.evaluate(([h, c]) => {
    const el = document.querySelector('.ad-cap');
    el.className = 'ad-cap ' + c;
    el.innerHTML = h ? `<span>${h}</span>` : '';
  }, [html, cls]);
}

async function setCount(page, text) {
  await page.evaluate((t) => (document.querySelector('.ad-count').textContent = t), text);
}

async function endCard(page, html) {
  await page.evaluate((h) => {
    const el = document.querySelector('.ad-end');
    el.innerHTML = h;
    el.style.display = 'flex';
    document.querySelector('.ad-cap').innerHTML = '';
    document.querySelector('.ad-count').textContent = '';
  }, html);
}

class Frames {
  constructor(dir) {
    this.dir = dir;
    this.n = 0;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  async shoot(page, times = 1) {
    const file = path.join(this.dir, `f${String(this.n).padStart(5, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    this.n++;
    for (let i = 1; i < times; i++) {
      fs.copyFileSync(file, path.join(this.dir, `f${String(this.n).padStart(5, '0')}.jpg`));
      this.n++;
    }
  }
  get seconds() {
    return this.n / FPS;
  }
}

function encode(framesDir, out) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%05d.jpg'),
    '-vf', 'scale=1080:1920:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
}

module.exports = { open, installLayer, setCaption, setCount, endCard, Frames, encode, FPS };
