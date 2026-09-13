#!/usr/bin/env node
// Regenerate the raster favicons in public/ from public/favicon.svg:
//   favicon.ico           16/32/48 PNG-embedded ICO fallback (Safari, legacy)
//   apple-touch-icon.png  180x180 opaque square tile for iOS home screens
// Requires playwright + chromium (already used by the browser tests).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const publicDir = path.join(root, "public");

const ZAP_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

// Geometry lives in the shared 64-unit viewBox so every raster size is a clean
// uniform scale of public/favicon.svg; the corner radius mirrors .brand-mark
// (12px on a 36px tile). The apple-touch tile stays square because iOS applies
// its own mask and dislikes transparency.
function iconSvg(size, { rounded = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0.18" y1="0" x2="0.82" y2="1">
      <stop offset="0" stop-color="#f8bb55"/>
      <stop offset="1" stop-color="#f0aa3c"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="${rounded ? 20 : 0}" fill="url(#bg)"/>
  <path d="${ZAP_PATH}" transform="translate(9.16 9.2) scale(1.9)" fill="#0f1120" stroke="#0f1120" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

async function renderPng(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  try {
    await page.goto(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    return await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  } finally {
    await page.close();
  }
}

// ICO containers may embed PNG payloads directly (Vista+); write the entries by hand.
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = header.length + entries.length;
  pngs.forEach((png, i) => {
    entries.writeUInt8(png.size === 256 ? 0 : png.size, i * 16);
    entries.writeUInt8(png.size === 256 ? 0 : png.size, i * 16 + 1);
    entries.writeUInt16LE(1, i * 16 + 4);
    entries.writeUInt16LE(32, i * 16 + 6);
    entries.writeUInt32LE(png.data.length, i * 16 + 8);
    entries.writeUInt32LE(offset, i * 16 + 12);
    offset += png.data.length;
  });
  return Buffer.concat([header, entries, ...pngs.map((png) => png.data)]);
}

await mkdir(publicDir, { recursive: true });
const browser = await chromium.launch();
try {
  const icoSizes = [16, 32, 48];
  const pngs = [];
  for (const size of icoSizes) {
    pngs.push({ size, data: await renderPng(browser, iconSvg(size), size) });
  }
  await writeFile(path.join(publicDir, "favicon.ico"), buildIco(pngs));

  const appleSize = 180;
  const apple = await renderPng(browser, iconSvg(appleSize, { rounded: false }), appleSize);
  await writeFile(path.join(publicDir, "apple-touch-icon.png"), apple);
} finally {
  await browser.close();
}

for (const name of ["favicon.ico", "apple-touch-icon.png"]) {
  const stats = await readFile(path.join(publicDir, name));
  console.log(`${name}: ${stats.length} bytes`);
}
