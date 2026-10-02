import { backgroundUrl, normalizeAppearance, wallpaperUrl, wantsTransparentWindow, type Appearance, type BackgroundKind, type WindowGeometry } from "../appearance.js";

// 窓の背景（画像・動画・すりガラス）。背景の層を画面のいちばん後ろに置き、ツールバー・原稿・設定の欄を半透明にする。
// 紙面（canvas）はいつも不透明。すりガラスは窓の機能なので、本体（main）が窓に当てる。

export interface BackgroundHost {
  get(): Promise<{ appearance: Appearance; platform: string; wallpaper: number; transparentWindow: boolean }>;
  /** アプリを起動し直す（完全な透明の切り替え）。 */
  relaunch(): Promise<void>;
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
      // 後ろの窓のすりガラスは、隠している間は画面の取り込みも止める。
      if (this.current?.kind === "behind") {
        if (document.hidden) this.stopCapture();
        else this.startCapture();
        return;
      }
      const v = this.media instanceof HTMLVideoElement ? this.media : null;
      if (!v) return;
      if (document.hidden) v.pause();
      else void v.play().catch(() => {});
    });
  }

  /** 窓が動いたとき：壁紙を、ディスプレイの上の位置に合わせてずらす（窓の後ろの壁紙が見えているように）。 */
  setGeometry(g: WindowGeometry) {
    const moved = this.geometry?.display !== g.display;
    this.geometry = g;
    this.placeWallpaper();
    // 別のディスプレイへ移ったら、そのディスプレイを取り込み直す。
    if (moved && this.current?.kind === "behind" && this.capture) {
      this.stopCapture();
      this.startCapture();
    }
  }

  private capture: MediaStream | null = null;
  private capturing = false;

  /** 後ろの窓のすりガラス：窓のあるディスプレイを取り込み、背景の動画にする（1秒に15回まで）。 */
  private startCapture() {
    const v = this.media instanceof HTMLVideoElement && this.media.classList.contains("bg-wallpaper") ? this.media : null;
    if (!v || this.capture || this.capturing || document.hidden) return;
    this.capturing = true;
    navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: { max: 15 } }, audio: false })
      .then((stream) => {
        this.capturing = false;
        if (this.current?.kind !== "behind" || this.media !== v) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        this.capture = stream;
        v.srcObject = stream;
        void v.play().catch(() => {});
      })
      .catch((e) => {
        this.capturing = false;
        console.warn(`画面を取り込めません：${String(e)}`);
      });
  }

  private stopCapture() {
    for (const t of this.capture?.getTracks() ?? []) t.stop();
    this.capture = null;
    if (this.media instanceof HTMLVideoElement) this.media.srcObject = null;
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
    root.style.setProperty("--back-blur", `${a.backBlur}px`);
    this.layer.hidden = !on;

    const want =
      a.kind === "image" || a.kind === "video"
        ? `${a.kind}:${a.file}`
        : a.kind === "wallpaper"
          ? `wallpaper:${this.wallpaperVersion}`
          : a.kind === "behind"
            ? "behind"
            : null;
    if (want !== this.shownFile) {
      this.stopCapture();
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
      } else if (a.kind === "behind") {
        // 壁紙のすりガラスと同じ置き方で、取り込んだ画面（後ろの窓）を敷く。
        const v = document.createElement("video");
        v.className = "bg-wallpaper";
        v.muted = true;
        v.autoplay = true;
        v.playsInline = true;
        this.media = v;
      }
      if (this.media) this.layer.prepend(this.media);
      this.placeWallpaper();
      if (a.kind === "behind") this.startCapture();
    }
    if (this.media) {
      this.media.dataset.fit = a.fit;
      if (this.media instanceof HTMLVideoElement && a.kind === "video") this.media.style.objectFit = a.fit === "contain" ? "contain" : "cover";
    }
  }
}

const KINDS: [BackgroundKind, string][] = [
  ["none", "なし（いつもの地の色）"],
  ["image", "画像"],
  ["video", "動画（音なしでくり返す）"],
  ["wallpaper", "壁紙のすりガラス（デスクトップの壁紙がぼけて透けて見える）"],
  ["behind", "後ろの窓のすりガラス（後ろの窓やタブがぼけて透けて見える）"],
  ["glass", "Windows のすりガラス（後ろの窓が透ける。PC によっては単色になる）"],
  ["transparent", "完全な透明（後ろの窓やデスクトップがくっきり見える。再起動して切り替え）"],
];

/** 「表示 > 背景…」の画面。変えるとその場で当てて、保存する。 */
export class BackgroundDialog {
  private readonly dialog = document.createElement("dialog");
  private a: Appearance = normalizeAppearance({});
  private platform = "";
  /** 今の窓が透明な窓として作られているか（起動したときに決まる）。 */
  private transparentWindow = false;
  /** 「画像」「動画」を選んだが、まだファイルを選んでいない（選ぶまでは今の背景のまま）。 */
  private pending: "image" | "video" | null = null;

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
    this.transparentWindow = r.transparentWindow;
    this.backdrop.setWallpaper(r.wallpaper);
    this.backdrop.apply(this.a);
    // 窓の位置を知らせてもらう（壁紙の位置合わせ）。
    void this.host.wallpaper();
  }

  open() {
    this.pending = null;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async update(change: Partial<Appearance>) {
    if ("kind" in change) this.pending = null;
    this.a = normalizeAppearance({ ...this.a, ...change });
    this.render();
    // 先に保存してから当てる（後ろの窓のすりガラスは、保存した設定を見て本体が画面の取り込みを許すため）。
    this.a = await this.host.set(this.a);
    this.backdrop.apply(this.a);
    if ("kind" in change) this.offerRelaunch();
  }

  /** 完全な透明に切り替える・やめるときは、起動し直すかを聞く。 */
  private offerRelaunch() {
    if (wantsTransparentWindow(this.a) === this.transparentWindow) return;
    const what = wantsTransparentWindow(this.a) ? "完全な透明にする" : "完全な透明をやめる";
    const msg = `${what}には、Kolophon を起動し直します。今すぐ起動し直しますか？\n（保存していない変更があれば、先に聞きます）`;
    if (confirm(msg)) void this.host.relaunch();
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
    // 画面に出す種類（ファイルを選ぶのを待っている画像・動画なら、そちら）。
    const shown: BackgroundKind = this.pending ?? a.kind;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
      const e = Object.assign(document.createElement(tag), props);
      e.append(...kids);
      return e;
    };
    const field = (label: string, control: HTMLElement, hint?: string) =>
      el("label", { className: "field" }, el("span", {}, label), control, ...(hint ? [el("span", { className: "hint" }, hint)] : []));
    const slider = (key: "panelOpacity" | "blur" | "dim" | "backBlur", min: number, max: number, unit: string) => {
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
    for (const [v, label] of kinds) kind.append(el("option", { value: v, selected: v === shown }, label));
    kind.addEventListener("change", () => {
      const k = kind.value as BackgroundKind;
      // 画像・動画は、まだ選んでいなければファイルを選ぶ。選ばずに閉じても「画像」「動画」のまま、選ぶボタンを出しておく。
      if ((k === "image" || k === "video") && !(a.file && a.file.startsWith(`${k}-`))) {
        this.pending = k;
        this.render();
        void this.chooseFile(k);
      }
      // 完全な透明では後ろの窓の字がくっきり透けるので、欄は濃いめから始める（あとで薄くできる）。
      else if (k === "transparent") void this.update({ kind: k, panelOpacity: Math.max(this.a.panelOpacity, 92) });
      else void this.update({ kind: k });
    });

    const body: HTMLElement[] = [field("背景", kind)];
    if (this.pending) {
      const k = this.pending;
      const pick = el("button", { type: "button", className: "primary" }, k === "video" ? "動画を選ぶ…" : "画像を選ぶ…");
      pick.addEventListener("click", () => void this.chooseFile(k));
      body.push(el("div", { className: "row" }, pick, el("span", { className: "computed" }, "（未選択。選ぶまでは今の背景のままです）")));
    } else if (a.kind === "image" || a.kind === "video") {
      const pick = el("button", { type: "button" }, a.kind === "video" ? "動画を選ぶ…" : "画像を選ぶ…");
      pick.addEventListener("click", () => void this.chooseFile(a.kind as "image" | "video"));
      body.push(el("div", { className: "row" }, pick, el("span", { className: "computed" }, a.fileLabel || "（未選択）")));
      const fit = el("select");
      for (const [v, label] of [["cover", "窓いっぱい（はみ出た所は切る）"], ["contain", "全体を見せる"], ...(a.kind === "image" ? [["tile", "並べる（タイル）"]] : [])])
        fit.append(el("option", { value: v, selected: v === a.fit }, label));
      fit.addEventListener("change", () => void this.update({ fit: fit.value as Appearance["fit"] }));
      body.push(field("置き方", fit));
    }
    if (!this.pending && a.kind === "behind") {
      body.push(
        el(
          "p",
          { className: "hint" },
          "窓の後ろにある画面（ほかの窓・ブラウザのタブ・ターミナルなど）を取り込み、窓の位置に合わせてぼかして敷きます。後ろの窓が動けば、背景も動きます。この背景の間は、Kolophon の窓がスクリーンショットや画面共有に写りません（取り込みから Kolophon 自身を外すため）。窓を最小化している間は取り込みを止めます。",
        ),
      );
    }
    if (!this.pending && a.kind === "wallpaper") {
      body.push(el("p", { className: "hint" }, "今のデスクトップの壁紙を、窓の位置に合わせてぼかして敷きます。窓を動かすと、壁紙も一緒にずれて、窓の後ろが透けて見えるようになります。壁紙を変えたら、Kolophon の窓に戻ったときに読み直します。"));
    }
    if (!this.pending && a.kind === "transparent") {
      body.push(el("p", { className: "hint" }, "窓そのものを透明にし、後ろの窓（ターミナルなど）やデスクトップをそのまま見せます。透けるのは見えるだけで、クリックは Kolophon に届きます。Windows では窓の枠の代わりに、上に題名の欄（メニュー・最小化・最大化・閉じる）を出します。欄をつかむと窓が動き、ダブルクリックで最大化します。Alt キーでもメニューが開きます。"));
    }
    if (wantsTransparentWindow(a) !== this.transparentWindow) {
      const restart = el("button", { type: "button", className: "primary" }, "今すぐ起動し直す");
      restart.addEventListener("click", () => void this.host.relaunch());
      body.push(el("div", { className: "warning row" }, el("span", {}, wantsTransparentWindow(a) ? "完全な透明は、起動し直すと始まります。" : "完全な透明は、起動し直すと終わります。"), restart));
    }
    if (!this.pending && a.kind === "glass") {
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
    if (a.kind !== "none" && !this.pending) {
      if (a.kind === "wallpaper" || a.kind === "behind") body.push(field("背景のぼかし", slider("backBlur", 0, 80, "px"), "0px でくっきり。"));
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
