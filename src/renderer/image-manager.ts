import { INVALID_IMAGE_NAME, type DocImage } from "../document/document.js";

// 設定欄の「画像」：文書に画像（PNG・JPEG）を入れる・名前を変える・消す・原稿に［＃画像：名前］を入れる（DTP-12）。
// 画像は文書ファイルの中に入る。画面の描画用に、読み込んだ画像（ImageBitmap）を名前で持つ。

export interface ImageHandlers {
  /** 画像の一覧が変わった（文書を変更した）。 */
  changed(): void;
  /** 原稿のカーソルの位置に1行入れる。 */
  insertLine(line: string): void;
  /** 原稿の中の［＃画像：古い名前…］を新しい名前にする。 */
  renameInText(from: string, to: string): void;
}

const MAX_FILE_BYTES = 30 * 1024 * 1024;

export class ImageManager {
  images: DocImage[] = [];
  /** 描画用（名前で引く）。 */
  readonly bitmaps = new Map<string, ImageBitmap>();
  private root: HTMLElement | null = null;

  constructor(private readonly h: ImageHandlers) {}

  /** 文書を開いたとき：画像を入れ替えて、描画用に読み込む。 */
  async load(images: DocImage[]) {
    this.images = images;
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
    await Promise.all(images.map((i) => this.decode(i)));
    this.render();
  }

  private async decode(img: DocImage) {
    try {
      const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
      this.bitmaps.set(img.name, await createImageBitmap(new Blob([bytes], { type: img.mime })));
    } catch {
      // 壊れた画像は描かない（枠と×印になる）。
    }
  }

  /** 設定欄に入れる部品。設定欄を作り直すたびに呼ばれる。 */
  element(): HTMLElement {
    this.root = document.createElement("div");
    this.root.className = "fields";
    this.root.style.padding = "0";
    this.render();
    return this.root;
  }

  private render() {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg";
    file.multiple = true;
    file.hidden = true;
    file.addEventListener("change", () => void this.addFiles([...(file.files ?? [])]));
    const add = this.button("画像を入れる…", () => file.click());
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "PNG・JPEG。画像は文書ファイルの中に保存されます。入稿用の PDF では CMYK（またはグレー）に変換します。";
    root.append(add, file, hint);
    for (const img of this.images) root.append(this.row(img));
  }

  private row(img: DocImage): HTMLElement {
    const box = document.createElement("div");
    box.className = "image-item";
    const thumb = document.createElement("img");
    thumb.src = `data:${img.mime};base64,${img.data}`;
    thumb.alt = img.name;
    const name = document.createElement("input");
    name.type = "text";
    name.value = img.name;
    name.setAttribute("aria-label", "画像の名前");
    name.addEventListener("change", () => this.rename(img, name));
    const info = document.createElement("span");
    info.className = "computed";
    info.textContent = `${img.width}×${img.height}px`;

    // 原稿に入れる：置き方を選んで［＃画像：名前　…］の行を入れる。
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "置き方");
    for (const [v, label] of [
      ["block", "版面に収めて1ページ"],
      ["full", "ページ全面（塗り足しまで）"],
      ["lines", "本文の中（行数を指定）"],
    ]) {
      mode.add(new Option(label, v));
    }
    const lines = document.createElement("input");
    lines.type = "number";
    Object.assign(lines, { min: "1", max: "40", value: "5" });
    lines.setAttribute("aria-label", "行数");
    const wrap = document.createElement("label");
    wrap.className = "check";
    const wrapBox = document.createElement("input");
    wrapBox.type = "checkbox";
    wrap.append(wrapBox, document.createTextNode("回り込み"));
    const pos = document.createElement("select");
    pos.setAttribute("aria-label", "行の中の位置");
    for (const [v, label] of [["", "位置：自動"], ["天", "天"], ["中央", "中央"], ["地", "地"]]) pos.add(new Option(label, v));
    const lineOpts = document.createElement("span");
    lineOpts.className = "row";
    lineOpts.append(lines, document.createTextNode("行"), wrap, pos);
    const sync = () => (lineOpts.hidden = mode.value !== "lines");
    mode.addEventListener("change", sync);
    sync();
    const insert = this.button("原稿に入れる", () => {
      const opts = mode.value === "full" ? ["全面"] : mode.value === "lines" ? [`${Math.max(1, Number(lines.value) || 1)}行`, ...(wrapBox.checked ? ["回り込み"] : []), ...(pos.value ? [pos.value] : [])] : [];
      this.h.insertLine(`［＃画像：${img.name}${opts.map((o) => `　${o}`).join("")}］`);
    });
    const del = this.button("削除", () => this.remove(img));
    del.classList.add("danger");

    const head = document.createElement("div");
    head.className = "row";
    head.append(name, info);
    const actions = document.createElement("div");
    actions.className = "row";
    actions.append(mode, insert, del);
    const body = document.createElement("div");
    body.className = "image-body";
    body.append(head, actions, lineOpts);
    box.append(thumb, body);
    return box;
  }

  private async addFiles(files: File[]) {
    for (const f of files) {
      if (f.type !== "image/png" && f.type !== "image/jpeg") {
        alert(`「${f.name}」は PNG・JPEG ではないので入れられません。`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        alert(`「${f.name}」は大きすぎます（30MB まで）。`);
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: f.type }));
      } catch {
        alert(`「${f.name}」を画像として読めませんでした。`);
        continue;
      }
      const img: DocImage = {
        name: this.uniqueName(f.name.replace(/\.[^.]+$/, "")),
        mime: f.type,
        data: toBase64(bytes),
        width: bitmap.width,
        height: bitmap.height,
      };
      this.images.push(img);
      this.bitmaps.set(img.name, bitmap);
    }
    this.render();
    this.h.changed();
  }

  /** 記法で使える名前にして、ほかの画像と重ならないようにする。 */
  private uniqueName(base: string): string {
    const clean = base.replace(new RegExp(INVALID_IMAGE_NAME.source, "gu"), "_") || "画像";
    let name = clean;
    for (let n = 2; this.images.some((i) => i.name === name); n++) name = `${clean}_${n}`;
    return name;
  }

  private rename(img: DocImage, input: HTMLInputElement) {
    const name = input.value.trim();
    if (!name || INVALID_IMAGE_NAME.test(name) || this.images.some((i) => i !== img && i.name === name)) {
      input.value = img.name;
      input.setCustomValidity("使えない名前です（空・重複・空白や［］＃／：を含む）。");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    if (name === img.name) return;
    const bitmap = this.bitmaps.get(img.name);
    this.bitmaps.delete(img.name);
    if (bitmap) this.bitmaps.set(name, bitmap);
    this.h.renameInText(img.name, name);
    img.name = name;
    this.render();
    this.h.changed();
  }

  private remove(img: DocImage) {
    if (!confirm(`画像「${img.name}」を文書から消します。原稿の［＃画像：${img.name}］は、枠だけになります。`)) return;
    this.images = this.images.filter((i) => i !== img);
    this.bitmaps.get(img.name)?.close();
    this.bitmaps.delete(img.name);
    this.render();
    this.h.changed();
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
