#!/usr/bin/env node
/**
 * Joshu box CLI — snap, restore, factory reset, status.
 * Usage: npm run box -- status|snap|restore|factory-reset|list
 */
import "dotenv/config";
import {
  createSnapshot,
  factoryApplySoft,
  factoryWipePersonal,
  getBoxStatus,
  listSnapshots,
  restoreSnapshot,
  resolveBoxPaths,
  runHardResetPostSteps,
  runHardResetPreflight,
  stopGbrainStack,
  writeDefaultIdentity,
} from "./index.js";
import { resolveSnapshotStorage } from "./storage/index.js";

function usage(): never {
  console.log(`Joshu box state

  npm run box -- status
  npm run box -- list
  npm run box -- snap [--label NAME] [--include-gbrain] [--shared]
  npm run box -- restore --id SNAPSHOT_ID [--from-box BOX_ID]
  npm run box -- factory-apply
  npm run box -- factory-reset [--mode soft|hard] [--confirm]

Factory = repo (factory/manifest.yaml, templates/). Personal = .local/* and ~/.hermes/config.user.yaml.
`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) usage();

  const paths = resolveBoxPaths(process.cwd());

  if (cmd === "status") {
    const status = getBoxStatus(paths);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (cmd === "list") {
    const snaps = await listSnapshots(paths);
    if (snaps.length === 0) {
      const storage = resolveBoxPaths(process.cwd());
      console.log("No snapshots (local cache:", storage.snapshotDir + ")");
      return;
    }
    for (const s of snaps) {
      const where = s.storageKey ?? s.storageBoxId ?? "local";
      console.log(`${s.snapshotId}\t${s.label ?? ""}\t${s.createdAt}\t${where}`);
    }
    return;
  }

  if (cmd === "snap") {
    const label = argValue("--label");
    const includeGbrain = process.argv.includes("--include-gbrain");
    const shared = process.argv.includes("--shared");
    const result = await createSnapshot(paths, { label, includeGbrain, shared });
    console.log(`Snapshot created: ${result.snapshotId}`);
    if (result.manifest.storageKey) {
      console.log(`Stored: ${result.manifest.storageKey}`);
    } else {
      console.log(`Archive: ${result.archivePath}`);
    }
    return;
  }

  if (cmd === "restore") {
    const id = argValue("--id");
    if (!id) {
      console.error("restore requires --id SNAPSHOT_ID");
      process.exit(1);
    }
    const sourceBoxId = argValue("--from-box");
    await restoreSnapshot(paths, id, { sourceBoxId });
    factoryApplySoft(paths);
    console.log(`Restored ${id}; ran soft factory-apply`);
    return;
  }

  if (cmd === "factory-apply") {
    const applied = factoryApplySoft(paths);
    console.log(`Factory apply: seeded ${applied.seeded.length}, dirs ${applied.structureCreated.length}`);
    return;
  }

  if (cmd === "factory-reset") {
    const mode = argValue("--mode") ?? "soft";
    const confirm = process.argv.includes("--confirm");
    if (mode === "hard" && !confirm) {
      console.error("hard factory-reset requires --confirm (destroys personal state)");
      process.exit(1);
    }
    if (mode === "hard") {
      const composio = await runHardResetPreflight(paths);
      if (composio.ok && !composio.skipped) {
        const count = composio.disconnected?.length ?? 0;
        console.log(`Composio disconnected ${count} connected account(s) for ${composio.userId ?? "sandbox user"}`);
      } else if (composio.skipped) {
        console.log("Composio wipe skipped (not configured)");
      } else {
        throw new Error(`Composio wipe failed: ${composio.error ?? composio.errors?.join("; ") ?? "unknown"}`);
      }
      const stopped = await stopGbrainStack(paths.projectRoot, paths.gbrainHome);
      if (!stopped.ok) {
        throw new Error(stopped.error ?? "failed to stop gbrain before factory wipe");
      }
      const removed = factoryWipePersonal(paths, paths.factoryManifest);
      writeDefaultIdentity(paths, paths.factoryManifest);
      console.log("Removed:", removed.join(", ") || "(nothing)");
      const post = await runHardResetPostSteps(paths);
      if (!post.desktop.ok) {
        throw new Error(post.desktop.error ?? "failed to restore factory desktop shortcuts");
      }
      if (post.hindsight.ok) {
        console.log("Hindsight memories cleared");
      } else if (post.hindsight.skipped) {
        console.warn(`Hindsight wipe skipped: ${post.hindsight.error ?? "unavailable"}`);
      } else {
        console.warn(`Hindsight wipe failed: ${post.hindsight.error ?? "unknown"}`);
      }
      if (post.gbrain.ok) {
        console.log("gbrain reinitialized");
      } else {
        console.warn(`gbrain restart failed: ${post.gbrain.error ?? "unknown"}`);
      }
    }
    const applied = factoryApplySoft(paths);
    console.log(`Factory reset (${mode}) complete`);
    console.log(`Seeded ${applied.seeded.length} files, created ${applied.structureCreated.length} dirs`);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
