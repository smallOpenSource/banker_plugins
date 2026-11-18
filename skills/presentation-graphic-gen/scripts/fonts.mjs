// fonts.mjs: the deck's fonts, subset to the characters a deck uses and returned as base64 TrueType for @font-face.
// Korean = Noto Sans KR, everything else = Noto Sans, weights 400 and 700. Subsetting runs HarfBuzz's hb-subset
// (WebAssembly, vendor/harfbuzz/harfbuzz-subset.wasm) through the small glue below: no Python, no npm package.
// When subsetting fails the full font is embedded and a warning is reported (the page still works, only larger).
// A vendored file that differs from its original is not a subsetting failure: it throws VendorError.
import { vendorBytes } from './vendor.mjs';

// CSS family names are private to the deck so an installed font of the same name never replaces them.
export const FACES = Object.freeze([
  { family: 'Deck Sans', weight: 400, rel: 'fonts/NotoSans-Regular.ttf' },
  { family: 'Deck Sans', weight: 700, rel: 'fonts/NotoSans-Bold.ttf' },
  { family: 'Deck Sans KR', weight: 400, rel: 'fonts/NotoSansKRStatic-Regular.ttf' },
  { family: 'Deck Sans KR', weight: 700, rel: 'fonts/NotoSansKRStatic-Bold.ttf' },
]);

// hb_memory_mode_t HB_MEMORY_MODE_WRITABLE; hb_subset_sets_t HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

/** Instantiates hb-subset; the module has no imports. */
export async function loadSubsetter(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const e = instance.exports;
  if (typeof e._initialize === 'function') e._initialize();
  for (const f of ['malloc', 'free', 'hb_blob_create', 'hb_face_create', 'hb_subset_input_create_or_fail', 'hb_subset_or_fail', 'hb_face_reference_blob', 'hb_blob_get_data']) {
    if (typeof e[f] !== 'function') throw new Error(`hb-subset: export ${f} missing`);
  }
  return (font, codepoints) => {
    const heap = () => new Uint8Array(e.memory.buffer);
    const ptr = e.malloc(font.length);
    if (!ptr) throw new Error('hb-subset: out of memory');
    heap().set(font, ptr);
    const blob = e.hb_blob_create(ptr, font.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
    const face = e.hb_face_create(blob, 0);
    e.hb_blob_destroy(blob);
    const input = e.hb_subset_input_create_or_fail();
    try {
      if (!input) throw new Error('hb-subset: input create failed');
      const uni = e.hb_subset_input_unicode_set(input);
      for (const cp of codepoints) e.hb_set_add(uni, cp);
      // keep every layout feature (kerning, Hangul jamo composition, ligatures)
      const feats = e.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
      e.hb_set_clear(feats);
      e.hb_set_invert(feats);
      const sub = e.hb_subset_or_fail(face, input);
      if (!sub) throw new Error('hb-subset: subsetting failed');
      const out = e.hb_face_reference_blob(sub);
      const len = e.hb_blob_get_length(out);
      const data = e.hb_blob_get_data(out, 0);
      const bytes = Buffer.from(heap().slice(data, data + len));
      e.hb_blob_destroy(out);
      e.hb_face_destroy(sub);
      if (len < 12 || bytes.readUInt32BE(0) !== 0x00010000) throw new Error('hb-subset: result is not a TrueType font');
      return bytes;
    } finally {
      if (input) e.hb_subset_input_destroy(input);
      e.hb_face_destroy(face);
      e.free(ptr);
    }
  };
}

/** Code points to keep: every character of the text plus printable ASCII. */
export function codepointsOf(text) {
  const set = new Set();
  for (let c = 0x20; c < 0x7f; c++) set.add(c);
  for (const ch of String(text)) { const cp = ch.codePointAt(0); if (cp >= 0x20) set.add(cp); }
  return [...set].sort((a, b) => a - b);
}

/**
 * Fonts for a deck: [{ family, weight, b64, bytes, subset }]. options.wasm replaces the vendored hb-subset bytes
 * (tests pass broken bytes to reach the fallback); options.onWarn receives one line per fallback.
 */
export async function embedFonts(text, { wasm, onWarn = () => {} } = {}) {
  const fonts = FACES.map((f) => ({ ...f, original: vendorBytes(f.rel) }));
  const cps = codepointsOf(text);
  // a vendored wasm that fails its sha256 check stops the build (VendorError, exit 3); only a subsetter that does
  // not run falls back to the full fonts
  const wasmBytes = wasm || vendorBytes('harfbuzz/harfbuzz-subset.wasm');
  let subset = null;
  try {
    subset = await loadSubsetter(wasmBytes);
  } catch (e) {
    onWarn(`font subsetting unavailable (${e.message}); embedding the full fonts`);
  }
  return fonts.map((f) => {
    let bytes = f.original, ok = false;
    if (subset) {
      try { bytes = subset(f.original, cps); ok = true; } catch (e) { onWarn(`${f.rel}: subsetting failed (${e.message}); embedding the full font`); }
    }
    return { family: f.family, weight: f.weight, rel: f.rel, subset: ok, bytes, b64: bytes.toString('base64') };
  });
}
