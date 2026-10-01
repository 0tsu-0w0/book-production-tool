import type { NamedMaster } from "../document/settings.js";

// 設定欄の「名前を付けたマスターページ」（DTP-05）。追加・名前の変更・削除と、柱・ノンブル・飾りの指定。
// 原稿に［＃マスター：名前］と書いたページから、そのマスターを使う（［＃マスター：標準］で戻す）。

const HEADS: [NamedMaster["bodyOdd"], string][] = [
  ["none", "なし"],
  ["book-title", "書名"],
  ["chapter", "章題"],
  ["section", "節題"],
];

const DECORATIONS: [string, string][] = [
  ["inherit", "標準のまま"],
  ["none", "なし"],
  ["double-line", "二本線"],
  ["top-bottom-line", "上下線"],
  ["gradient", "上下グラデ"],
  ["dots", "・・"],
  ["circle-m", "●●（中）"],
  ["diamond-m", "◆◆（中）"],
  ["square-m", "■■（中）"],
];

export class MasterEditor {
  readonly element = document.createElement("div");

  constructor(
    private readonly masters: NamedMaster[],
    private readonly onChange: () => void,
  ) {
    this.element.className = "fields";
    this.element.style.padding = "0";
    this.render();
  }

  private render() {
    this.element.replaceChildren();
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "原稿に［＃マスター：名前］と書いたページから使います（［＃マスター：標準］で元に戻す）。柱の位置と大きさは標準のマスターと同じです。";
    this.element.append(hint);
    this.masters.forEach((m, i) => this.element.append(this.item(m, i)));
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "マスターを追加";
    add.addEventListener("click", () => {
      let n = 1;
      while (this.masters.some((x) => x.name === `マスター${n}`)) n++;
      this.masters.push({
        name: `マスター${n}`,
        bodyOdd: "none",
        bodyEven: "none",
        bodyNombre: true,
        openingOdd: "none",
        openingEven: "none",
        openingNombre: true,
        decoration: "inherit",
      });
      this.changed();
    });
    this.element.append(add);
  }

  private changed() {
    this.render();
    this.onChange();
  }

  private item(m: NamedMaster, i: number): HTMLElement {
    const box = document.createElement("div");
    box.className = "master-item";
    const name = document.createElement("input");
    name.type = "text";
    name.value = m.name;
    name.setAttribute("aria-label", "マスターの名前");
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v || v === "標準" || /[［］＃／：:\s]/u.test(v) || this.masters.some((x) => x !== m && x.name === v)) {
        name.value = m.name;
        name.setCustomValidity("使えない名前です（空・重複・「標準」・空白や［］＃／：を含む）。");
        name.reportValidity();
        return;
      }
      name.setCustomValidity("");
      m.name = v;
      this.onChange();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "削除";
    del.addEventListener("click", () => {
      if (!confirm(`マスター「${m.name}」を削除します。原稿の［＃マスター：${m.name}］のページは、標準のマスターになります。`)) return;
      this.masters.splice(i, 1);
      this.changed();
    });
    const head = document.createElement("div");
    head.className = "row";
    head.append(name, del);

    const select = (label: string, options: [string, string][], value: string, set: (v: string) => void) => {
      const wrap = document.createElement("label");
      wrap.className = "field inline";
      const span = document.createElement("span");
      span.textContent = label;
      const s = document.createElement("select");
      for (const [v, l] of options) s.add(new Option(l, v));
      s.value = value;
      s.addEventListener("change", () => {
        set(s.value);
        this.onChange();
      });
      wrap.append(span, s);
      return wrap;
    };
    const check = (label: string, value: boolean, set: (v: boolean) => void) => {
      const wrap = document.createElement("label");
      wrap.className = "field check";
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = value;
      c.addEventListener("change", () => {
        set(c.checked);
        this.onChange();
      });
      wrap.append(c, document.createTextNode(label));
      return wrap;
    };
    box.append(
      head,
      select("本文の奇数ページの柱", HEADS, m.bodyOdd, (v) => (m.bodyOdd = v as NamedMaster["bodyOdd"])),
      select("本文の偶数ページの柱", HEADS, m.bodyEven, (v) => (m.bodyEven = v as NamedMaster["bodyEven"])),
      check("本文のページにノンブル", m.bodyNombre, (v) => (m.bodyNombre = v)),
      select("章の始まりの奇数ページの柱", HEADS, m.openingOdd, (v) => (m.openingOdd = v as NamedMaster["openingOdd"])),
      select("章の始まりの偶数ページの柱", HEADS, m.openingEven, (v) => (m.openingEven = v as NamedMaster["openingEven"])),
      check("章の始まりのページにノンブル", m.openingNombre, (v) => (m.openingNombre = v)),
      select("上下の飾り", DECORATIONS, m.decoration, (v) => (m.decoration = v as NamedMaster["decoration"])),
    );
    return box;
  }
}
