# Batch incoming notifications — same-sender grouping

When one person sends multiple identical-type notifications in quick succession, treat them as a single batch rather than N independent items.

## Detection

| Signal | Example from session |
|--------|-------------------|
| Same sender across 3+ stubs within minutes | Allen Hua sent 6 OneDrive notebook shares in 3 minutes (Jun 15, 23:25–23:28) |
| Same notification type | All were `"Person shared \"X\" with you"` OneDrive links |
| Nearly identical body | Each had the same "Here's the document that Allen Hua shared with you" template with a different notebook name and URL |
| Sender has an active project relationship | Allen was already tracked under `joshu-product-development` (KB in Teams call happened earlier that day) |

## Treatment

```
Instead of:  6 journal entries, 6 todo rows, 6 about.md lines
Do:          1 journal entry under the parent project listing all shared items
```

**Worked example — Allen Hua's notebook shares:**

1. Detected batch: 6 stubs, same sender (Allen Hua), same platform template (OneDrive share), same 3-minute window.
2. Read ONE thread body — the template was identical across all 6 with only the notebook name and URL differing.
3. Filed under `joshu-product-development` (Allen's KB in Teams project) as:
   ```
   Allen Hua shared notebooks: Manager Notebook 2, H.U.A, WC Notebook 2,
   WC Notebook Monrovia, WC Notebook Midtown Crossing, Anaheim Team Notebook (Jun 15).
   ```
4. Moved all 6 stubs to `_done/`.
5. No separate todo rows — the existing KB call was already marked done; the shares were post-call collateral.

## When NOT to batch

- Different notification types from the same sender (e.g. a calendar invite + a file share + an email) — these are separate actions.
- Same-sender notifications on different days — likely separate deliveries.
- Notifications requiring different responses (e.g. one file to review vs. one to sign) — each gets its own treatment.
- Sender has no existing project relationship — file individually under `other` with `info` status.

## Common sources of batches

- OneDrive / Google Drive / Dropbox file or folder shares
- Google Doc / Sheets / Slides share invites
- Multiple calendar invitations from the same person
- Batch document comments or @mentions from the same collaborator
- Multiple automated alerts from the same system (e.g. 3 monitoring alerts from the same provider)