import fs from "node:fs";
import { createRequire } from "node:module";

// フォントを、使った字だけに絞る（EPUB に書体を埋め込むため）。HarfBuzz の subset（WebAssembly）を使う。
// 字の対応表（cmap）と、縦書き用の字形（vert など）の組版の情報は残る。

interface HbSubset {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_data(b: number, lengthPtr: number): number;
  hb_blob_get_length(b: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_set_add(set: number, cp: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_unicode_set(i: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

let instance: HbSubset | undefined;

function hb(): HbSubset {
  if (instance) return instance;
  const require = createRequire(import.meta.url);
  // harfbuzzjs の package.json の exports に wasm がないので、パッケージの場所から探す。
  const dir = require.resolve("harfbuzzjs").replace(/[\\/]dist[\\/][^\\/]+$/, "");
  const bytes = fs.readFileSync(`${dir}/dist/harfbuzz-subset.wasm`);
  const module = new WebAssembly.Module(bytes);
  instance = new WebAssembly.Instance(module, {}).exports as unknown as HbSubset;
  return instance;
}

/** 書体を、text に出てくる字だけに絞る。絞れなければ null。 */
export function subsetFont(bytes: Uint8Array, text: string, faceIndex = 0): Uint8Array | null {
  const h = hb();
  const ptr = h.malloc(bytes.length);
  new Uint8Array(h.memory.buffer).set(bytes, ptr);
  // HB_MEMORY_MODE_WRITABLE（2）：HarfBuzz は ptr を書き換えずに読む。後で自分で free する。
  const blob = h.hb_blob_create(ptr, bytes.length, 2, 0, 0);
  const face = h.hb_face_create(blob, faceIndex);
  h.hb_blob_destroy(blob);
  const input = h.hb_subset_input_create_or_fail();
  try {
    if (!input) return null;
    const unicodes = h.hb_subset_input_unicode_set(input);
    for (const ch of new Set(text)) h.hb_set_add(unicodes, ch.codePointAt(0)!);
    const sub = h.hb_subset_or_fail(face, input);
    if (!sub) return null;
    const out = h.hb_face_reference_blob(sub);
    const length = h.hb_blob_get_length(out);
    const data = h.hb_blob_get_data(out, 0);
    const result = new Uint8Array(h.memory.buffer).slice(data, data + length);
    h.hb_blob_destroy(out);
    h.hb_face_destroy(sub);
    return length > 0 ? result : null;
  } finally {
    if (input) h.hb_subset_input_destroy(input);
    h.hb_face_destroy(face);
    h.free(ptr);
  }
}
