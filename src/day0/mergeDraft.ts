import type { OnboardingDraft } from "../onboarding/types.js";
import type { Day0InferResult } from "./types.js";

function isEmptyString(v: unknown): boolean {
  return typeof v !== "string" || !v.trim();
}

function isEmptyArray(v: unknown): boolean {
  return !Array.isArray(v) || v.length === 0;
}

/** Merge Day 0 inference into draft — only fill empty fields; never overwrite user edits. */
export function mergeDay0IntoDraft(
  existing: OnboardingDraft,
  inferred: Day0InferResult,
): { draft: OnboardingDraft; fieldsFilled: string[] } {
  const draft: OnboardingDraft = { ...existing };
  const fieldsFilled: string[] = [];

  if (inferred.bigPicturePriorities?.length && isEmptyArray(draft.bigPicturePriorities)) {
    draft.bigPicturePriorities = inferred.bigPicturePriorities;
    fieldsFilled.push("bigPicturePriorities");
  }
  if (inferred.bigPictureNotes?.trim() && isEmptyString(draft.bigPictureNotes)) {
    draft.bigPictureNotes = inferred.bigPictureNotes.trim();
    fieldsFilled.push("bigPictureNotes");
  }
  if (inferred.communicationChannels?.length && isEmptyArray(draft.communicationChannels)) {
    draft.communicationChannels = inferred.communicationChannels;
    fieldsFilled.push("communicationChannels");
  }
  if (inferred.communicationNotes?.trim() && isEmptyString(draft.communicationNotes)) {
    draft.communicationNotes = inferred.communicationNotes.trim();
    fieldsFilled.push("communicationNotes");
  }
  if (inferred.onlineTools?.length && isEmptyArray(draft.onlineTools)) {
    draft.onlineTools = inferred.onlineTools;
    fieldsFilled.push("onlineTools");
  }
  if (inferred.onlineToolsNotes?.trim() && isEmptyString(draft.onlineToolsNotes)) {
    draft.onlineToolsNotes = inferred.onlineToolsNotes.trim();
    fieldsFilled.push("onlineToolsNotes");
  }
  if (inferred.primaryWorkEmail?.trim() && isEmptyString(draft.primaryWorkEmail)) {
    draft.primaryWorkEmail = inferred.primaryWorkEmail.trim();
    fieldsFilled.push("primaryWorkEmail");
  }
  if (inferred.personalEmail?.trim() && isEmptyString(draft.personalEmail)) {
    draft.personalEmail = inferred.personalEmail.trim();
    fieldsFilled.push("personalEmail");
  }
  if (inferred.timezone?.trim() && isEmptyString(draft.timezone)) {
    draft.timezone = inferred.timezone.trim();
    fieldsFilled.push("timezone");
  }
  if (inferred.workingHoursStart?.trim() && isEmptyString(draft.workingHoursStart)) {
    draft.workingHoursStart = inferred.workingHoursStart.trim();
    fieldsFilled.push("workingHoursStart");
  }
  if (inferred.workingHoursEnd?.trim() && isEmptyString(draft.workingHoursEnd)) {
    draft.workingHoursEnd = inferred.workingHoursEnd.trim();
    fieldsFilled.push("workingHoursEnd");
  }

  if (inferred.communicationContacts && isEmptyArray(draft.communicationContacts)) {
    draft.communicationContacts = { ...inferred.communicationContacts };
    fieldsFilled.push("communicationContacts");
  } else if (inferred.communicationContacts && draft.communicationContacts) {
    const merged = { ...draft.communicationContacts };
    let added = false;
    for (const [k, v] of Object.entries(inferred.communicationContacts)) {
      if (!merged[k]?.trim() && v.trim()) {
        merged[k] = v.trim();
        added = true;
      }
    }
    if (added) {
      draft.communicationContacts = merged;
      fieldsFilled.push("communicationContacts");
    }
  }

  if (inferred.vips?.length && isEmptyArray(draft.vips)) {
    draft.vips = inferred.vips;
    fieldsFilled.push("vips");
  }

  return { draft, fieldsFilled };
}
