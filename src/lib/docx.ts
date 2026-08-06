// Minimal, dependency-free .docx → HTML converter. A .docx is a ZIP of XML parts;
// we read the ZIP central directory by hand and inflate `word/document.xml` with
// Node's built-in zlib (no JSZip/mammoth), then translate the WordprocessingML we
// care about (paragraphs, runs, bold/italic/underline, headings, lists, tables) to
// clean HTML that our rich-text editor can load and edit.
import zlib from 'node:zlib';

// ---- tiny ZIP reader (central-directory based, handles STORE + DEFLATE) ----
function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // Locate End Of Central Directory (scan back for signature 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      // Jump to the local header to find where the data actually starts.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);          // stored
      if (method === 8) return zlib.inflateRawSync(data);  // deflate
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---- WordprocessingML → HTML ----
function decodeXmlText(s: string): string {
  // Keep HTML-valid entities as-is; normalise &apos; (not valid in HTML4).
  return s.replace(/&apos;/g, '&#39;');
}

function convertRun(r: string): string {
  const rpr = r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? '';
  const bold = /<w:b\b(?![a-zA-Z])/.test(rpr) && !/<w:b\s+w:val="(false|0)"/.test(rpr);
  const italic = /<w:i\b(?![a-zA-Z])/.test(rpr) && !/<w:i\s+w:val="(false|0)"/.test(rpr);
  const underline = /<w:u\b/.test(rpr) && !/<w:u\s+w:val="none"/.test(rpr);
  const strike = /<w:strike\b/.test(rpr);

  // Text, tabs and breaks in document order.
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r))) {
    if (m[0].startsWith('<w:t')) text += decodeXmlText(m[1]);
    else if (m[0].startsWith('<w:tab')) text += '    ';
    else text += '<br>';
  }
  if (!text) return '';
  let html = text;
  if (bold) html = `<strong>${html}</strong>`;
  if (italic) html = `<em>${html}</em>`;
  if (underline) html = `<u>${html}</u>`;
  if (strike) html = `<s>${html}</s>`;
  return html;
}

function convertParagraph(p: string): string {
  const ppr = p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? '';
  const style = ppr.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? '';
  const align = ppr.match(/<w:jc\s+w:val="([^"]+)"/)?.[1];
  const isList = /<w:numPr>/.test(ppr);

  let inner = '';
  const runs = p.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? [];
  for (const r of runs) inner += convertRun(r);

  const alignCss = align && ['center', 'right', 'both'].includes(align)
    ? ` style="text-align:${align === 'both' ? 'justify' : align}"` : '';
  if (isList) return `<li${alignCss}>${inner || '&nbsp;'}</li>`;
  const tag = /Heading1|Title/i.test(style) ? 'h1' : /Heading2|Subtitle/i.test(style) ? 'h2' : /Heading[3-9]/i.test(style) ? 'h3' : 'p';
  return `<${tag}${alignCss}>${inner || '<br>'}</${tag}>`;
}

function convertTable(t: string): string {
  const rows = t.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
  let html = '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">';
  for (const tr of rows) {
    html += '<tr>';
    const cells = tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
    for (const tc of cells) {
      const paras = tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
      const cellHtml = paras.map(convertParagraph).join('') || '&nbsp;';
      html += `<td>${cellHtml}</td>`;
    }
    html += '</tr>';
  }
  return html + '</table>';
}

export function docxToHtml(buf: Buffer): string {
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('Не удалось прочитать .docx (нет word/document.xml)');
  const xml = xmlBuf.toString('utf8');
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;

  // Walk top-level block elements (paragraphs + tables) in document order.
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body))) {
    out += m[0].startsWith('<w:tbl') ? convertTable(m[0]) : convertParagraph(m[0]);
  }
  // Group consecutive <li> into <ul>.
  out = out.replace(/(?:<li[\s\S]*?<\/li>)+/g, (run) => `<ul>${run}</ul>`);
  return out || '<p><br></p>';
}
