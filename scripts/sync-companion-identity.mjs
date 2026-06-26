#!/usr/bin/env node
/**
 * Apply control-plane companion identity from instance.env + JOSHU_COMPANION_SOUL_FILE.
 * Used by vps-start and operators (curl POST is preferred when Joshu is running).
 */
import { syncCompanionIdentityFromEnv } from "../dist/companionIdentitySync.js";

const forceSoul = process.argv.includes("--force-soul");
const result = syncCompanionIdentityFromEnv(process.cwd(), { forceSoul });
console.log(JSON.stringify({ ok: true, ...result }));
