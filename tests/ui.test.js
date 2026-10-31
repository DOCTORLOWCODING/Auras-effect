import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

test("all required JavaScript UI ids exist in index.html", () => {
  const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const jsIds = new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]));
  assert.deepEqual([...jsIds].filter((id) => !htmlIds.has(id)), []);
});

test("demonstration preview is completely removed from the extension", () => {
  assert.doesNotMatch(html, /<canvas|preview-section|id="preview"/);
  assert.doesNotMatch(js, /startPreview|updatePreview|preview\.js/);
  assert.doesNotMatch(css, /\.preview-section|\.preview \{/);
  assert.equal(fs.existsSync(new URL("../src/preview.js", import.meta.url)), false);
});

test("all requested effect controls exist", () => {
  for (const effect of ["spirits", "electric", "lens", "glow", "shield", "touch", "fog"]) {
    assert.match(html, new RegExp(`<option value="${effect}">`));
  }
  assert.match(html, /id="light-wrap"/);
  assert.match(html, /id="light"/);
});

test("multiple aura management controls exist", () => {
  for (const id of ["apply", "save-edit", "cancel-edit", "auras-list", "remove", "refresh-auras"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /Добавить ауру/);
  assert.match(js, /Сохранить изменения/);
  assert.match(html, /Удалить все ауры/);
  assert.match(js, /Удалить эту ауру/);
});

test("selection changes refresh the aura list without blocking form controls", () => {
  assert.match(js, /window\.setInterval\(\(\) => \{ void pollSelection\(\); \}, 850\)/);
  assert.match(js, /OBR\.scene\.items\.onChange\(\(items\) => \{/);
  assert.match(js, /handleSceneItemsChanged\(items\)/);
  assert.match(js, /OBR\.scene\.local\.onChange\(\(items\) => \{/);
  assert.match(js, /handleLocalItemsChanged\(items\)/);
  assert.doesNotMatch(js, /querySelectorAll\(["']\.segment, #effect, #radius, #opacity, #color, #speed/);
});

test("rendering the aura list uses DOM text nodes, not HTML injection", () => {
  assert.match(js, /document\.createElement\("div"\)/);
  assert.match(js, /title\.textContent = getAuraLabel/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("radius remains integer-only with explicit increment controls", () => {
  assert.match(html, /id="radius"[^>]*min="1"[^>]*max="20"[^>]*step="1"/);
  assert.match(js, /changeRadius\(-1\)/);
  assert.match(js, /changeRadius\(1\)/);
});

test("no README or description text is shipped", () => {
  assert.doesNotMatch(html, /<meta[^>]+name="description"/);
  assert.doesNotMatch(html, /<p[^>]*>[^<]{20,}<\/p>/);
});
