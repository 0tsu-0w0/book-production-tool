import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_APPEARANCE, backgroundUrl, normalizeAppearance, wallpaperUrl, wantsTransparentWindow } from "../appearance.js";

describe("窓の背景（見た目の設定）", () => {
  it("保存がなければ既定（背景なし）", () => {
    assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
    assert.equal(normalizeAppearance("壊れた値").kind, "none");
  });

  it("画像・動画なのにファイルがなければ、背景なしにする", () => {
    assert.equal(normalizeAppearance({ kind: "image" }).kind, "none");
    assert.equal(normalizeAppearance({ kind: "video", file: "video-1.webm" }).kind, "video");
    assert.equal(normalizeAppearance({ kind: "wallpaper" }).kind, "wallpaper");
  });

  it("フォルダをまたぐファイル名は受け付けない（設定のフォルダの外を読ませない）", () => {
    assert.equal(normalizeAppearance({ kind: "image", file: "../secret.png" }).file, null);
    assert.equal(normalizeAppearance({ kind: "image", file: "..\\a.png" }).kind, "none");
  });

  it("数値は範囲に収め、知らない値は既定に戻す", () => {
    const a = normalizeAppearance({ kind: "glass", material: "金属", fit: "x", panelOpacity: 5, blur: 99, dim: -3 });
    assert.equal(a.material, "acrylic");
    assert.equal(a.fit, "cover");
    assert.equal(a.panelOpacity, 20);
    assert.equal(a.blur, 40);
    assert.equal(a.dim, 0);
  });

  it("画面で読む URL", () => {
    assert.equal(backgroundUrl("image-1.jpg"), "kolophon-bg://media/image-1.jpg");
    assert.equal(wallpaperUrl(12), "kolophon-bg://wallpaper/current?v=12");
  });

  it("完全な透明だけが、窓の地を塗らない", () => {
    assert.equal(wantsTransparentWindow(normalizeAppearance({ kind: "transparent" })), true);
    for (const kind of ["none", "image", "wallpaper", "glass"]) assert.equal(wantsTransparentWindow(normalizeAppearance({ kind, file: "image-1.png" })), false);
  });

  it("後ろの窓のすりガラス：種類として保存でき、背景のぼかしは範囲に収める", () => {
    const a = normalizeAppearance({ kind: "behind", backBlur: 200 });
    assert.equal(a.kind, "behind");
    assert.equal(a.backBlur, 80);
    assert.equal(normalizeAppearance({}).backBlur, 40);
    assert.equal(wantsTransparentWindow(a), false);
  });
});
