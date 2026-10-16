// https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute
const space = /[\t\n\f\r ]/;
// A strict end assertion: `$` also matches before a final Unicode line separator.
const integer = /^[0-9]+(?![\s\S])/;
const floating = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?(?![\s\S])/;

/** Return URLs of valid candidates; selection by viewport/density happens later. */
export function srcsetUrls(input: string): string[] {
  const urls: string[] = [];
  let position = 0;
  while (position < input.length) {
    while (position < input.length && /[\t\n\f\r ,]/.test(input[position])) position++;
    if (position === input.length) break;
    const start = position;
    while (position < input.length && !space.test(input[position])) position++;
    let url = input.slice(start, position);
    const descriptors: string[] = [];
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      while (position < input.length && space.test(input[position])) position++;
      let descriptor = "";
      let state: "descriptor" | "parens" | "after" = "descriptor";
      while (true) {
        const c = input[position];
        if (c === undefined || (state !== "parens" && c === ",")) {
          if (descriptor) descriptors.push(descriptor);
          if (c === ",") position++;
          break;
        }
        if (state === "parens") {
          descriptor += c;
          if (c === ")") state = "descriptor";
        } else if (space.test(c)) {
          if (descriptor) descriptors.push(descriptor);
          descriptor = "";
          state = "after";
        } else {
          descriptor += c;
          state = c === "(" ? "parens" : "descriptor";
        }
        position++;
      }
    }
    let width = false;
    let density = false;
    let height = false;
    let error = false;
    for (const descriptor of descriptors) {
      const value = descriptor.slice(0, -1);
      const suffix = descriptor.at(-1);
      if (suffix === "w" && integer.test(value)) {
        if (width || density || Number(value) === 0) error = true;
        width = true;
      } else if (suffix === "x" && floating.test(value)) {
        if (width || density || height || Number(value) < 0 || !Number.isFinite(Number(value))) error = true;
        density = true;
      } else if (suffix === "h" && integer.test(value)) {
        if (height || density || Number(value) === 0) error = true;
        height = true;
      } else error = true;
    }
    if (height && !width) error = true;
    if (!error) urls.push(url);
  }
  return urls;
}
