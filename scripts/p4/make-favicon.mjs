// favicon PNG generation. Zero dependencies: Node's built-in zlib + a
// hand-rolled PNG encoder + SDF supersampled rasterization. The geometry
// constants match frontend/public/favicon.svg — change both together.
// Reproducible: same input, same bytes (a re-run produces an empty diff).
//
//   node make-favicon.mjs          # writes frontend/public/{favicon-32,apple-touch-icon}.png
//   node make-favicon.mjs --check  # compare against the checked-in artifacts
//
// apple-touch-icon is a full-bleed opaque square (iOS applies its own mask;
// transparent corners would show black). favicon-32 keeps the SVG's rounded
// corners + transparent corners. The background is the dark-theme --accent
// (#4f9cf7); only the SVG adapts to light/dark — the PNG is a fallback frame.

import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

// ---- geometry (48×48 viewBox, matching favicon.svg) ----
const VIEW = 48
const BG_RADIUS = 10.5
const STEM = { cx: 17.5, cy: 24, hx: 4, hy: 12, r: 4 } // rounded stem (8 wide, 24 tall)
const BOWL = { cx: 27.5, cy: 17.5, outer: 9.25, inner: 4 } // ring-shaped bowl
const ACCENT = [0x4f, 0x9c, 0xf7] // dark-theme --accent
const WHITE = [0xff, 0xff, 0xff]

const sdRoundRect = (px, py, hx, hy, r) => {
  const qx = Math.abs(px) - hx + r
  const qy = Math.abs(py) - hy + r
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

// one sample point → inside the glyph (stem ∪ ring)?
function inGlyph(u, v) {
  const stem = sdRoundRect(u - STEM.cx, v - STEM.cy, STEM.hx, STEM.hy, STEM.r) <= 0
  if (stem) return true
  const d = Math.hypot(u - BOWL.cx, v - BOWL.cy)
  return d <= BOWL.outer && d > BOWL.inner
}

// sizePx, corner radius (viewBox units), transparent corners → RGBA Buffer
function render(sizePx, cornerRadius, transparentCorners) {
  const SS = 4 // per-axis supersampling, 4×4 = 16 samples per pixel
  const px = Buffer.alloc(sizePx * sizePx * 4)
  const scale = VIEW / sizePx
  for (let y = 0; y < sizePx; y++) {
    for (let x = 0; x < sizePx; x++) {
      let cov = 0 // glyph coverage
      let bgCov = 0 // background coverage
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) * scale
          const v = (y + (sy + 0.5) / SS) * scale
          const inside =
            transparentCorners && cornerRadius > 0
              ? sdRoundRect(u - VIEW / 2, v - VIEW / 2, VIEW / 2, VIEW / 2, cornerRadius) <= 0
              : true
          if (!inside) continue
          bgCov++
          if (inGlyph(u, v)) cov++
        }
      }
      const bgAlpha = bgCov / (SS * SS)
      const glyphAlpha = cov / (SS * SS)
      const o = (y * sizePx + x) * 4
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round(ACCENT[c] + (WHITE[c] - ACCENT[c]) * glyphAlpha)
      }
      px[o + 3] = Math.round(255 * bgAlpha)
    }
  }
  return px
}

// ---- PNG encoding (truecolor RGBA8, filter 0) ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const OUT_DIR = new URL('../../frontend/public/', import.meta.url).pathname
const targets = [
  { file: 'favicon-32.png', size: 32, radius: BG_RADIUS, transparent: true },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, transparent: false },
]

const check = process.argv.includes('--check')
let changed = 0
for (const t of targets) {
  const png = encodePng(render(t.size, t.radius, t.transparent), t.size)
  const path = OUT_DIR + t.file
  if (check) {
    const existing = readFileSync(path)
    if (!existing.equals(png)) {
      console.error(`✗ ${t.file} differs from a fresh regeneration — do not hand-edit; re-run node make-favicon.mjs`)
      process.exit(1)
    }
    console.log(`✓ ${t.file} matches the geometry`)
  } else {
    writeFileSync(path, png)
    console.log(`${t.file}: ${png.length} bytes → ${path}`)
    changed++
  }
}
if (check) console.log('favicon artifacts are reproducible')
