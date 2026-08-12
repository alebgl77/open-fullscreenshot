#!/usr/bin/env node
/**
 * FullShot — self-test for src/lib/pdf.js.
 *
 * Plain Node 18+ ESM, no dependencies, no test framework. Loads pdf.js as a
 * classic script via node:vm (the same `globalThis.FS = ...` pattern it uses
 * in a browser page), feeding it the handful of browser globals it needs.
 *
 * Only the JPEG path is exercised here: it needs nothing but Blob/TextEncoder.
 * The PNG path decodes through a canvas (createImageBitmap/OffscreenCanvas),
 * which Node does not have — that path is explicitly skipped, not faked.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pdfSrcPath = path.join(root, 'src', 'lib', 'pdf.js');

let failures = 0;
function report(caseName, ok, detail) {
  if (ok) {
    console.log(`PASS ${caseName}`);
  } else {
    failures++;
    console.log(`FAIL ${caseName}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Load src/lib/pdf.js as a classic script in a fresh vm context.
// ---------------------------------------------------------------------------
const source = fs.readFileSync(pdfSrcPath, 'utf8');
const sandbox = { Blob, CompressionStream, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: pdfSrcPath });

const FS = sandbox.FS;
if (!FS || !FS.pdf || typeof FS.pdf.fromImage !== 'function') {
  console.log('FAIL load — src/lib/pdf.js did not attach FS.pdf.fromImage');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// A minimal, hard-coded, syntactically valid baseline JPEG (8x8, grayscale).
// Built from literal marker bytes rather than a captured hex dump, so every
// byte here is legible and intentional. The entropy-coded scan data is not a
// real encode of anything — pdf.js never decodes it, it only re-embeds the
// bytes verbatim behind /DCTDecode, so this is sufficient.
// ---------------------------------------------------------------------------
function buildMinimalGrayJpeg(size) {
  const bytes = [];
  const push = (...vals) => bytes.push(...vals);
  const pushU16 = (v) => bytes.push((v >> 8) & 0xff, v & 0xff);

  push(0xff, 0xd8); // SOI

  push(0xff, 0xe0); // APP0 (JFIF)
  pushU16(16);
  push(0x4a, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
  push(1, 1); // version 1.1
  push(0); // units: none
  pushU16(1);
  pushU16(1); // density x, y
  push(0, 0); // no thumbnail

  push(0xff, 0xdb); // DQT
  pushU16(2 + 1 + 64);
  push(0x00);
  for (let i = 0; i < 64; i++) push(16);

  push(0xff, 0xc0); // SOF0, baseline, 1 component (grayscale)
  pushU16(2 + 1 + 2 + 2 + 1 + 3);
  push(8); // precision
  pushU16(size); // height
  pushU16(size); // width
  push(1); // Nf
  push(1, 0x11, 0); // component id 1, sampling 1x1, quant table 0

  push(0xff, 0xc4); // DHT, one trivial DC table
  const counts = new Array(16).fill(0);
  counts[0] = 1;
  const symbols = [0];
  pushU16(2 + 1 + 16 + symbols.length);
  push(0x00);
  for (const c of counts) push(c);
  for (const s of symbols) push(s);

  push(0xff, 0xda); // SOS
  pushU16(2 + 1 + 2 + 3);
  push(1); // Ns
  push(1, 0x00); // component selector 1, DC/AC table 0/0
  push(0, 63, 0); // Ss, Se, AhAl

  push(0x00, 0x00, 0x00, 0x00); // placeholder entropy-coded data

  push(0xff, 0xd9); // EOI

  return new Uint8Array(bytes);
}

const jpegBytes = buildMinimalGrayJpeg(8);
const jpegBlob = new Blob([jpegBytes], { type: 'image/jpeg' });

// ---------------------------------------------------------------------------
// Structural PDF assertions. Everything is checked on a latin1 decode of the
// raw bytes: latin1 is a lossless 1:1 byte<->char-code mapping, so string
// indices in `text` are exactly the byte offsets pdf.js wrote — unlike a
// UTF-8 decode, which would corrupt indices the moment a byte is non-ASCII
// (e.g. inside the embedded image stream).
// ---------------------------------------------------------------------------
async function checkPdf(caseName, blob, { expectPagesGT1 } = {}) {
  const buf = Buffer.from(await blob.arrayBuffer());
  const text = buf.toString('latin1');
  const problems = [];

  if (!text.startsWith('%PDF-1.7')) problems.push('missing %PDF-1.7 header');
  if (!text.endsWith('%%EOF')) problems.push('does not end with %%EOF');

  const startxrefMatch = text.match(/startxref\r?\n(\d+)\r?\n%%EOF$/);
  if (!startxrefMatch) {
    problems.push('startxref/%%EOF trailer not found in expected form');
  } else {
    const xrefOffset = Number(startxrefMatch[1]);
    if (text.slice(xrefOffset, xrefOffset + 4) !== 'xref') {
      problems.push(`startxref (${xrefOffset}) does not point at the "xref" keyword`);
    } else {
      const headerMatch = /^xref\r?\n0 (\d+)\r?\n/.exec(text.slice(xrefOffset));
      if (!headerMatch) {
        problems.push('xref subsection header "0 N" not found');
      } else {
        const total = Number(headerMatch[1]);
        const entriesStart = xrefOffset + headerMatch[0].length;
        const freeEntry = text.slice(entriesStart, entriesStart + 20);
        if (freeEntry !== '0000000000 65535 f \n') {
          problems.push(`free entry 0 malformed: ${JSON.stringify(freeEntry)}`);
        }
        for (let n = 1; n < total; n++) {
          const entry = text.slice(entriesStart + n * 20, entriesStart + (n + 1) * 20);
          const m = /^(\d{10}) (\d{5}) n \n$/.exec(entry);
          if (!m) {
            problems.push(`object ${n}: xref entry malformed: ${JSON.stringify(entry)}`);
            continue;
          }
          const offset = Number(m[1]);
          const expected = `${n} 0 obj`;
          if (text.slice(offset, offset + expected.length) !== expected) {
            problems.push(`object ${n}: offset ${offset} does not point at "${expected}"`);
          }
        }
      }
    }
  }

  const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g) || [];
  const imageMatches = text.match(/\/Subtype\s*\/Image/g) || [];
  if (imageMatches.length !== 1) {
    problems.push(`image XObject appears ${imageMatches.length} times, expected exactly 1`);
  }
  if (expectPagesGT1 && pageMatches.length <= 1) {
    problems.push(`expected more than one /Type /Page, got ${pageMatches.length}`);
  }
  if (pageMatches.length < 1) {
    problems.push('no /Type /Page found');
  }

  report(caseName, problems.length === 0, problems.join('; '));
  return buf;
}

// Wide + tall enough that a4/letter (scaled to page width) must slice across
// several pages; 'fit' always stays a single page regardless of height.
const width = 800;
const height = 6000;

let a4Buffer;
for (const pageSize of ['fit', 'a4', 'letter']) {
  const blob = await FS.pdf.fromImage(jpegBlob, { width, height, pageSize, title: 'FullShot Café ☕' });
  const buf = await checkPdf(`pageSize=${pageSize}`, blob, { expectPagesGT1: pageSize !== 'fit' });
  if (pageSize === 'a4') a4Buffer = buf;
}

// ACCEPTANCE #2 — write one output to disk so its byte structure can be
// inspected outside this script (there is no PDF reader to script here, so
// the structural assertions above are the verification).
const outPath = path.join(os.tmpdir(), 'fullshot-test.pdf');
fs.writeFileSync(outPath, a4Buffer);
console.log(`wrote ${outPath} (${a4Buffer.length} bytes)`);

console.log('SKIP pageSize=png (PNG path decodes via canvas/OffscreenCanvas, unavailable in Node — not run, not faked)');

process.exit(failures ? 1 : 0);
