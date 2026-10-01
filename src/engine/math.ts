import { createRequire } from "node:module";

// 数式（TeX の記法）を MathJax で組み、輪郭（SVG のパス）の並びにする。
// 画面・PDF・画像のどれでも、この輪郭を塗って描く（数式用のフォントを埋め込まなくてよい）。
// MathJax は CommonJS 版を使う（フォントの追加データも同じ版で読み込み、すべて同期で済ませるため）。
// 最初に数式を組むときに MathJax を読み込む（数式のない文書では読み込まない）。

/** 変換行列 [a, b, c, d, e, f]：x' = a·x + c·y + e、y' = b·x + d·y + f。 */
export type Matrix = [number, number, number, number, number, number];

export interface MathBox {
  /** 幅・ベースラインより上の高さ・下の深さ（em）。 */
  width: number;
  height: number;
  depth: number;
  /** 輪郭。m は d の座標を、数式の左端・ベースラインを原点とする em 単位（y は下向き）に写す。 */
  paths: { d: string; m: Matrix }[];
  /** 組めなかったときの知らせ（TeX の誤りなど）。 */
  error?: string;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 のあとに m2 を当てる行列（m2 ∘ m1）。 */
export function multiply(m2: Matrix, m1: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1, a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2];
}

/** SVG の transform 属性を行列にする（translate・scale・matrix・rotate）。 */
export function parseTransform(t: string | null | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!t) return m;
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let local: Matrix = IDENTITY;
    if (fn === "translate") local = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (fn === "scale") local = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (fn === "matrix") local = v.slice(0, 6) as Matrix;
    else if (fn === "rotate") {
      const r = ((v[0] ?? 0) * Math.PI) / 180;
      local = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    }
    // SVG では左に書いた変換が外側（あとから当たる）。
    m = multiply(m, local);
  }
  return m;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Jax {
  adaptor: any;
  doc: any;
}
let jax: Jax | undefined;

function load(): Jax {
  if (jax) return jax;
  const require = createRequire(import.meta.url);
  const { mathjax } = require("@mathjax/src/js/mathjax.js");
  const { TeX } = require("@mathjax/src/js/input/tex.js");
  const { SVG } = require("@mathjax/src/js/output/svg.js");
  const { liteAdaptor } = require("@mathjax/src/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("@mathjax/src/js/handlers/html.js");
  require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
  require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
  require("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js");
  require("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js");
  const { MathJaxNewcmFont } = require("@mathjax/mathjax-newcm-font/js/svg.js");
  // フォントの追加データ（記号など）を、同期で読み込めるようにする。
  mathjax.asyncLoad = (name: string) => require(name);
  mathjax.asyncIsSynchronous = true;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "newcommand", "boldsymbol"] }),
    // 行の中の数式を MathJax で改行させない（tategumi の行分割に任せる）。
    OutputJax: new SVG({ fontCache: "none", fontData: MathJaxNewcmFont, linebreaks: { inline: false } }),
  });
  doc.outputJax.font.loadDynamicFilesSync();
  jax = { adaptor, doc };
  return jax;
}

const cache = new Map<string, MathBox>();

/** 数式を組む。同じ式は使い回す。 */
export function renderMath(tex: string, display: boolean): MathBox {
  const key = `${display ? "D" : "I"}\u0000${tex}`;
  let box = cache.get(key);
  if (!box) {
    box = convert(tex, display);
    cache.set(key, box);
  }
  return box;
}

function convert(tex: string, display: boolean): MathBox {
  const { adaptor, doc } = load();
  let container: any;
  try {
    container = doc.convert(tex, { display });
  } catch (e) {
    return { width: 1, height: 0.8, depth: 0.2, paths: [], error: e instanceof Error ? e.message : String(e) };
  }
  const svg = findFirst(adaptor, container, "svg");
  if (!svg) return { width: 1, height: 0.8, depth: 0.2, paths: [], error: "数式を組めませんでした。" };
  const [minX, minY, w, h] = (adaptor.getAttribute(svg, "viewBox") ?? "0 0 1000 1000").split(/\s+/).map(Number);
  // viewBox の単位は 1/1000 em。左端を 0、ベースラインを y=0 にそろえる。
  const toEm: Matrix = [1 / 1000, 0, 0, 1 / 1000, -minX / 1000, 0];
  const paths: MathBox["paths"] = [];
  const errors: string[] = [];
  walk(adaptor, svg, toEm, paths, errors, true);
  return { width: w / 1000, height: -minY / 1000, depth: (h + minY) / 1000, paths, ...(errors.length ? { error: errors.join(" ") } : {}) };
}

function findFirst(adaptor: any, node: any, tag: string): any {
  if (adaptor.kind(node) === tag) return node;
  for (const child of adaptor.childNodes(node) ?? []) {
    const found = findFirst(adaptor, child, tag);
    if (found) return found;
  }
  return null;
}

/** SVG をたどって、パスと四角形（分数の線など）を、行列つきの輪郭にする。 */
function walk(adaptor: any, node: any, parent: Matrix, out: MathBox["paths"], errors: string[], root = false): void {
  const kind = adaptor.kind(node);
  if (kind === "#text" || kind === "#comment") return;
  let m = multiply(parent, parseTransform(adaptor.getAttribute(node, "transform")));
  if (kind === "svg" && !root) {
    // 入れ子の svg（伸びる括弧など）：x・y と viewBox を行列にする。
    const x = Number(adaptor.getAttribute(node, "x") ?? 0);
    const y = Number(adaptor.getAttribute(node, "y") ?? 0);
    const vb = adaptor.getAttribute(node, "viewBox");
    m = multiply(m, [1, 0, 0, 1, x, y]);
    if (vb) {
      const [vx, vy, vw, vh] = vb.split(/\s+/).map(Number);
      const width = parseFloat(adaptor.getAttribute(node, "width") ?? `${vw}`);
      const height = parseFloat(adaptor.getAttribute(node, "height") ?? `${vh}`);
      m = multiply(m, [width / vw, 0, 0, height / vh, -vx * (width / vw), -vy * (height / vh)]);
    }
  }
  if (kind === "path") {
    const d = adaptor.getAttribute(node, "d");
    if (d) out.push({ d, m });
    return;
  }
  if (kind === "rect") {
    const x = Number(adaptor.getAttribute(node, "x") ?? 0);
    const y = Number(adaptor.getAttribute(node, "y") ?? 0);
    const w = Number(adaptor.getAttribute(node, "width") ?? 0);
    const h = Number(adaptor.getAttribute(node, "height") ?? 0);
    out.push({ d: `M${x} ${y}H${x + w}V${y + h}H${x}Z`, m });
    return;
  }
  if (kind === "text") {
    // フォントにない字（\text{日本語} など）は輪郭がないので描けない。
    errors.push(`数式の中の「${adaptor.textContent(node)}」は描けません（数式の外に書いてください）。`);
    return;
  }
  const err = adaptor.getAttribute(node, "data-mjx-error");
  if (err) {
    // TeX の誤り：MathJax が組んだ誤りの知らせ（文字）は描けないので、知らせだけを返す。
    errors.push(`数式の誤り：${err}`);
    return;
  }
  for (const child of adaptor.childNodes(node) ?? []) walk(adaptor, child, m, out, errors);
}
