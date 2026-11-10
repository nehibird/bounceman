// Responsive-image helper for equipment photos (views/public/{index,equipment,equipment-detail}.ejs).
//
// WHY: photos were 150-800 KB originals shown at ~350 px; /equipment weighed 7 MB (34 s LCP on slow 4G).
// scripts/make-image-variants.sh writes "<original filename>.w400.webp" and ".w800.webp" beside each original.
//
// NAMING: the FULL original filename is kept ("a.jpg" -> "a.jpg.w400.webp") so "a.jpg" and "a.webp"
// can never share a derivative. Admin uploads are "<uuid><ext>" (routes/admin.js multer), which can never
// end in ".w400.webp" because path.extname() yields only the last ".webp" -> no collision with a future upload.
//
// FALLBACK (the point of existsSync here): a derivative is advertised ONLY if the file is on disk. A fresh
// upload with no derivatives, a path outside the two known dirs, or a placeholder SVG returns the original
// untouched, so it always renders. Never throws.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// URL prefix -> disk dir. /uploads is a runtime bind mount; /assets is baked into the image.
const MAP = [
  ['/uploads/equipment/', path.join(ROOT, 'uploads', 'equipment')],
  ['/assets/images/equipment/', path.join(ROOT, 'public', 'assets', 'images', 'equipment')],
];
const cache = new Map(); // src -> { at, v }; 60 s TTL so a freshly generated derivative is picked up without restart
const TTL = 60 * 1000;

// WebP header -> {w,h} so width/height attrs match the real aspect ratio (stops layout shift).
function webpSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, 0);
    const t = b.toString('ascii', 12, 16);
    if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (t === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (t === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  } finally { fs.closeSync(fd); }
  return null;
}

// -> { src, srcset ('' if none), thumbSrcset (400w only, for ~80 px thumbs), width, height }
function imgv(src) {
  const hit = cache.get(src);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  // Nominal 3:2 when nothing is known; every call site pins the box with CSS height/aspect-ratio, so this
  // only reserves space and cannot distort the picture.
  let v = { src, srcset: '', thumbSrcset: '', width: 800, height: 533 };
  try {
    const m = typeof src === 'string' && MAP.find(([p]) => src.startsWith(p));
    const name = m && src.slice(m[0].length);
    if (name && !name.includes('/') && !name.includes('..') && !/\.w\d+\.webp$/.test(name)) {
      const f4 = path.join(m[1], name + '.w400.webp');
      const f8 = path.join(m[1], name + '.w800.webp');
      const has4 = fs.existsSync(f4), has8 = fs.existsSync(f8);
      const parts = [];
      if (has4) parts.push(`${src}.w400.webp 400w`);
      if (has8) parts.push(`${src}.w800.webp 800w`);
      if (parts.length) {
        const d = webpSize(has8 ? f8 : f4);
        v = { src, srcset: parts.join(', '), thumbSrcset: has4 ? `${src}.w400.webp 400w` : '',
              width: d ? d.w : 800, height: d ? d.h : 533 };
      }
    }
  } catch (e) { /* fall through to the original */ }
  cache.set(src, { at: Date.now(), v });
  return v;
}

const escAttr = (x) => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Ready-to-splice <img> attribute string so views stay one-liners.
//   opts.sizes  - the CSS width the slot renders at (what makes the browser pick 400w vs 800w)
//   opts.eager  - above-the-fold image: no loading=lazy; opts.high adds fetchpriority=high (LCP only)
//   opts.thumb  - ~80 px thumbnail: 400w only
// width/height always emitted (real ratio when a derivative exists) so the box is reserved before bytes arrive.
function imgAttrs(src, opts) {
  const o = opts || {};
  const v = imgv(src);
  const set = o.thumb ? v.thumbSrcset : v.srcset;
  let a = `src="${escAttr(v.src)}"`;
  if (set) a += ` srcset="${escAttr(set)}" sizes="${escAttr(o.sizes || '100vw')}"`;
  a += ` width="${v.width}" height="${v.height}" decoding="async"`;
  if (!o.eager) a += ' loading="lazy"';
  else if (o.high) a += ' fetchpriority="high"';
  return a;
}

module.exports = { imgv, imgAttrs };
