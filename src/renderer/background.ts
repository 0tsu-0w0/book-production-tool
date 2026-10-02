import { backgroundUrl, normalizeAppearance, wallpaperUrl, type Appearance, type BackgroundKind, type WindowGeometry } from "../appearance.js";

// 窓の背景（画像・動画・すりガラス）。背景の層を画面のいちばん後ろに置き、ツールバー・原稿・設定の欄を半透明にする。
// 紙面（canvas）はいつも不透明。すりガラスは窓の機能なので、本体（main）が窓に当てる。

export interface BackgroundHost {
  get(): Promise<{ appearance: Appearance; platform: string; wallpaper: number }>;
  /** 壁紙の版（なければ 0）を聞き、窓の位置も知らせてもらう。 */
  wallpaper(): Promise<number>;
  set(a: Appearance): Promise<Appearance>;
  choose(kind: "image" | "video"): Promise<{ file: string; label: string } | { error: string } | undefined>;
}

/** 背景の層を作り、見た目を当てる。 */
export class Backdrop {
  private readonly layer = document.createElement("div");
  private media: HTMLElement | null = null;
  private shownFile: string | null = null;
  private geometry: WindowGeometry | null = null;
  private wallpaperVersion = 0;
  private current: Appearance | null = null;

  constructor() {
    this.layer.id = "app-backdrop";
    this.layer.setAttribute("aria-hidden", "true");
    document.body.prepend(this.layer);
    // 窓を隠している間は動画を止める（電力を食わないように）。
    document.addEventListener("visibilitychange", () => {
      const v = this.media instanceof HTMLVideoElement ? this.media : null;
      if (!v) return;
      if (document.hidden) v.pause();
      else void v.play().catch(() => {});
    });
  }

  /** 窓が動いたとき：壁紙を、ディスプレイの上の位置に合わせてずらす（窓の後ろの壁紙が見えているように）。 */
  setGeometry(g: WindowGeometry) {
    this.geometry = g;
    this.placeWallpaper();
  }

  /** 壁紙が変わったとき（窓に戻ってきたときに知らされる）。 */
  setWallpaper(version: number) {
    if (version === this.wallpaperVersion) return;
    this.wallpaperVersion = version;
    if (this.current?.kind === "wallpaper") {
      this.shownFile = null;
      this.apply(this.current);
    }
  }

  private placeWallpaper() {
    const g = this.geometry;
    if (!g || !this.media?.classList.contains("bg-wallpaper")) return;
    Object.assign(this.media.style, { left: `${-g.x}px`, top: `${-g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
  }

  apply(a: Appearance) {
    this.current = a;
    const root = document.documentElement;
    const on = a.kind !== "none";
    root.classList.toggle("bg-on", on);
    root.classList.toggle("bg-glass", a.kind === "glass");
    root.style.setProperty("--glass-alpha", `${a.panelOpacity}%`);
    root.style.setProperty("--glass-blur", `${a.blur}px`);
    root.style.setProperty("--bg-dim", String(a.dim / 100));
    this.layer.hidden = !on;

    const want =
      a.kind === "image" || a.kind === "video" ? `${a.kind}:${a.file}` : a.kind === "wallpaper" ? `wallpaper:${this.wallpaperVersion}` : null;
    if (want !== this.shownFile) {
      this.media?.remove();
      this.media = null;
      this.shownFile = want;
      if (a.kind === "video" && a.file) {
        const v = document.createElement("video");
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        v.src = backgroundUrl(a.file);
        v.addEventListener("error", () => console.warn("背景の動画を読めません"));
        this.media = v;
      } else if (a.kind === "image" && a.file) {
        const d = document.createElement("div");
        d.className = "bg-image";
        d.style.backgroundImage = `url("${backgroundUrl(a.file)}")`;
        this.media = d;
      } else if (a.kind === "wallpaper") {
        // マイカと同じ考え方：デスクトップの壁紙を窓の位置に合わせて敷き、強くぼかす。
        const d = document.createElement("div");
        d.className = "bg-wallpaper";
        if (this.wallpaperVersion) d.style.backgroundImage = `url("${wallpaperUrl(this.wallpaperVersion)}")`;
        this.media = d;
      }
      if (this.media) this.layer.prepend(this.media);
      this.placeWallpaper();
    }
    if (this.media) {
      this.media.dataset.fit = a.fit;
      if (this.media instanceof HTMLVideoElement) this.media.style.objectFit = a.fit === "contain" ? "contain" : "cover";
    }
  }
}

const KINDS: [BackgroundKind, string][] = [
  ["none", "なし（いつもの地の色）"],
  ["image", "画像"],
  ["video", "動画（音なしでくり返す）"],
  ["wallpaper", "壁紙のすりガラス（デスクトップの壁紙がぼけて透けて見える）"],
  ["glass", "Windows のすりガラス（後ろの窓が透ける。PC によっては単色になる）"],
];

/** 「表示 > 背景…」の画面。変えるとその場で当てて、保存する。 */
export class BackgroundDialog {
  private readonly dialog = document.createElement("dialog");
  private a: Appearance = normalizeAppearance({});
  private platform = "";

  constructor(
    private readonly host: BackgroundHost,
    private readonly backdrop: Backdrop,
  ) {
    this.dialog.className = "bg-dialog";
    this.dialog.setAttribute("aria-label", "背景");
    document.body.append(this.dialog);
  }

  /** 起動したときに、保存してある見た目を当てる。 */
  async load() {
    const r = await this.host.get();
    this.a = r.appearance;
    this.platform = r.platform;
    this.backdrop.setWallpaper(r.wallpaper);
    this.backdrop.apply(this.a);
    // 窓の位置を知らせてもらう（壁紙の位置合わせ）。
    void this.host.wallpaper();
  }

  open() {
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async update(change: Partial<Appearance>) {
    this.a = normalizeAppearance({ ...this.a, ...change });
    this.backdrop.apply(this.a);
    this.render();
    this.a = await this.host.set(this.a);
  }

  private async chooseFile(kind: "image" | "video") {
    const r = await this.host.choose(kind);
    if (!r) return;
    if ("error" in r) {
      alert(r.error);
      return;
    }
    await this.update({ kind, file: r.file, fileLabel: r.label });
  }

  private render() {
    const a = this.a;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
      const e = Object.assign(document.createElement(tag), props);
      e.append(...kids);
      return e;
    };
    const field = (label: string, control: HTMLElement, hint?: string) =>
      el("label", { className: "field" }, el("span", {}, label), control, ...(hint ? [el("span", { className: "hint" }, hint)] : []));
    const slider = (key: "panelOpacity" | "blur" | "dim", min: number, max: number, unit: string) => {
      const input = el("input", { type: "range", min: String(min), max: String(max), value: String(a[key]) });
      const out = el("output", {}, `${a[key]}${unit}`);
      input.addEventListener("input", () => {
        out.textContent = `${input.value}${unit}`;
        this.a = normalizeAppearance({ ...this.a, [key]: Number(input.value) });
        this.backdrop.apply(this.a);
      });
      input.addEventListener("change", () => void this.host.set(this.a));
      return el("div", { className: "row" }, input, out);
    };

    const kind = el("select");
    // 壁紙のすりガラスは Windows だけ（Mac は「すりガラス」で vibrancy を使う）。
    const kinds = KINDS.filter(([v]) => v !== "wallpaper" || this.platform === "win32");
    for (const [v, label] of kinds) kind.append(el("option", { value: v, selected: v === a.kind }, label));
    kind.addEventListener("change", () => {
      const k = kind.value as BackgroundKind;
      // 画像・動画は、まだ選んでいなければファイルを選ぶ。
      if ((k === "image" || k === "video") && !(a.file && a.file.startsWith(`${k}-`))) void this.chooseFile(k).then(() => this.render());
      else void this.update({ kind: k });
    });

    const body: HTMLElement[] = [field("背景", kind)];
    if (a.kind === "image" || a.kind === "video") {
      const pick = el("button", { type: "button" }, a.kind === "video" ? "動画を選ぶ…" : "画像を選ぶ…");
      pick.addEventListener("click", () => void this.chooseFile(a.kind as "image" | "video"));
      body.push(el("div", { className: "row" }, pick, el("span", { className: "computed" }, a.fileLabel || "（未選択）")));
      const fit = el("select");
      for (const [v, label] of [["cover", "窓いっぱい（はみ出た所は切る）"], ["contain", "全体を見せる"], ...(a.kind === "image" ? [["tile", "並べる（タイル）"]] : [])])
        fit.append(el("option", { value: v, selected: v === a.fit }, label));
      fit.addEventListener("change", () => void this.update({ fit: fit.value as Appearance["fit"] }));
      body.push(field("置き方", fit));
    }
    if (a.kind === "wallpaper") {
      body.push(el("p", { className: "hint" }, "今のデスクトップの壁紙を、窓の位置に合わせてぼかして敷きます。窓を動かすと、壁紙も一緒にずれて、窓の後ろが透けて見えるようになります。壁紙を変えたら、Kolophon の窓に戻ったときに読み直します。"));
    }
    if (a.kind === "glass") {
      if (this.platform === "win32") {
        const mat = el("select");
        for (const [v, label] of [["acrylic", "アクリル（強くぼかす。後ろの窓が透ける）"], ["mica", "マイカ（壁紙の色をうっすら）"], ["tabbed", "タブ付きマイカ（マイカより濃い）"]])
          mat.append(el("option", { value: v, selected: v === a.material }, label));
        mat.addEventListener("change", () => void this.update({ material: mat.value as Appearance["material"] }));
        body.push(field("ガラスの種類", mat, "Windows 11 の機能です。Windows 10 や、グラフィックの環境によっては透けずに単色になります。そのときは「壁紙のすりガラス」を使ってください。窓を選んでいないときも単色になります。"));
      } else if (this.platform === "darwin") {
        body.push(el("p", { className: "hint" }, "Mac のすりガラス（vibrancy）を使います。"));
      } else {
        body.push(el("p", { className: "hint" }, "この OS では、すりガラスを使えないことがあります。"));
      }
    }
    if (a.kind !== "none") {
      body.push(
        field("背景を地の色で薄める", slider("dim", 0, 90, "%"), "0% で背景そのまま。字が読みにくいときは上げてください。"),
        field("欄の濃さ", slider("panelOpacity", 20, 100, "%"), "ツールバー・原稿・設定の欄。100% で不透明。"),
        field("欄の後ろのぼかし", slider("blur", 0, 40, "px")),
      );
    }
    body.push(el("p", { className: "hint" }, "紙面はいつも不透明のままです（色や字の見え方は変わりません）。この設定は文書ではなく、この PC の Kolophon に保存します。"));

    const close = el("button", { type: "button", className: "primary" }, "閉じる");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog.replaceChildren(el("h2", {}, "背景"), el("div", { className: "fields" }, ...body), el("menu", {}, close));
  }
}
