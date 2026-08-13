/**
 * Open FullScreenshot — static validator.
 *
 * Node 18+ ESM, zero dependencies. Implements ARCHITECTURE.md §12 (and the
 * expanded checklist in the task brief that spawned this file).
 *
 * This script is designed to run while sibling tasks (background/, content/,
 * editor/, popup/, options/, lib/pdf.js, _locales/) are still being written:
 * every missing file is reported as a named FAIL with a file:line where
 * applicable, never as a thrown exception. Exit code is 0 only when every
 * check passes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** @type {{name:string, pass:boolean, detail:string}[]} */
const results = [];

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

/** One PASS line if `violations` is empty, otherwise one FAIL line per violation. */
function reportGroup(name, violations) {
  if (violations.length === 0) {
    record(name, true);
    return;
  }
  for (const detail of violations) record(name, false, detail);
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
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

function lineOf(content, index) {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// 1. manifest.json + 9. no host_permissions / web_accessible_resources
// ---------------------------------------------------------------------------

function checkManifest() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const raw = readIfExists(manifestPath);
  if (raw == null) {
    record('manifest.json exists', false, `${rel(manifestPath)}: file not found`);
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    record('manifest.json parses', false, `${rel(manifestPath)}: ${err.message}`);
    return null;
  }
  record('manifest.json parses', true);

  record(
    'manifest_version === 3',
    manifest.manifest_version === 3,
    manifest.manifest_version === 3 ? '' : `${rel(manifestPath)}: manifest_version is ${JSON.stringify(manifest.manifest_version)}`
  );

  const referenced = [];
  if (manifest.icons && typeof manifest.icons === 'object') referenced.push(...Object.values(manifest.icons));
  if (manifest.action && manifest.action.default_icon && typeof manifest.action.default_icon === 'object') {
    referenced.push(...Object.values(manifest.action.default_icon));
  }
  if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);
  if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.options_ui && manifest.options_ui.page) referenced.push(manifest.options_ui.page);
  if (manifest.options_page) referenced.push(manifest.options_page);

  for (const refPath of referenced) {
    if (typeof refPath !== 'string') continue;
    const full = path.join(ROOT, refPath);
    const ok = exists(full);
    record(`manifest-referenced path exists: ${refPath}`, ok, ok ? '' : `${rel(manifestPath)}: referenced path "${refPath}" not found on disk`);
  }

  record(
    'manifest.json declares no host_permissions',
    !('host_permissions' in manifest),
    'host_permissions' in manifest ? `${rel(manifestPath)}: host_permissions is present` : ''
  );
  record(
    'manifest.json declares no web_accessible_resources',
    !('web_accessible_resources' in manifest),
    'web_accessible_resources' in manifest ? `${rel(manifestPath)}: web_accessible_resources is present` : ''
  );

  return manifest;
}

// ---------------------------------------------------------------------------
// 2. Forbidden network patterns
// ---------------------------------------------------------------------------

function collectNetworkScanFiles() {
  const files = [];
  files.push(...walk(path.join(ROOT, 'src')));
  files.push(...walk(path.join(ROOT, '_locales')));
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (entry.isFile() && /\.(html|css|js)$/i.test(entry.name)) files.push(path.join(ROOT, entry.name));
  }
  return files.filter((f) => /\.(js|html|css|json)$/i.test(f));
}

function maskJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = null;
  while (i < n) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function maskHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function maskCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function isUnderLocales(file) {
  return file.startsWith(path.join(ROOT, '_locales') + path.sep);
}

function scanHttpLiterals(files) {
  const violations = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json' && isUnderLocales(file)) continue; // allowed in message values
    const content = readIfExists(file);
    if (content == null) continue;
    let masked = content;
    if (ext === '.js') masked = maskJsComments(content);
    else if (ext === '.html') masked = maskHtmlComments(content);
    else if (ext === '.css') masked = maskCssComments(content);
    const re = /https?:\/\//g;
    let m;
    while ((m = re.exec(masked))) {
      violations.push(`${rel(file)}:${lineOf(masked, m.index)}: literal "${m[0]}" found outside comments/locale values`);
    }
  }
  reportGroup('no http(s):// literals outside comments/locale message values', violations);
}

function findFetchCalls(content) {
  const calls = [];
  const re = /\bfetch\s*\(/g;
  let m;
  while ((m = re.exec(content))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < content.length && depth > 0) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') depth--;
      i++;
    }
    calls.push({ index: m.index, arg: content.slice(start, i - 1).trim() });
  }
  return calls;
}

function isAllowedFetchArg(arg) {
  if (/^['"`]blob:/i.test(arg)) return true;
  if (/^['"`]data:/i.test(arg)) return true;
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) return true; // bare variable reference
  return false;
}

function scanFetchCalls(files) {
  const violations = [];
  for (const file of files) {
    if (!/\.js$|\.html$/i.test(file)) continue;
    const content = readIfExists(file);
    if (content == null) continue;
    for (const call of findFetchCalls(content)) {
      if (call.arg === '' || isAllowedFetchArg(call.arg)) continue;
      violations.push(`${rel(file)}:${lineOf(content, call.index)}: fetch(${call.arg}) is neither a blob:/data: literal nor a bare variable`);
    }
  }
  reportGroup('no fetch() of a remote/non-blob-data argument', violations);
}

function scanRemoteResourceTags(files) {
  const violations = [];
  for (const file of files) {
    if (!/\.html$/i.test(file)) continue;
    const content = readIfExists(file);
    if (content == null) continue;
    const tagRe = /<(script|link|img)\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(content))) {
      const attrMatch = m[0].match(/(?:src|href)\s*=\s*["']([^"']+)["']/i);
      if (attrMatch && /^(https?:)?\/\//i.test(attrMatch[1])) {
        violations.push(`${rel(file)}:${lineOf(content, m.index)}: <${m[1]}> references remote "${attrMatch[1]}"`);
      }
    }
  }
  reportGroup('no <link>/<script>/<img> with an absolute remote src', violations);
}

function scanCssImport(files) {
  const violations = [];
  for (const file of files) {
    if (!/\.css$/i.test(file)) continue;
    const content = readIfExists(file);
    if (content == null) continue;
    const re = /@import\s+url\(\s*['"]?https?:\/\//gi;
    let m;
    while ((m = re.exec(content))) {
      violations.push(`${rel(file)}:${lineOf(content, m.index)}: @import of a remote URL`);
    }
  }
  reportGroup('no @import url(http…) in CSS', violations);
}

function scanLiteralPattern(files, name, re, extRe = /\.(js|html)$/i) {
  const violations = [];
  for (const file of files) {
    if (!extRe.test(file)) continue;
    const content = readIfExists(file);
    if (content == null) continue;
    const localRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = localRe.exec(content))) {
      violations.push(`${rel(file)}:${lineOf(content, m.index)}: forbidden "${m[0]}"`);
    }
  }
  reportGroup(name, violations);
}

function checkForbiddenNetwork() {
  const files = collectNetworkScanFiles();
  scanHttpLiterals(files);
  scanFetchCalls(files);
  scanRemoteResourceTags(files);
  scanCssImport(files);
  scanLiteralPattern(files, 'no XMLHttpRequest', /\bXMLHttpRequest\b/g);
  scanLiteralPattern(files, 'no WebSocket', /\bWebSocket\b/g);
  scanLiteralPattern(files, 'no navigator.sendBeacon', /navigator\.sendBeacon\b/g);
}

// ---------------------------------------------------------------------------
// 3. No dynamic code
// ---------------------------------------------------------------------------

function checkDynamicCode() {
  const files = [...walk(path.join(ROOT, 'src'))].filter((f) => /\.(js|html)$/i.test(f));
  scanLiteralPattern(files, "no eval(", /\beval\s*\(/g);
  scanLiteralPattern(files, 'no new Function(', /\bnew\s+Function\s*\(/g);
  scanLiteralPattern(files, "no setTimeout('string')", /\bsetTimeout\s*\(\s*['"`]/g);
  scanLiteralPattern(files, "no setInterval('string')", /\bsetInterval\s*\(\s*['"`]/g);
}

// ---------------------------------------------------------------------------
// 4. No innerHTML/outerHTML/insertAdjacentHTML with interpolation/concatenation
// ---------------------------------------------------------------------------

function checkHtmlSinks() {
  const files = [...walk(path.join(ROOT, 'src'))].filter((f) => /\.(js|html)$/i.test(f));
  const violations = [];
  const assignRe = /\.(innerHTML|outerHTML)\s*=\s*([^;\n]+)/g;
  const insertRe = /\.insertAdjacentHTML\s*\(\s*[^,]+,\s*([^)]+)\)/g;

  for (const file of files) {
    const content = readIfExists(file);
    if (content == null) continue;

    let m;
    assignRe.lastIndex = 0;
    while ((m = assignRe.exec(content))) {
      const rhs = m[2];
      if (rhs.includes('${') || rhs.includes('+')) {
        violations.push(`${rel(file)}:${lineOf(content, m.index)}: .${m[1]} = ${rhs.trim()} is interpolated/concatenated`);
      }
    }
    insertRe.lastIndex = 0;
    while ((m = insertRe.exec(content))) {
      const rhs = m[1];
      if (rhs.includes('${') || rhs.includes('+')) {
        violations.push(`${rel(file)}:${lineOf(content, m.index)}: insertAdjacentHTML(..., ${rhs.trim()}) is interpolated/concatenated`);
      }
    }
  }
  reportGroup('no innerHTML/outerHTML/insertAdjacentHTML with interpolation or concatenation', violations);
}

// ---------------------------------------------------------------------------
// 5. _locales/fr key parity with _locales/en
// ---------------------------------------------------------------------------

function checkLocaleParity() {
  const enPath = path.join(ROOT, '_locales', 'en', 'messages.json');
  const frPath = path.join(ROOT, '_locales', 'fr', 'messages.json');
  const enRaw = readIfExists(enPath);
  const frRaw = readIfExists(frPath);

  if (enRaw == null) record('_locales/en/messages.json exists', false, `${rel(enPath)}: file not found`);
  else record('_locales/en/messages.json exists', true);
  if (frRaw == null) record('_locales/fr/messages.json exists', false, `${rel(frPath)}: file not found`);
  else record('_locales/fr/messages.json exists', true);

  if (enRaw == null || frRaw == null) return null;

  let en;
  let fr;
  try {
    en = JSON.parse(enRaw);
  } catch (err) {
    record('_locales/en/messages.json parses', false, `${rel(enPath)}: ${err.message}`);
    return null;
  }
  try {
    fr = JSON.parse(frRaw);
  } catch (err) {
    record('_locales/fr/messages.json parses', false, `${rel(frPath)}: ${err.message}`);
    return null;
  }
  record('_locales/en and _locales/fr messages.json parse', true);

  const enKeys = new Set(Object.keys(en));
  const frKeys = new Set(Object.keys(fr));
  const violations = [];
  for (const k of enKeys) if (!frKeys.has(k)) violations.push(`${rel(frPath)}: missing key "${k}" (present in en)`);
  for (const k of frKeys) if (!enKeys.has(k)) violations.push(`${rel(frPath)}: extra key "${k}" (absent from en)`);
  reportGroup('_locales/fr/messages.json has exactly the key set of _locales/en/messages.json', violations);

  return enKeys;
}

// ---------------------------------------------------------------------------
// 6. data-i18n / data-i18n-attr / __MSG_ keys exist in en locale
// ---------------------------------------------------------------------------

function checkI18nKeys(enKeys) {
  const name = 'data-i18n / data-i18n-attr / __MSG_ keys exist in _locales/en/messages.json';
  if (!enKeys) {
    record(name, false, '_locales/en/messages.json unavailable — cannot verify referenced keys');
    return;
  }

  const violations = [];
  const htmlFiles = walk(path.join(ROOT, 'src')).filter((f) => /\.html$/i.test(f));

  for (const file of htmlFiles) {
    const content = readIfExists(file);
    if (content == null) continue;

    for (const m of content.matchAll(/data-i18n\s*=\s*["']([^"']+)["']/g)) {
      if (!enKeys.has(m[1])) violations.push(`${rel(file)}:${lineOf(content, m.index)}: data-i18n="${m[1]}" missing from en locale`);
    }
    for (const m of content.matchAll(/data-i18n-attr\s*=\s*["']([^"']+)["']/g)) {
      for (const pair of m[1].split(';')) {
        const parts = pair.split(':');
        const key = (parts[1] || '').trim();
        if (key && !enKeys.has(key)) {
          violations.push(`${rel(file)}:${lineOf(content, m.index)}: data-i18n-attr key "${key}" missing from en locale`);
        }
      }
    }
  }

  const manifestRaw = readIfExists(path.join(ROOT, 'manifest.json'));
  if (manifestRaw != null) {
    for (const m of manifestRaw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
      if (!enKeys.has(m[1])) {
        violations.push(`manifest.json:${lineOf(manifestRaw, m.index)}: __MSG_${m[1]}__ missing from en locale`);
      }
    }
  }

  reportGroup(name, violations);
}

// ---------------------------------------------------------------------------
// 7. FS.MSG.X usages are declared in protocol.js
// ---------------------------------------------------------------------------

function checkProtocolMsgUsage() {
  const name = 'every FS.MSG.X reference is declared in src/shared/protocol.js';
  const protocolPath = path.join(ROOT, 'src', 'shared', 'protocol.js');
  const protocolSrc = readIfExists(protocolPath);
  if (protocolSrc == null) {
    record(name, false, `${rel(protocolPath)}: file not found — cannot verify FS.MSG usages`);
    return;
  }

  const blockMatch = protocolSrc.match(/FS\.MSG\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s*\)\s*;/);
  if (!blockMatch) {
    record(name, false, `${rel(protocolPath)}: could not locate the FS.MSG = Object.freeze({ … }) declaration`);
    return;
  }

  const declared = new Set();
  for (const m of blockMatch[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*'/gm)) declared.add(m[1]);

  const violations = [];
  const jsFiles = walk(path.join(ROOT, 'src')).filter((f) => /\.js$/i.test(f));
  for (const file of jsFiles) {
    const content = readIfExists(file);
    if (content == null) continue;
    const masked = maskJsComments(content); // ignore FS.MSG.X mentioned only in docs/comments
    for (const m of masked.matchAll(/FS\.MSG\.([A-Za-z0-9_]+)/g)) {
      if (!declared.has(m[1])) {
        violations.push(`${rel(file)}:${lineOf(masked, m.index)}: FS.MSG.${m[1]} is not declared in protocol.js`);
      }
    }
  }
  reportGroup(name, violations);
}

// ---------------------------------------------------------------------------
// 8. <script src> / <link href> resolve to existing local files
// ---------------------------------------------------------------------------

function stripSuffix(p) {
  return p.split('#')[0].split('?')[0];
}

function checkHtmlLocalRefs() {
  const violations = [];
  const htmlFiles = walk(path.join(ROOT, 'src')).filter((f) => /\.html$/i.test(f));

  for (const file of htmlFiles) {
    const content = readIfExists(file);
    if (content == null) continue;
    const dir = path.dirname(file);

    const tagRe = /<(script|link)\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(content))) {
      const attrMatch = m[0].match(/(?:src|href)\s*=\s*["']([^"']+)["']/i);
      if (!attrMatch) continue;
      const refValue = attrMatch[1];
      if (/^(https?:)?\/\//i.test(refValue) || refValue.startsWith('data:')) continue; // handled by network checks
      const target = stripSuffix(refValue);
      if (!target) continue;
      const full = path.join(dir, target);
      if (!exists(full)) {
        violations.push(`${rel(file)}:${lineOf(content, m.index)}: <${m[1]}> reference "${refValue}" does not resolve to a file on disk`);
      }
    }
  }
  reportGroup('every <script src> / <link href> in src/**/*.html resolves to a file that exists', violations);
}

// ---------------------------------------------------------------------------

function main() {
  const manifest = checkManifest();
  checkForbiddenNetwork();
  checkDynamicCode();
  checkHtmlSinks();
  const enKeys = checkLocaleParity();
  checkI18nKeys(enKeys);
  checkProtocolMsgUsage();
  checkHtmlLocalRefs();
  void manifest;

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    if (r.pass) console.log(`[PASS] ${r.name}`);
    else console.log(`[FAIL] ${r.name} — ${r.detail}`);
  }
  console.log('-'.repeat(70));
  console.log(`Open FullScreenshot validate: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

try {
  main();
} catch (err) {
  console.error(`[INTERNAL ERROR] tools/validate.mjs crashed unexpectedly: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
}
