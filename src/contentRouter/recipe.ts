/**
 * Shape recipes (change content-router, design decision D4). A shape recipe turns the reply of one
 * provider endpoint into items: a JSON path to the list of results, and a JSON path for each item
 * field. A recipe is data, not code: the box applies it with the small path reader below, and the
 * model never writes code that the box runs.
 *
 * Path syntax: names and list positions joined by dots, for example `data.items` or
 * `markets.0.outcomePrices.0`. An empty path is the value itself. When a path step meets a string
 * that holds JSON (Polymarket sends `"[\"0.42\",\"0.58\"]"`), the reader parses the string. A field
 * can also be a template with paths in braces, for example `https://www.reddit.com{permalink}`, or
 * a list of fields, where the first one with a value wins.
 */

export type FieldSpec = string | string[];

export type DateFormat = "iso" | "epoch_s" | "epoch_ms" | "text";

export type ShapeRecipe = {
  /** Path to the list of results in the reply. */
  list: string;
  url: FieldSpec;
  title: FieldSpec;
  text?: FieldSpec;
  author?: FieldSpec;
  publishedAt?: { path: FieldSpec; format: DateFormat };
  /** A metric name, for example `views`, `likes`, `comments`, `odds`, or `volume`, to a path or a list of paths. */
  metrics?: Record<string, FieldSpec>;
};

/** One item of a reply after a recipe. */
export type RecipeItem = {
  url: string;
  title: string;
  text: string;
  author: string;
  /** `YYYY-MM-DD` (UTC), or undefined when the item has no date. */
  publishedAt?: string;
  metrics: Record<string, number>;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Some providers send text with HTML entities (`&quot;`); the report escapes text itself. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function parseJsonString(value: string): unknown {
  const t = value.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** The value at `path` in `value`, or undefined. */
export function readPath(value: unknown, path: string): unknown {
  const steps = path.trim() ? path.trim().split(".") : [];
  let cur: unknown = value;
  for (const step of steps) {
    if (typeof cur === "string") cur = parseJsonString(cur);
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(step)) return undefined;
      cur = cur[Number(step)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[step];
    } else {
      return undefined;
    }
  }
  return cur;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** The text of one field spec on one item: a path, a template, or the first of a list that has a value. */
export function readField(item: unknown, spec: FieldSpec | undefined): string {
  if (spec === undefined) return "";
  if (Array.isArray(spec)) {
    for (const one of spec) {
      const v = readField(item, one);
      if (v) return v;
    }
    return "";
  }
  if (spec.includes("{")) {
    let missing = false;
    const out = spec.replace(/\{([^}]*)\}/g, (_m, p: string) => {
      const v = scalarText(readPath(item, p)).trim();
      if (!v) missing = true;
      return v;
    });
    return missing ? "" : out;
  }
  return scalarText(readPath(item, spec)).trim();
}

function rawField(item: unknown, spec: FieldSpec): unknown {
  if (Array.isArray(spec)) {
    for (const one of spec) {
      const v = rawField(item, one);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  }
  return readPath(item, spec);
}

function clean(text: string, max: number): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, max);
}

/** `YYYY-MM-DD` (UTC) from a date in `format`, or undefined. `text` also reads the X form `Mon Oct 26 10:16:50 +0000 2026`. */
export function dayOf(value: unknown, format: DateFormat = "text"): string | undefined {
  let d: Date | null = null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (format === "epoch_s" && Number.isFinite(n)) d = new Date(n * 1000);
  else if (format === "epoch_ms" && Number.isFinite(n)) d = new Date(n);
  else if (typeof value === "string") {
    const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const x = value.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (\d{4})$/);
    d = x ? new Date(`${x[1]} ${x[2]}, ${x[5]} ${x[3]} GMT${x[4]}`) : format === "text" ? new Date(value) : null;
  } else if (Number.isFinite(n)) {
    // A number with format iso or text: seconds when it is small enough, else milliseconds.
    d = new Date(n < 1e11 ? n * 1000 : n);
  }
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
}

function metricValue(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The list of results of a reply, or an empty list when the path does not lead to a list. */
export function recipeList(reply: unknown, recipe: Pick<ShapeRecipe, "list">): unknown[] {
  const list = readPath(reply, recipe.list);
  return Array.isArray(list) ? list : [];
}

/** Apply a recipe to a reply. Items with no url and no title are left out. */
export function applyRecipe(reply: unknown, recipe: ShapeRecipe): RecipeItem[] {
  return recipeList(reply, recipe).flatMap((entry) => {
    const url = readField(entry, recipe.url);
    const title = clean(readField(entry, recipe.title), 300);
    if (!url && !title) return [];
    const metrics: Record<string, number> = {};
    for (const [name, path] of Object.entries(recipe.metrics ?? {})) {
      const v = metricValue(rawField(entry, path));
      if (v !== undefined) metrics[name] = v;
    }
    const published = recipe.publishedAt ? dayOf(rawField(entry, recipe.publishedAt.path), recipe.publishedAt.format) : undefined;
    return [
      {
        url,
        title,
        text: clean(readField(entry, recipe.text), 500),
        author: clean(readField(entry, recipe.author), 100).replace(/^@/, ""),
        ...(published ? { publishedAt: published } : {}),
        metrics,
      },
    ];
  });
}

/** The length of the longest list in a reply, up to three levels deep. Tells an empty reply from a recipe that misses. */
export function longestList(value: unknown, depth = 3): number {
  if (Array.isArray(value)) return Math.max(value.length, ...value.slice(0, 3).map((v) => (depth > 0 ? longestList(v, depth - 1) : 0)));
  if (!value || typeof value !== "object" || depth <= 0) return 0;
  return Math.max(0, ...Object.values(value as Record<string, unknown>).map((v) => longestList(v, depth - 1)));
}

const FORMATS: readonly DateFormat[] = ["iso", "epoch_s", "epoch_ms", "text"];

/** A JSON path of a recipe: names, list positions, and dots, at most 100 characters. */
export const RECIPE_PATH_PATTERN = /^[A-Za-z0-9_.\[\]]{1,100}$/;
/**
 * A link template: `https://`, a host, and URL characters, with paths in braces, at most 200
 * characters, for example `https://www.reddit.com{permalink}`.
 */
export const RECIPE_TEMPLATE_PATTERN = /^https:\/\/[A-Za-z0-9.-]{1,100}(?:[A-Za-z0-9_.~\/@?=&%-]|\{[A-Za-z0-9_.\[\]]{1,100}\})*$/;
const MAX_TEMPLATE_CHARS = 200;
/** The most paths in one field, and the most metrics of one recipe. */
const MAX_FIELD_PATHS = 4;
const MAX_METRICS = 10;

function checkOnePath(raw: unknown, allowTemplate: boolean): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (RECIPE_PATH_PATTERN.test(v)) return v;
  if (allowTemplate && v.length <= MAX_TEMPLATE_CHARS && v.includes("{") && RECIPE_TEMPLATE_PATTERN.test(v)) return v;
  return null;
}

/**
 * A field of a recipe: one path or a list of at most four paths. Only the link may use a template.
 * Null when the field is not given: no value, an empty string, or an empty list. A model often
 * writes `"author": []` for a provider whose items have no author (web search, news, markets).
 * "bad" when any part does not match the strict patterns, so the whole recipe is refused.
 */
function checkFieldSpec(raw: unknown, allowTemplate = false): FieldSpec | null | "bad" {
  if (raw === undefined || raw === null || raw === "") return null;
  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    if (raw.length > MAX_FIELD_PATHS) return "bad";
    const list = raw.map((v) => checkOnePath(v, allowTemplate));
    return list.every((v): v is string => v !== null) ? list : "bad";
  }
  return checkOnePath(raw, allowTemplate) ?? "bad";
}

/**
 * A recipe from JSON (a model answer or a file), or null when it is not a valid recipe. Each path
 * must match `RECIPE_PATH_PATTERN`, and only the link may be a template that matches
 * `RECIPE_TEMPLATE_PATTERN`. A recipe with any other value is refused, because the model wrote it
 * and the box keeps it in a skill folder.
 */
export function checkRecipe(raw: unknown): ShapeRecipe | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.list !== "string") return null;
  const list = o.list.trim();
  if (list && !RECIPE_PATH_PATTERN.test(list)) return null;
  const url = checkFieldSpec(o.url, true);
  const title = checkFieldSpec(o.title);
  if (!url || url === "bad" || !title || title === "bad") return null;
  const recipe: ShapeRecipe = { list, url, title };
  const text = checkFieldSpec(o.text);
  const author = checkFieldSpec(o.author);
  if (text === "bad" || author === "bad") return null;
  if (text) recipe.text = text;
  if (author) recipe.author = author;
  if (o.publishedAt !== undefined && o.publishedAt !== null) {
    const p = o.publishedAt as Record<string, unknown>;
    if (typeof p !== "object" || Array.isArray(p)) return null;
    const datePath = checkFieldSpec(p.path);
    if (datePath === "bad") return null;
    // A date with no path means the items have no date.
    if (datePath) {
      const format = FORMATS.includes(p.format as DateFormat) ? (p.format as DateFormat) : "text";
      recipe.publishedAt = { path: datePath, format };
    }
  }
  if (o.metrics !== undefined && o.metrics !== null) {
    if (typeof o.metrics !== "object" || Array.isArray(o.metrics)) return null;
    const entries = Object.entries(o.metrics as Record<string, unknown>);
    if (entries.length > MAX_METRICS) return null;
    const metrics: Record<string, FieldSpec> = {};
    for (const [name, path] of entries) {
      const spec = checkFieldSpec(path);
      if (!/^[a-z_]{1,30}$/.test(name) || spec === "bad") return null;
      // A metric with no path is left out.
      if (spec) metrics[name] = spec;
    }
    if (Object.keys(metrics).length) recipe.metrics = metrics;
  }
  return recipe;
}

export type RecipeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check the items of a recipe (risk 2 of design.md): each item has a url and a title, the links are
 * not one link repeated (a profile link instead of the post links), and no date is after tomorrow.
 * Items before the period are not a failure: the caller leaves them out.
 */
export function checkItems(items: RecipeItem[], today: string, recipe: ShapeRecipe): RecipeCheck {
  if (!items.length) return { ok: false, reason: "no items" };
  const complete = items.filter((i) => /^https?:\/\//.test(i.url) && i.title);
  if (complete.length < items.length) return { ok: false, reason: `${items.length - complete.length} of ${items.length} items have no link or no title` };
  const distinct = new Set(items.map((i) => i.url)).size;
  if (items.length >= 2 && distinct < Math.ceil(items.length / 2)) return { ok: false, reason: `${items.length} items share ${distinct} links` };
  if (recipe.publishedAt) {
    const dated = items.filter((i) => i.publishedAt);
    if (!dated.length) return { ok: false, reason: "no item has a date" };
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const last = tomorrow.toISOString().slice(0, 10);
    if (dated.some((i) => i.publishedAt! > last)) return { ok: false, reason: "a date is in the future" };
  }
  return { ok: true };
}
