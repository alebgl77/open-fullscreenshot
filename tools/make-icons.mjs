/**
 * FullShot — icon rasterizer.
 *
 * Node 18+ ESM, zero dependencies. Rasterizes icons/icon.svg to the four PNG
 * sizes the manifest references (16/32/48/128).
 *
 * Primary path: headless Chrome takes a transparent screenshot of a tiny HTML
 * wrapper that embeds the SVG at exactly n x n. Each output is verified to be
 * a real PNG of the right size by parsing its IHDR chunk.
 *
 * Fallback (Chrome not found, or a screenshot fails verification): a flat,
 * non-anti-aliased PNG is written by hand with node:zlib (IHDR/IDAT/IEND,
 * correct CRC32) — no external encoder.
 *
 * Safe to re-run: it always overwrites the four PNGs.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'icons', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

// ---------------------------------------------------------------------------
// Shared geometry (mirrors icons/icon.svg) — used only by the flat fallback
// renderer, so the fallback icon still resembles the real mark.
// ---------------------------------------------------------------------------
const DARK_RGBA = [0x1d, 0x35, 0x57, 255];
const LIGHT_RGBA = [0xf4, 0xa2, 0x59, 255];
const FRONT_RECT = { x: 30, y: 34, w: 88, h: 88, r: 16 };
const ARROW_STEM = { x: 66, y: 51, w: 16, h: 28 };
const ARROW_HEAD = [
  [54, 79],
  [94, 79],
  [74, 105]
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Renders one size with headless Chrome. Throws on any failure. */
function renderWithChrome(chromePath, size, outPath) {
  const svgText = readFileSync(SVG_PATH, 'utf8');
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden;}',
    `svg{display:block;width:${size}px;height:${size}px;}`,
    '</style></head><body>',
    svgText,
    '</body></html>'
  ].join('');

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fullshot-icon-'));
  try {
    const htmlPath = path.join(tmpDir, `icon-${size}.html`);
    writeFileSync(htmlPath, html, 'utf8');
    const fileUrl = pathToFileURL(htmlPath).href;

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--screenshot=${outPath}`,
      `--window-size=${size},${size}`,
      fileUrl
    ];
    execFileSync(chromePath, args, { stdio: 'ignore', timeout: 30000 });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Parses the PNG signature + IHDR chunk and checks it matches expectedSize x expectedSize. */
function verifyPng(buf, expectedSize) {
  if (!buf || buf.length < 33) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width === expectedSize && height === expectedSize;
}

// ---------------------------------------------------------------------------
// Zero-dependency PNG encoder (fallback path)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function inRoundedRect(px, py, rect) {
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  if (px < rect.x || px > x1 || py < rect.y || py > y1) return false;
  const r = rect.r;
  let cx;
  let cy;
  if (px < rect.x + r && py < rect.y + r) {
    cx = rect.x + r;
    cy = rect.y + r;
  } else if (px > x1 - r && py < rect.y + r) {
    cx = x1 - r;
    cy = rect.y + r;
  } else if (px < rect.x + r && py > y1 - r) {
    cx = rect.x + r;
    cy = y1 - r;
  } else if (px > x1 - r && py > y1 - r) {
    cx = x1 - r;
    cy = y1 - r;
  } else {
    return true;
  }
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

function triSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function inTriangle(px, py, pts) {
  const [[x1, y1], [x2, y2], [x3, y3]] = pts;
  const d1 = triSign(px, py, x1, y1, x2, y2);
  const d2 = triSign(px, py, x2, y2, x3, y3);
  const d3 = triSign(px, py, x3, y3, x1, y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Flat, non-anti-aliased fallback icon: solid rounded square + arrow. */
function renderFallbackPng(size) {
  const scale = 128 / size;
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const mx = (x + 0.5) * scale;
      const my = (y + 0.5) * scale;
      let rgba = null;
      if (inRoundedRect(mx, my, FRONT_RECT)) {
        rgba = DARK_RGBA;
        if (inRect(mx, my, ARROW_STEM) || inTriangle(mx, my, ARROW_HEAD)) rgba = LIGHT_RGBA;
      }
      if (rgba) {
        const off = rowStart + 1 + x * 4;
        raw[off] = rgba[0];
        raw[off + 1] = rgba[1];
        raw[off + 2] = rgba[2];
        raw[off + 3] = rgba[3];
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(SVG_PATH)) {
    console.error(`FAIL: ${path.relative(ROOT, SVG_PATH)} not found`);
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.warn('WARNING: Chrome executable not found in any known location; using the built-in PNG fallback renderer for every size.');
  }

  let anyFallback = false;

  for (const size of SIZES) {
    const outPath = path.join(OUT_DIR, `icon${size}.png`);
    let ok = false;

    if (chromePath) {
      try {
        renderWithChrome(chromePath, size, outPath);
        ok = verifyPng(readFileSync(outPath), size);
        if (!ok) console.warn(`WARNING: Chrome screenshot for ${size}px failed PNG/size verification; falling back.`);
      } catch (err) {
        console.warn(`WARNING: Chrome rasterization failed for ${size}px (${err.message}); falling back.`);
      }
    }

    if (!ok) {
      anyFallback = true;
      writeFileSync(outPath, renderFallbackPng(size));
      if (!verifyPng(readFileSync(outPath), size)) {
        console.error(`FAIL: fallback PNG for ${size}px failed self-verification`);
        process.exit(1);
      }
    }

    const bytes = statSync(outPath).size;
    console.log(`${path.relative(ROOT, outPath).split(path.sep).join('/')} — ${bytes} bytes${ok ? '' : ' (fallback)'}`);
  }

  if (anyFallback && chromePath) {
    console.warn('WARNING: at least one icon was produced by the built-in fallback renderer instead of headless Chrome.');
  }
}

main();
