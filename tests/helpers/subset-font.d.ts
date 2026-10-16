// subset-font 2.9 ships no types and @types/subset-font predates keepAllGlyphs.
declare module "subset-font" {
  export interface SubsetFontOptions {
    targetFormat?: "sfnt" | "woff" | "woff2";
    preserveNameIds?: number[];
    variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
    keepAllGlyphs?: boolean;
    noLayoutClosure?: boolean;
  }
  export default function subsetFont(font: Uint8Array, text: string | null, options?: SubsetFontOptions): Promise<Uint8Array>;
}
