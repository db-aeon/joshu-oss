import type { VideoElement, VideoSource } from "@/editor/types";

/** Creatomate rejects composition.fonts entries without a font file URL in `source`. */
export function sanitizeSourceForCreatomate(source: VideoSource): VideoSource {
  const fonts = (source.fonts ?? []).filter(
    (f) => typeof f.source === "string" && f.source.trim().length > 0,
  );
  if (fonts.length === (source.fonts ?? []).length) return source;
  const next = { ...source };
  if (fonts.length > 0) {
    next.fonts = fonts;
  } else {
    delete next.fonts;
  }
  return next;
}

export function sanitizeElements(elements: VideoElement[]): VideoElement[] {
  return elements.map((el) => ({
    ...el,
    blend_mode: el.blend_mode === "normal" || !el.blend_mode ? "none" : el.blend_mode,
    elements: el.elements ? sanitizeElements(el.elements) : undefined,
  }));
}

export function collectTextFontFamilies(
  elements: VideoElement[] | undefined,
  out = new Set<string>(),
): Set<string> {
  if (!elements) return out;
  for (const el of elements) {
    if (el.type === "text" && typeof el.font_family === "string" && el.font_family.trim()) {
      out.add(el.font_family.trim());
    }
    if (el.elements) collectTextFontFamilies(el.elements, out);
  }
  return out;
}

/** Load Google Fonts CSS for text layers (preview only; not sent to Creatomate fonts array). */
export function ensureGoogleFontStyles(families: Iterable<string>): void {
  for (const family of families) {
    const id = `jmovie-font-${family.replace(/\s+/g, "-").toLowerCase()}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700&display=swap`;
    document.head.appendChild(link);
  }
}

export function prepareSourceForPreview(source: VideoSource): VideoSource {
  const elements = source.elements ? sanitizeElements(source.elements) : [];
  const families = collectTextFontFamilies(elements);
  ensureGoogleFontStyles(families);
  return sanitizeSourceForCreatomate({ ...source, elements });
}
