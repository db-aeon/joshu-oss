/**
 * DOM catalog types + sanitizer for the mobile handoff overlay.
 *
 * Scan prompts import this module. Fill payloads (owner-typed values) must not
 * live here — they stay on the Joshu → shared browser fill path.
 */

export const HANDOFF_MAX_OVERLAY_FIELDS = 32;

export type OverlayInputType =
  | "email"
  | "password"
  | "tel"
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "radio";

export type CatalogSelectOption = {
  value: string;
  label: string;
};

export type CatalogField = {
  id: string;
  tag: string;
  type: string;
  name: string;
  elementId: string;
  autocomplete: string;
  placeholder: string;
  label: string;
  options?: CatalogSelectOption[];
  /** Non-secret current value from the page (never passwords / cards). */
  value?: string;
  checked?: boolean;
};

export type CatalogButton = {
  id: string;
  text: string;
  type: string;
  ariaLabel: string;
};

export type FormCatalog = {
  fields: CatalogField[];
  buttons: CatalogButton[];
};

export type OverlayField = {
  id: string;
  inputType: OverlayInputType;
  label: string;
  options?: CatalogSelectOption[];
  /** Page prefill only — never owner overlay input. */
  prefill?: string;
  checked?: boolean;
};

export type OverlayScan = {
  fields: OverlayField[];
  primaryButtonId: string | null;
  primaryButtonLabel: string | null;
  source: "llm" | "heuristic";
};

const SECRET_TYPES = new Set(["password"]);
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "one-time-code",
]);

function blob(field: CatalogField): string {
  return [field.type, field.name, field.elementId, field.autocomplete, field.placeholder, field.label]
    .join(" ")
    .toLowerCase();
}

export function isSecretCatalogField(field: CatalogField): boolean {
  const auto = field.autocomplete.trim().toLowerCase();
  if (SECRET_TYPES.has(field.type.trim().toLowerCase())) return true;
  if (SECRET_AUTOCOMPLETE.has(auto)) return true;
  if (/\bpassword\b/.test(blob(field))) return true;
  if (/\b(cvv|cvc|card.?number|credit.?card)\b/.test(blob(field))) return true;
  return false;
}

function cloneField(field: CatalogField): CatalogField {
  return {
    ...field,
    options: field.options?.map((opt) => ({ value: opt.value, label: opt.label })),
  };
}

/** Drop live values before any LLM prompt or Langfuse input. */
export function sanitizeCatalog(catalog: FormCatalog): FormCatalog {
  return {
    fields: catalog.fields.slice(0, HANDOFF_MAX_OVERLAY_FIELDS).map((field) => {
      const next = cloneField(field);
      delete next.value;
      delete next.checked;
      return next;
    }),
    buttons: catalog.buttons.map((btn) => ({
      id: btn.id,
      text: String(btn.text || "").slice(0, 80),
      type: btn.type,
      ariaLabel: String(btn.ariaLabel || "").slice(0, 80),
    })),
  };
}

/** Compact catalog for the scan model — ids + labels only, no values. */
export function catalogForScanPrompt(catalog: FormCatalog): {
  fields: Array<{
    id: string;
    tag: string;
    type: string;
    name: string;
    elementId: string;
    autocomplete: string;
    placeholder: string;
    label: string;
    optionLabels?: string[];
  }>;
  buttons: Array<{ id: string; text: string; type: string; ariaLabel: string }>;
} {
  const sanitized = sanitizeCatalog(catalog);
  return {
    fields: sanitized.fields.map((field) => ({
      id: field.id,
      tag: field.tag,
      type: field.type,
      name: field.name,
      elementId: field.elementId,
      autocomplete: field.autocomplete,
      placeholder: field.placeholder,
      label: field.label,
      optionLabels: field.options?.map((opt) => opt.label).slice(0, 12),
    })),
    buttons: sanitized.buttons,
  };
}

export function inferOverlayInputType(field: CatalogField): OverlayInputType {
  const type = field.type.trim().toLowerCase();
  const tag = field.tag.trim().toUpperCase();
  if (tag === "SELECT") return "select";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "email" || /\bemail\b/.test(blob(field))) return "email";
  if (type === "password" || /\bpassword\b/.test(blob(field))) return "password";
  if (type === "tel" || /\b(phone|tel|mobile)\b/.test(blob(field))) return "tel";
  if (type === "number" || type === "otp") return "number";
  return "text";
}

const POSITIVE_BUTTON =
  /\b(continue|sign[\s-]?in|log[\s-]?in|next|verify|submit|confirm|place order|pay now|pay|buy now|send|agree)\b/i;
const NEGATIVE_BUTTON =
  /\b(cancel|back|forgot|skip|not now|create account|register|new customer|learn more)\b/i;

export function scoreCatalogButton(button: CatalogButton): number {
  const text = `${button.text} ${button.ariaLabel}`.trim();
  let score = 0;
  if (String(button.type || "").toLowerCase() === "submit") score += 3;
  if (POSITIVE_BUTTON.test(text)) score += 5;
  if (NEGATIVE_BUTTON.test(text)) score -= 10;
  return score;
}

export function heuristicPrimaryButton(catalog: FormCatalog): CatalogButton | null {
  let best: { button: CatalogButton; score: number } | null = null;
  let runner = -Infinity;
  for (const button of catalog.buttons) {
    const score = scoreCatalogButton(button);
    if (!best || score > best.score) {
      runner = best?.score ?? -Infinity;
      best = { button, score };
    } else if (score > runner) {
      runner = score;
    }
  }
  if (!best || best.score < 3) return null;
  // Require a clear winner so we do not click Cancel-adjacent controls.
  if (best.score - runner < 2 && runner >= 3) return null;
  return best.button;
}

function overlayFieldFromCatalog(field: CatalogField, inputType: OverlayInputType, label: string): OverlayField {
  const out: OverlayField = {
    id: field.id,
    inputType,
    label: label.trim() || field.label.trim() || field.placeholder.trim() || field.name.trim() || "Field",
  };
  if (field.options?.length) out.options = field.options;
  if (!isSecretCatalogField(field) && typeof field.value === "string" && field.value) {
    out.prefill = field.value;
  }
  if (field.checked === true && (inputType === "checkbox" || inputType === "radio")) {
    out.checked = true;
  }
  return out;
}

/** DOM-only overlay when the scan LLM is down. */
export function heuristicOverlayScan(catalog: FormCatalog): OverlayScan {
  const fields = catalog.fields.slice(0, HANDOFF_MAX_OVERLAY_FIELDS).map((field) => {
    return overlayFieldFromCatalog(field, inferOverlayInputType(field), field.label);
  });
  const primary = heuristicPrimaryButton(catalog);
  return {
    fields,
    primaryButtonId: primary?.id ?? null,
    primaryButtonLabel: primary?.text?.trim() || primary?.ariaLabel?.trim() || null,
    source: "heuristic",
  };
}

export function mergeOverlayScan(
  catalog: FormCatalog,
  picked: {
    fields?: Array<{ id?: unknown; inputType?: unknown; label?: unknown }>;
    primaryButtonId?: unknown;
  },
): OverlayScan {
  const byId = new Map(catalog.fields.map((field) => [field.id, field]));
  const allowedTypes = new Set<OverlayInputType>([
    "email",
    "password",
    "tel",
    "text",
    "number",
    "select",
    "checkbox",
    "radio",
  ]);
  const fields: OverlayField[] = [];
  const seen = new Set<string>();
  for (const row of picked.fields ?? []) {
    const id = typeof row.id === "string" ? row.id : "";
    const field = byId.get(id);
    if (!field || seen.has(id)) continue;
    seen.add(id);
    const inferred = inferOverlayInputType(field);
    const inputType = allowedTypes.has(row.inputType as OverlayInputType)
      ? (row.inputType as OverlayInputType)
      : inferred;
    const label = typeof row.label === "string" && row.label.trim() ? row.label : field.label;
    fields.push(overlayFieldFromCatalog(field, inputType, label));
  }
  // Keep catalog order for any fields the model dropped.
  for (const field of catalog.fields.slice(0, HANDOFF_MAX_OVERLAY_FIELDS)) {
    if (seen.has(field.id)) continue;
    seen.add(field.id);
    fields.push(overlayFieldFromCatalog(field, inferOverlayInputType(field), field.label));
  }
  const buttonIds = new Set(catalog.buttons.map((btn) => btn.id));
  let primaryButtonId =
    typeof picked.primaryButtonId === "string" && buttonIds.has(picked.primaryButtonId)
      ? picked.primaryButtonId
      : null;
  if (!primaryButtonId) {
    primaryButtonId = heuristicPrimaryButton(catalog)?.id ?? null;
  }
  const primary = catalog.buttons.find((btn) => btn.id === primaryButtonId) ?? null;
  return {
    fields,
    primaryButtonId,
    primaryButtonLabel: primary?.text?.trim() || primary?.ariaLabel?.trim() || null,
    source: "llm",
  };
}
