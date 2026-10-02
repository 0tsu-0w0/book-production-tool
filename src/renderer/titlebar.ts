// 完全な透明のとき、Windows の枠の代わりに出す題名の欄。メニュー（ファイル・編集・表示）・最小化・最大化・閉じる。
// 欄をつかむと窓が動き、ダブルクリックで最大化する（Electron の drag 領域）。

export interface TitlebarHost {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): void;
  popupMenu(x: number, y: number): Promise<void>;
  onTitle(fn: (t: string) => void): void;
  onMaximized(fn: (m: boolean) => void): void;
}

export function setupTitlebar(host: TitlebarHost, maximized: boolean) {
  const $ = (id: string) => document.getElementById(id)!;
  document.documentElement.classList.add("frameless");
  $("titlebar").hidden = false;
  const max = $("tb-max");
  const setMax = (m: boolean) => {
    // Segoe Fluent Icons：最大化 E922、元に戻す E923。
    max.textContent = m ? "" : "";
    max.title = max.ariaLabel = m ? "元のサイズに戻す" : "最大化";
  };
  setMax(maximized);
  host.onMaximized(setMax);
  host.onTitle((t) => {
    $("tb-title").textContent = t;
    document.title = t;
  });
  $("tb-menu").addEventListener("click", (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void host.popupMenu(r.left, r.bottom);
  });
  $("tb-min").addEventListener("click", () => void host.minimize());
  max.addEventListener("click", () => void host.toggleMaximize());
  $("tb-close").addEventListener("click", () => host.close());
  // Alt キーだけを押したら、メニューを開く（枠のある窓と同じ使い勝手に）。
  let altOnly = false;
  window.addEventListener("keydown", (e) => (altOnly = e.key === "Alt"));
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && altOnly) {
      const r = $("tb-menu").getBoundingClientRect();
      void host.popupMenu(r.left, r.bottom);
    }
    altOnly = false;
  });
}
