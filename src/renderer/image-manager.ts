import { INVALID_IMAGE_NAME, type DocImage, type ImageLink } from "../document/document.js";
import type { LinkStatus } from "../document/image-link.js";
import { linkFindings } from "../document/link-findings.js";
import type { Finding } from "../output/preflight.js";

/** 画面に描く画像の長い辺の画素の上限。画像の書き出しと PDF は元の画像から作るので、画面用だけ縮めて持つ（#18）。 */
const SCREEN_MAX_PX = 2400;

/** 画面用の画像：大きければ縮めて、元の画像は閉じる（元の大きさは呼ぶ側で先に読んでおく）。 */
async function forScreen(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= SCREEN_MAX_PX) return bitmap;
  const f = SCREEN_MAX_PX / long;
  const small = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * f), resizeHeight: Math.round(bitmap.height * f), resizeQuality: "high" });
  bitmap.close();
  return small;
}

// 設定欄の「画像」：文書に画像（PNG・JPEG）を入れる・名前を変える・消す・原稿に［＃画像：名前］を入れる（DTP-12）。
// 画像は文書ファイルの中に入る。画面の描画用に、読み込んだ画像（ImageBitmap）を名前で持つ。
// リンク（#9）：取り込んだ元のファイルを覚えておき、変わった・なくなったことを知らせる。更新（読み直し）と差し替えができる。

/** リンクのファイルを読んだ結果。 */
export type LinkedFile = { mime: DocImage["mime"]; data: string; link: ImageLink } | { error: string };

export interface ImageHandlers {
  /** 画像の一覧が変わった（文書を変更した）。 */
  changed(): void;
  /** 原稿のカーソルの位置に1行入れる。 */
  insertLine(line: string): void;
  /** 原稿の中の［＃画像：古い名前…］を新しい名前にする。 */
  renameInText(from: string, to: string): void;
  /** リンクの状態を調べる（リンクのない画像は null）。 */
  linkStatus(links: (ImageLink | null)[]): Promise<(LinkStatus | null)[]>;
  /** 選んだファイルのリンク（場所が分からなければ undefined）。 */
  linkOf(file: File): Promise<ImageLink | undefined>;
  /** リンクのファイルを読み直す。 */
  readLink(file: string): Promise<LinkedFile>;
  /** 差し替える画像を選ぶ。 */
  chooseImage(current?: string): Promise<LinkedFile | undefined>;
  /** 状態の欄に知らせる。 */
  notify(text: string): void;
}

const MAX_FILE_BYTES = 30 * 1024 * 1024;

export class ImageManager {
  images: DocImage[] = [];
  /** 描画用（名前で引く）。 */
  readonly bitmaps = new Map<string, ImageBitmap>();
  /** リンクの状態（画像ごと）。調べるまでは持たない。 */
  private readonly status = new WeakMap<DocImage, LinkStatus>();
  private root: HTMLElement | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly h: ImageHandlers) {}

  /** 文書を開いたとき：画像を入れ替えて、描画用に読み込む。 */
  async load(images: DocImage[]) {
    this.images = images;
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
    // 一度に読むのは4枚まで（写真の多い本で、全部を同時に読むとメモリが一時に膨らむため。#18）。
    let next = 0;
    const worker = async () => {
      while (next < images.length) await this.decode(images[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(4, images.length) }, worker));
    this.render();
    // 開いたときに、元のファイルが変わっていないかを調べて知らせる。
    await this.checkLinks(true);
  }

  /**
   * リンクの状態を調べ直す（開いたとき・Kolophon に戻ってきたとき・書き出す前）。
   * 元の場所になく、文書からの相対の場所で見つかったときは、その場所をリンクにする。announce なら、変わったものを状態の欄で知らせる。
   */
  checkLinks(announce = false): Promise<void> {
    if (!this.images.some((i) => i.link)) return Promise.resolve();
    this.checking ??= (async () => {
      try {
        const list = this.images;
        const result = await this.h.linkStatus(list.map((i) => i.link ?? null));
        let changed = false;
        list.forEach((img, k) => {
          const st = result[k];
          if (!st || !img.link) return;
          const before = this.status.get(img);
          if (before?.state !== st.state || before?.path !== st.path) changed = true;
          this.status.set(img, st);
          // 見つけた場所と、文書からの相対の場所を覚え直す（中身は変えないので、文書の変更にはしない）。
          if (st.path && st.path !== img.link.path) img.link.path = st.path;
          if (st.relative !== undefined) img.link.relative = st.relative;
        });
        if (changed) this.render();
        if (announce) {
          const { modified, missing } = this.counts();
          if (modified + missing > 0) this.h.notify(`リンクの画像：${[modified ? `元のファイルが変わったもの ${modified}個` : "", missing ? `見つからないもの ${missing}個` : ""].filter(Boolean).join("・")}（設定欄の「画像」で更新・差し替えできます）`);
        }
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private counts() {
    let modified = 0;
    let missing = 0;
    for (const img of this.images) {
      const st = this.status.get(img)?.state;
      if (st === "modified") modified++;
      else if (st === "missing") missing++;
    }
    return { modified, missing };
  }

  /** 書き出す前の検査に足す知らせ：元のファイルが変わった画像（注意）・見つからない画像（参考。文書の中の画像で書き出す）。 */
  async linkFindings(): Promise<Finding[]> {
    await this.checkLinks();
    return linkFindings(this.images, (img) => this.status.get(img)?.state);
  }

  /** リンクのファイルを読み直して、画像の中身を入れ替える（名前と原稿の［＃画像：］はそのまま）。 */
  private async apply(img: DocImage, r: LinkedFile | undefined, quiet = false): Promise<boolean> {
    if (!r) return false;
    if ("error" in r) {
      if (!quiet) alert(r.error);
      return false;
    }
    let bitmap: ImageBitmap;
    try {
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      bitmap = await createImageBitmap(new Blob([bytes], { type: r.mime }));
    } catch {
      if (!quiet) alert(`「${r.link.path}」を画像として読めませんでした。`);
      return false;
    }
    Object.assign(img, { mime: r.mime, data: r.data, width: bitmap.width, height: bitmap.height, link: r.link });
    this.bitmaps.get(img.name)?.close();
    this.bitmaps.set(img.name, await forScreen(bitmap));
    this.status.set(img, { state: "ok", path: r.link.path, relative: r.link.relative });
    return true;
  }

  /** 元のファイルが変わった画像を取り込み直す（img を渡さなければ、変わったものすべて）。 */
  private async update(img?: DocImage) {
    const targets = img ? [img] : this.images.filter((i) => this.status.get(i)?.state === "modified");
    let n = 0;
    for (const t of targets) if (t.link && (await this.apply(t, await this.h.readLink(this.status.get(t)?.path ?? t.link.path), targets.length > 1))) n++;
    if (n === 0) return;
    this.render();
    this.h.changed();
    this.h.notify(`画像を${n}個、元のファイルから取り込み直しました。`);
  }

  /** 別のファイルに差し替える（名前と原稿の［＃画像：］はそのまま）。 */
  private async replace(img: DocImage) {
    if (!(await this.apply(img, await this.h.chooseImage(img.link?.path)))) return;
    this.render();
    this.h.changed();
  }

  /** リンクを外す（文書の中の画像だけにする）。 */
  private unlink(img: DocImage) {
    delete img.link;
    this.status.delete(img);
    this.render();
    this.h.changed();
  }

  private async decode(img: DocImage) {
    try {
      const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
      // 文書の画像は大きさが分かっているので、はじめから画面用の大きさで読む（元の大きさで読んでから縮めるより、メモリが少ない）。
      const f = Math.min(1, SCREEN_MAX_PX / Math.max(img.width, img.height, 1));
      const blob = new Blob([bytes], { type: img.mime });
      const bitmap = f < 1 ? await createImageBitmap(blob, { resizeWidth: Math.round(img.width * f), resizeHeight: Math.round(img.height * f), resizeQuality: "high" }) : await createImageBitmap(blob);
      this.bitmaps.set(img.name, await forScreen(bitmap));
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
    hint.textContent = "PNG・JPEG。画像は文書ファイルの中に保存され、元のファイルの場所も覚えておきます（元のファイルが変わったら知らせます）。入稿用の PDF では CMYK（またはグレー）に変換します。";
    root.append(add, file, hint);
    const { modified, missing } = this.counts();
    if (modified + missing > 0) {
      const box = document.createElement("div");
      box.className = "link-summary";
      if (modified > 0) box.append(this.button(`元のファイルが変わった画像をすべて更新（${modified}個）`, () => void this.update()));
      if (missing > 0) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = `元のファイルが見つからない画像が ${missing}個あります。文書の中の画像はそのまま使えます。「差し替え…」でファイルを選び直せます。`;
        box.append(p);
      }
      root.append(box);
    }
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
    // 版面・行の中：枠いっぱいに広げる（はみ出た分を切る）と、キャプション。
    const fillLabel = document.createElement("label");
    fillLabel.className = "check";
    const fillBox = document.createElement("input");
    fillBox.type = "checkbox";
    fillLabel.append(fillBox, document.createTextNode("枠いっぱい（はみ出た分を切る）"));
    const caption = document.createElement("input");
    caption.type = "text";
    caption.placeholder = "キャプション（空なら付けない）";
    caption.setAttribute("aria-label", "キャプション");
    const extra = document.createElement("div");
    extra.className = "row";
    extra.append(fillLabel, caption);
    const sync = () => {
      lineOpts.hidden = mode.value !== "lines";
      extra.hidden = mode.value === "full";
    };
    mode.addEventListener("change", sync);
    sync();
    const insert = this.button("原稿に入れる", () => {
      const opts = mode.value === "full" ? ["全面"] : mode.value === "lines" ? [`${Math.max(1, Number(lines.value) || 1)}行`, ...(wrapBox.checked ? ["回り込み"] : []), ...(pos.value ? [pos.value] : [])] : [];
      if (mode.value !== "full") {
        if (fillBox.checked) opts.push("切り抜き");
        // キャプションは最後に書く（［］は記法と紛れるので、全角の〔〕にする）。
        const text = caption.value.trim().replace(/［/g, "〔").replace(/］/g, "〕");
        if (text) opts.push(`キャプション：${text}`);
      }
      this.h.insertLine(`［＃画像：${img.name}${opts.map((o) => `　${o}`).join("")}］`);
    });
    const del = this.button("削除", () => this.remove(img));
    del.classList.add("danger");

    const head = document.createElement("div");
    head.className = "row";
    head.append(name, info);
    const link = document.createElement("div");
    link.className = "row link-row";
    const state = this.status.get(img)?.state;
    const where = document.createElement("span");
    where.className = "computed link-path";
    if (img.link) {
      where.textContent = `リンク：${img.link.path.split(/[\\/]/).pop()}`;
      where.title = img.link.path;
      const badge = document.createElement("span");
      badge.className = `link-state ${state ?? "unknown"}`;
      badge.textContent = state === "modified" ? "更新あり" : state === "missing" ? "見つからない" : state === "ok" ? "元のファイルと同じ" : "";
      link.append(where, badge);
      if (state === "modified") link.append(this.button("更新", () => void this.update(img)));
    } else {
      where.textContent = "リンクなし（文書の中だけ）";
      link.append(where);
    }
    link.append(this.button("差し替え…", () => void this.replace(img)));
    if (img.link) link.append(this.button("リンクを外す", () => this.unlink(img)));
    const actions = document.createElement("div");
    actions.className = "row";
    actions.append(mode, insert, del);
    const body = document.createElement("div");
    body.className = "image-body";
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent = "原稿の行には、ほかに「切り抜き：上10下10」（元の画像を％で切る）・「大きさ：80%」・「ずらす：右2下3」（mm）を書けます。";
    body.append(head, link, actions, lineOpts, extra, help);
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
      const link = await this.h.linkOf(f);
      const img: DocImage = {
        name: this.uniqueName(f.name.replace(/\.[^.]+$/, "")),
        mime: f.type,
        data: toBase64(bytes),
        width: bitmap.width,
        height: bitmap.height,
        ...(link ? { link } : {}),
      };
      if (link) this.status.set(img, { state: "ok", path: link.path, relative: link.relative });
      this.images.push(img);
      this.bitmaps.set(img.name, await forScreen(bitmap));
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
