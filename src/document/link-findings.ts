import type { Finding } from "../output/preflight.js";
import type { DocImage } from "./document.js";
import type { LinkState } from "./image-link.js";

// 書き出す前の検査に足す、画像のリンクの知らせ（#9・#20）。画面の部品（ImageManager）から、リンクの状態を渡して使う。

/** 元のファイルが変わった画像は注意（このまま書き出すと取り込んだときの画像）、見つからない画像は参考（文書の中の画像で書き出す）。 */
export function linkFindings(images: DocImage[], stateOf: (img: DocImage) => LinkState | undefined): Finding[] {
  return images.flatMap((img): Finding[] => {
    if (!img.link) return [];
    const st = stateOf(img);
    if (st === "modified") return [{ level: "warning", message: `画像「${img.name}」の元のファイル（${img.link.path}）が、取り込んだあとに変わっています。設定欄の「画像」の「更新」で取り込み直せます（このまま書き出すと、取り込んだときの画像になります）。` }];
    if (st === "missing") return [{ level: "info", message: `画像「${img.name}」の元のファイル（${img.link.path}）が見つかりません。文書の中の画像で書き出します。` }];
    return [];
  });
}
