import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// One version-controlled scalable source. Produce icons on every build/dev start
// so the same brand works in browser tabs, legacy clients and home-screen saves.
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const svg = await readFile(path.join(publicDir, 'favicon.svg'));
const sizes = [16, 32, 48, 180, 192, 512];
const pngs = new Map();
for (const size of sizes) {
  pngs.set(size, await sharp(svg, { density: 576 })
    .resize(size, size, { fit: 'fill' })
    .png({ compressionLevel: 9, effort: 8 })
    .toBuffer());
}

// PNG-compressed entries inside the .ico keep 16/32/48px fallbacks crisp.
const iconSizes = [16, 32, 48];
const header = Buffer.alloc(6 + iconSizes.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(iconSizes.length, 4);
let offset = header.length;
for (const [index, size] of iconSizes.entries()) {
  const png = pngs.get(size);
  const at = 6 + index * 16;
  header.writeUInt8(size, at);
  header.writeUInt8(size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
}

await Promise.all([
  writeFile(path.join(publicDir, 'favicon.ico'), Buffer.concat([header, ...iconSizes.map(size => pngs.get(size))])),
  writeFile(path.join(publicDir, 'apple-touch-icon.png'), pngs.get(180)),
  writeFile(path.join(publicDir, 'favicon-192.png'), pngs.get(192)),
  writeFile(path.join(publicDir, 'favicon-512.png'), pngs.get(512))
]);
console.log('Publikator favicon assets: SVG + ICO 16/32/48 + PNG 180/192/512');
