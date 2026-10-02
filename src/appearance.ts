// 画面の見た目（アプリの設定。文書には入れない）：窓の背景に画像・動画・すりガラスを使う。
// 紙面はいつも不透明のまま。背景が見えるのは紙の周りと、半透明にした欄の後ろだけ。

export type BackgroundKind = "none" | "image" | "video" | "wallpaper" | "glass";
/** すりガラスの種類（Windows 11）。Mac ではどれも vibrancy になる。 */
export type GlassMaterial = "acrylic" | "mica" | "tabbed";
export type BackgroundFit = "cover" | "contain" | "tile";

export interface Appearance {
  kind: BackgroundKind;
  /** 取り込んだ画像・動画のファイル名（アプリの設定のフォルダの中）。 */
  file: string | null;
  /** 取り込む前のファイル名（表示用）。 */
  fileLabel: string;
  material: GlassMaterial;
  fit: BackgroundFit;
  /** 欄（ツールバー・原稿・設定）の濃さ（%）。100 で不透明。 */
  panelOpacity: number;
  /** 欄の後ろのぼかし（px）。 */
  blur: number;
  /** 背景を画面の地の色で薄める割合（%）。0 でそのまま。 */
  dim: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  kind: "none",
  file: null,
  fileLabel: "",
  material: "acrylic",
  fit: "cover",
  panelOpacity: 78,
  blur: 14,
  dim: 25,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** 保存してあった見た目を、足りない所を既定で補って読む。 */
export function normalizeAppearance(v: unknown): Appearance {
  const a = (v && typeof v === "object" ? v : {}) as Partial<Appearance>;
  const d = DEFAULT_APPEARANCE;
  const file = typeof a.file === "string" && a.file && !/[\\/]/.test(a.file) ? a.file : null;
  let kind = oneOf(a.kind, ["none", "image", "video", "wallpaper", "glass"] as const, d.kind);
  // 画像・動画なのにファイルがなければ、背景なしにする。
  if ((kind === "image" || kind === "video") && !file) kind = "none";
  return {
    kind,
    file,
    fileLabel: typeof a.fileLabel === "string" ? a.fileLabel : "",
    material: oneOf(a.material, ["acrylic", "mica", "tabbed"] as const, d.material),
    fit: oneOf(a.fit, ["cover", "contain", "tile"] as const, d.fit),
    panelOpacity: clamp(a.panelOpacity, 20, 100, d.panelOpacity),
    blur: clamp(a.blur, 0, 40, d.blur),
    dim: clamp(a.dim, 0, 90, d.dim),
  };
}

/** 背景に使えるファイルの拡張子。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v", "ogv"];

/** 取り込んだ背景を画面で読むための URL の scheme。 */
export const BACKGROUND_SCHEME = "kolophon-bg";
export const backgroundUrl = (file: string) => `${BACKGROUND_SCHEME}://media/${encodeURIComponent(file)}`;
/** デスクトップの壁紙の URL（version は壁紙が変わったら変わる値。読み直させるため）。 */
export const wallpaperUrl = (version: number) => `${BACKGROUND_SCHEME}://wallpaper/current?v=${version}`;

/** 窓の中身が、画面（ディスプレイ）のどこにあるか（壁紙の位置合わせに使う）。 */
export interface WindowGeometry {
  /** 中身の左上の、ディスプレイの左上からの位置。 */
  x: number;
  y: number;
  /** ディスプレイの大きさ。 */
  width: number;
  height: number;
}
