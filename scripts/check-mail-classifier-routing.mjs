#!/usr/bin/env node
/**
 * Unit checks for unified mail ingress routing (scheduling → track + hints).
 *
 * Usage: npm run test:mail-classifier-routing
 */
import {
  isSchedulingCategoryHint,
  normalizeForIngressRouting,
} from "../dist/ea/classifier.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Legacy scheduling disposition collapses to track
const legacy = normalizeForIngressRouting({
  disposition: "scheduling",
  confidence: 0.9,
  category: "unknown",
  project_slug: null,
  is_new_track: true,
  reason: "cold meet",
});
assert(legacy.disposition === "track", "scheduling disposition → track");
assert(legacy.category === "scheduling", "unknown + legacy scheduling → scheduling category");
assert(legacy.project_slug === "other", "scheduling without slug → other");

// Category scheduling fills other slug
const hinted = normalizeForIngressRouting({
  disposition: "track",
  confidence: 0.85,
  category: "scheduling",
  project_slug: null,
  is_new_track: false,
  reason: "offer times",
});
assert(hinted.project_slug === "other", "scheduling category hint → other slug");
assert(isSchedulingCategoryHint(hinted), "isSchedulingCategoryHint");

// Project slug preserved
const embedded = normalizeForIngressRouting({
  disposition: "track",
  confidence: 0.88,
  category: "scheduling",
  project_slug: "uplabs-email-assistant",
  is_new_track: false,
  reason: "partner thread",
});
assert(embedded.project_slug === "uplabs-email-assistant", "keep project slug");

console.log("mail-classifier-routing checks ok");
