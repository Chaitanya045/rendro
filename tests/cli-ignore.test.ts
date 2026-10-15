import { expect, it } from "vitest";
import { createIgnoreMatcher } from "../cli/src/ignore";

it.each([
  ["", "anything", false, false], [" \r\n# comment\n!\n/\n!/", "anything", false, false],
  [" draft.txt \r\n", "draft.txt", false, true], ["draft.txt", "nested/draft.txt", false, true],
  ["draft.txt", "nested/draft.txt.bak", false, false], ["draft.txt", "mydraft.txt", false, false],
  ["/draft.txt", "draft.txt", false, true], ["/draft.txt", "nested/draft.txt", false, false],
  ["assets/*.map", "assets/site.js.map", false, true], ["assets/*.map", "nested/assets/site.map", false, false],
  ["assets/*.map", "assets/nested/site.map", false, false],
  ["*.map", "assets/nested/site.map", false, true],
  ["page?.html", "page1.html", false, true], ["page?.html", "page10.html", false, false],
  ["page?.html", "page/.html", false, false],
  ["cache/", "cache", true, true], ["cache/", "cache", false, false],
  ["cache/", "nested/cache", true, true], ["/cache/", "nested/cache", true, false],
  ["cache", "cache", true, true],
  ["**/draft.*", "draft.txt", false, true], ["**/draft.*", "one/two/draft.txt", false, true],
  ["docs/**/draft.*", "docs/draft.txt", false, true], ["docs/**/draft.*", "docs/a/b/draft.txt", false, true],
  ["docs/**", "docs/a/b.txt", false, true], ["docs/**", "docs", true, false],
  ["**", "anything/nested", false, true],
  ["*.txt\n!keep.txt", "keep.txt", false, false], ["*.txt\n!keep.txt\nkeep.*", "keep.txt", false, true],
  ["*.txt\n!/keep.txt", "nested/keep.txt", false, true],
  ["\\#draft", "#draft", false, true], ["\\!draft", "!draft", false, true],
  ["a[1]+(x){y}^$.txt", "a[1]+(x){y}^$.txt", false, true],
  ["a[1].txt", "a1.txt", false, false], ["Foo", "foo", false, false],
])("matches %j against %j (directory=%s)", (pattern, path, directory, expected) => {
  expect(createIgnoreMatcher(pattern)(path, directory)).toBe(expected);
});
