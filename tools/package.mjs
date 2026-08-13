/**
 * Open FullScreenshot — release packager.
 *
 * Node 18+ ESM, zero dependencies. Produces dist/open-fullscreenshot-<version>.zip
 * containing exactly what Chrome needs to load the extension: manifest.json,
 * icons/, src/, _locales/. docs/, tools/, dist/, .git and *.md are never
 * included (the walk below never even looks at them).
 *
 * Refuses to run — no zip is written — unless `tools/validate.mjs` exits 0.
 *
 * The ZIP writer is hand-rolled on top of node:zlib deflateRawSync: local
 * file headers, a central directory and an EOCD record, with a CRC32 per
 * entry, matching the ZIP spec well enough for Chrome/`Expand-Archive`/`tar`
 * to read.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VALIDATE_SCRIPT = path.join(__dirname, 'validate.mjs');
const INCLUDE_DIRS = ['icons', 'src', '_locales'];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function runValidate() {
  console.log('Running tools/validate.mjs before packaging…\n');
  const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], { stdio: 'inherit' });
  if (result.error) {
    console.error(`\nCould not run validate.mjs: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Zero-dependency ZIP writer
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

function toDosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

/** @param {{abs:string, rel:string}[]} entries */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const data = readFileSync(entry.abs);
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(entry.rel, 'utf8');

    let mtime;
    try {
      mtime = statSync(entry.abs).mtime;
    } catch {
      mtime = new Date();
    }
    const { time, dosDate } = toDosDateTime(mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0x81a40000, 38); // external attrs: unix -rw-r--r--
    centralHeader.writeUInt32LE(offset, 42); // offset of local header

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

// ---------------------------------------------------------------------------

function main() {
  if (!runValidate()) {
    console.error('\nRefusing to package: tools/validate.mjs reported failures. Fix them and re-run.');
    process.exit(1);
  }

  const manifestPath = path.join(ROOT, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`\nCannot read manifest.json: ${err.message}`);
    process.exit(1);
  }
  const version = typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0';

  const entries = [{ abs: manifestPath, rel: 'manifest.json' }];
  for (const dir of INCLUDE_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (/\.md$/i.test(file)) continue;
      entries.push({ abs: file, rel: path.relative(ROOT, file).split(path.sep).join('/') });
    }
  }

  if (entries.length <= 1) {
    console.error('\nNo files found under icons/, src/ or _locales/ — aborting.');
    process.exit(1);
  }

  const distDir = path.join(ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, `open-fullscreenshot-${version}.zip`);

  const zipBuffer = buildZip(entries);
  writeFileSync(outPath, zipBuffer);

  console.log(`\nWrote ${path.relative(ROOT, outPath).split(path.sep).join('/')} — ${entries.length} files, ${zipBuffer.length} bytes`);
}

main();
