import { deflateSync } from 'node:zlib';

/** Small, deterministic PDF fixtures. No downloaded document or binary is persisted. */
export function legacyPdfFixture(options: { text?: string; scanned?: boolean; pages?: number } = {}): Uint8Array {
  const { text = 'DOE SP synthetic text', scanned = false, pages = 1 } = options;
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
  const stream = (dictionary: string, bytes: Buffer): Buffer => Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1'),
  ]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // Filled after page object numbers are known.
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const image = scanned ? add(stream('/Type /XObject /Subtype /Image /Width 1500 /Height 1500 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(Buffer.alloc(1500 * 1500, 255)))) : undefined;
  const escapedText = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const commands = [
    ...(image ? ['q 595 0 0 842 0 0 cm /Scan Do Q'] : []),
    ...(text ? [`BT /F1 12 Tf 20 800 Td (${escapedText}) Tj ET`] : []),
  ].join('\n');
  const content = add(stream('', Buffer.from(commands, 'latin1')));
  const pageNumbers = Array.from({ length: pages }, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> ${image ? `/XObject << /Scan ${image} 0 R >>` : ''} >> /Contents ${content} 0 R >>`));
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${pageNumbers.map(number => `${number} 0 R`).join(' ')}] >>`, 'latin1');
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(object);
    length += object.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}
