/**
 * FullShot — dependency-free PDF writer.
 * Classic script — attaches to globalThis.FS. Runs in a browser page (the editor).
 *
 * Builds a PDF 1.7 file byte-for-byte: no external library, no zlib port, no
 * jpeg re-encoder. JPEG source bytes are embedded verbatim behind /DCTDecode;
 * anything else is rasterized through a canvas and deflated with the native
 * CompressionStream, which emits standard zlib output — exactly what
 * /FlateDecode expects.
 *
 * Every offset written into the xref table is a byte offset into the actual
 * emitted Uint8Array chunks, never a JS string index — a string index is
 * wrong the moment any chunk contains a non-ASCII byte (the whole embedded
 * image, for one), which is why this file never assembles the document as a
 * string.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.pdf) return;

  /** PDF units are 1/72 inch; captures are taken at 96 dpi. */
  const PX_TO_PT = 72 / 96;

  /** Portrait page boxes, in pt, per the PDF/paper spec values. */
  const PAGE_BOXES = {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 }
  };

  /** Fixed object numbers — every document has exactly these four, plus two per page. */
  const OBJ = Object.freeze({ CATALOG: 1, PAGES: 2, IMAGE: 3, INFO: 4, FIRST_PAGE: 5 });

  /**
   * Format a coordinate/length for PDF content — fixed 4-decimal precision,
   * trailing zeros trimmed, never scientific notation, never a bare "-0".
   */
  function num(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = 0;
    if (Math.abs(n) < 1e-6) n = 0;
    return n.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  /**
   * A PDF literal `(...)` string, or a `<FEFF...>` UTF-16BE hex string when
   * the title has any non-ASCII character. `charCodeAt` already returns
   * UTF-16 code units, so no manual encoding is needed for the hex form.
   */
  function pdfTitleString(title) {
    const text = String(title);
    if (/^[\x00-\x7F]*$/.test(text)) {
      return `(${text.replace(/([\\()])/g, '\\$1')})`;
    }
    let hex = 'FEFF';
    for (let i = 0; i < text.length; i++) {
      hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    }
    return `<${hex}>`;
  }

  /**
   * Number of colour components declared by a JPEG's SOF marker (1 = gray,
   * 3 = RGB, 4 = CMYK). Walks the marker chain without decoding any pixel
   * data. Defaults to 3 (RGB) if no SOF is found before the scan starts.
   */
  function parseJpegComponents(bytes) {
    let i = 2; // past the SOI marker (FF D8)
    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // Markers with no length field: SOI, TEM, RSTn.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || i + 3 >= bytes.length) break; // EOI or truncated
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return bytes[i + 9]; // marker(2) len(2) precision(1) height(2) width(2) -> Nf
      if (marker === 0xda) break; // start of scan — entropy data follows, stop looking
      i += 2 + len;
    }
    return 3;
  }

  /**
   * Decode an image Blob to tightly-packed RGB8 bytes via a canvas.
   * Prefers OffscreenCanvas (works in any document-less worker-ish context);
   * falls back to an HTMLCanvasElement when that is unavailable.
   */
  async function decodeToRgb(blob, width, height) {
    const bitmap = await createImageBitmap(blob);
    let canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(width, height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();

    const rgba = ctx.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    return rgb;
  }

  /** Deflate bytes with the platform CompressionStream — zlib framed, as /FlateDecode requires. */
  async function deflate(bytes) {
    const stream = new CompressionStream('deflate');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();

    const chunks = [];
    let total = 0;
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /**
   * Per-page placement geometry.
   * 'fit'   -> a single page exactly the image size at 96 dpi; the image
   *            fills it with no translation.
   * 'a4'/'letter' -> fixed portrait pages; the image is scaled to the page
   *            width, and each page shows one vertical slice of it. The same
   *            scaled rectangle is redrawn on every page, translated upward
   *            by one page height per index, and clipped to the page box —
   *            this is what lets the image XObject be embedded once.
   */
  function computePages(pageSize, width, height) {
    const box = PAGE_BOXES[pageSize];
    if (!box) {
      const pageWidthPt = width * PX_TO_PT;
      const pageHeightPt = height * PX_TO_PT;
      return [{ pageWidthPt, pageHeightPt, imgWidthPt: pageWidthPt, imgHeightPt: pageHeightPt, ty: 0 }];
    }

    const scale = box.width / width;
    const imgWidthPt = box.width;
    const imgHeightPt = height * scale;
    const count = Math.max(1, Math.ceil(imgHeightPt / box.height));
    const pages = [];
    for (let i = 0; i < count; i++) {
      pages.push({
        pageWidthPt: box.width,
        pageHeightPt: box.height,
        imgWidthPt,
        imgHeightPt,
        ty: box.height - imgHeightPt + i * box.height
      });
    }
    return pages;
  }

  /** Accumulates Uint8Array chunks and records the byte offset of every object header. */
  function createWriter() {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = {};
    let length = 0;

    function text(str) {
      const bytes = encoder.encode(str);
      chunks.push(bytes);
      length += bytes.length;
    }
    function raw(bytes) {
      chunks.push(bytes);
      length += bytes.length;
    }
    function beginObj(n) {
      offsets[n] = length; // must point at the first byte of "n 0 obj"
      text(`${n} 0 obj\n`);
    }
    function endObj() {
      text('endobj\n');
    }

    return {
      text,
      raw,
      beginObj,
      endObj,
      offsets,
      chunks,
      get length() {
        return length;
      }
    };
  }

  /** Write one page object plus its content stream (clip, translate, paint, done). */
  function writePage(w, page, pageObj, contentsObj) {
    w.beginObj(pageObj);
    w.text(
      `<< /Type /Page /Parent ${OBJ.PAGES} 0 R ` +
        `/MediaBox [0 0 ${num(page.pageWidthPt)} ${num(page.pageHeightPt)}] ` +
        `/Resources << /XObject << /Im0 ${OBJ.IMAGE} 0 R >> >> ` +
        `/Contents ${contentsObj} 0 R >>\n`
    );
    w.endObj();

    const stream =
      `q\n0 0 ${num(page.pageWidthPt)} ${num(page.pageHeightPt)} re W n\n` +
      `${num(page.imgWidthPt)} 0 0 ${num(page.imgHeightPt)} 0 ${num(page.ty)} cm\n` +
      `/Im0 Do\nQ`;
    const streamBytes = new TextEncoder().encode(stream);

    w.beginObj(contentsObj);
    w.text(`<< /Length ${streamBytes.length} >>\nstream\n`);
    w.raw(streamBytes);
    w.text('\nendstream\n');
    w.endObj();
  }

  const pdf = {
    /**
     * @param {Blob} imageBlob        image/jpeg or image/png (or anything else,
     *                                 which is treated like PNG: rasterized via canvas)
     * @param {Object} opts
     * @param {number} opts.width      image width in px
     * @param {number} opts.height     image height in px
     * @param {'fit'|'a4'|'letter'} [opts.pageSize] 'fit' = one page exactly the
     *        image size at 96 dpi; 'a4'/'letter' = portrait pages, image scaled
     *        to the page width and sliced vertically across as many pages as needed
     * @param {string} [opts.title]
     * @returns {Promise<Blob>} application/pdf
     */
    async fromImage(imageBlob, opts) {
      const { width, height, pageSize, title } = opts || {};
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('FS.pdf.fromImage: opts.width/opts.height must be positive numbers');
      }

      const isJpeg = /^image\/jpe?g$/i.test(imageBlob.type || '');
      let imageBytes;
      let colorSpace;
      let filter;
      if (isJpeg) {
        imageBytes = new Uint8Array(await imageBlob.arrayBuffer());
        const components = parseJpegComponents(imageBytes);
        colorSpace = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        filter = '/DCTDecode';
      } else {
        imageBytes = await deflate(await decodeToRgb(imageBlob, width, height));
        colorSpace = '/DeviceRGB';
        filter = '/FlateDecode';
      }

      const pages = computePages(pageSize, width, height);
      const kids = pages.map((_, i) => OBJ.FIRST_PAGE + i * 2);

      const w = createWriter();
      w.text('%PDF-1.7\n');
      w.raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary comment line

      w.beginObj(OBJ.CATALOG);
      w.text(`<< /Type /Catalog /Pages ${OBJ.PAGES} 0 R >>\n`);
      w.endObj();

      w.beginObj(OBJ.PAGES);
      w.text(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages.length} >>\n`);
      w.endObj();

      w.beginObj(OBJ.IMAGE);
      w.text(
        `<< /Type /XObject /Subtype /Image /Width ${Math.round(width)} /Height ${Math.round(height)} ` +
          `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter ${filter} /Length ${imageBytes.length} >>\nstream\n`
      );
      w.raw(imageBytes);
      w.text('\nendstream\n');
      w.endObj();

      w.beginObj(OBJ.INFO);
      w.text(title ? `<< /Title ${pdfTitleString(title)} >>\n` : '<< >>\n');
      w.endObj();

      pages.forEach((page, i) => {
        writePage(w, page, OBJ.FIRST_PAGE + i * 2, OBJ.FIRST_PAGE + i * 2 + 1);
      });

      const lastObj = OBJ.FIRST_PAGE + pages.length * 2 - 1;
      const xrefOffset = w.length;
      w.text(`xref\n0 ${lastObj + 1}\n`);
      w.text('0000000000 65535 f \n');
      for (let n = 1; n <= lastObj; n++) {
        w.text(`${String(w.offsets[n]).padStart(10, '0')} 00000 n \n`);
      }
      w.text(
        `trailer\n<< /Size ${lastObj + 1} /Root ${OBJ.CATALOG} 0 R /Info ${OBJ.INFO} 0 R >>\n` +
          `startxref\n${xrefOffset}\n%%EOF`
      );

      return new Blob(w.chunks, { type: 'application/pdf' });
    }
  };

  FS.pdf = pdf;
})();
