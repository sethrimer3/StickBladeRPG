# StickBlade Auto-Sync Workflow

StickBlade's scheduled auto-sync can commit any dirty file. Coding agents must
pause it so incomplete work, failed experiments, and unrelated local changes
cannot become automatic commits.

## Commands

```powershell
powershell -NoProfile -File scripts/pause-autosync.ps1 -LeaseId codex-<new-guid> -Owner Codex -Purpose "<short task>"
powershell -NoProfile -File scripts/autosync-status.ps1
powershell -NoProfile -File scripts/resume-autosync.ps1 -LeaseId codex-<same-guid>
powershell -NoProfile -File scripts/autosync-lease-watchdog.ps1
powershell -NoProfile -File scripts/tests/autosync-integration.ps1
```

Agent pauses are unique JSON leases under `.git/AUTOSYNC_PAUSE_LEASES/`; they
are never tracked. Each agent releases only its own lease, so one finishing task
cannot resume auto-sync while another task is active. The legacy
`.git/AUTOSYNC_PAUSED` file remains available as a manual/emergency global stop
when the pause/resume helpers are called without `-LeaseId`.

The scheduled process checks for the emergency marker or any lease before
staging, before committing, and before pulling, rebasing, or pushing. A paused
run exits successfully without changing Git state. Every helper first verifies
that the resolved repository is StickBlade using its configured `origin`,
expected files, and package metadata.

## Agent procedure

1. Confirm `main` and inspect the tree. Preserve unrelated changes. If clean,
   update with a fast-forward-only pull.
2. Before investigation or editing, generate a unique lease ID and retain it
   for the task. Pause with `-LeaseId`, `-Owner`, and a short `-Purpose`, and
   require exit code 0. The helper creates that lease immediately, then waits up
   to 90 seconds for an active lock owner to finish. A lease without a
   successful, quiescent result is not permission to edit. Override the bound
   when needed with `-WaitTimeoutSeconds <seconds>`.
3. Keep it paused throughout editing, validation, commit, rebase, and push.
4. Create one coherent commit directly on `main`, synchronize safely, and push
   without force to `origin/main`.
5. Verify the exact commit on `origin/main`, release only the task's exact lease
   with `resume-autosync.ps1 -LeaseId <id>`, and run `autosync-status.ps1`.
   A successful agent task is not finished until its lease is absent. Other
   agents' leases may correctly leave auto-sync paused.

Agents do not create branches or pull requests unless the user explicitly asks.
Auto-sync is never an agent's final commit mechanism. Existing feature branches
remain preserved for human review.

If work is interrupted, tests fail, a conflict occurs, or push verification
fails, leave the task lease present, keep incomplete work uncommitted, and
report the exact lease ID and repository status.

## Abandoned-lease watchdog

Step 5 says a task is not finished until its lease is absent, but nothing
enforced it, and a paused auto-sync is silent by design — it exits successfully
and looks exactly like a healthy run. That is how the repository sat paused for
three days behind two leases whose sessions had ended.

```powershell
powershell -NoProfile -File scripts/autosync-lease-watchdog.ps1
```

It classifies every lease and **reports only**:

| Class | Meaning | Watchdog action |
|---|---|---|
| `Active` | younger than `-StaleLeaseHours` (default 6) | none |
| `Stale` | old, but the tree is dirty, commits are unpushed, or the metadata is unreadable | none — a human must inspect it |
| `Abandoned` | old **and** the tree is clean **and** nothing is unpushed | prints the exact release command |

Age alone never decides. `Abandoned` requires positive evidence that the lease
is protecting nothing, because releasing a lease that *is* protecting work is
exactly how auto-sync committed agents' in-progress trees in BUILD 615 and
again through BUILDs 626–629. Nothing is deleted unless a human passes
`-Release`, which acts only on `Abandoned` leases and re-checks each one
immediately before removing it. The emergency marker is never touched.

Exit codes: `0` clear, `2` stale (inspect), `3` abandoned, `1` the check failed.

A paused `autosync.ps1` run now performs the same assessment at its first gate,
emits a warning naming any abandoned lease, and appends it to
`.git/AUTOSYNC_LEASE_WARNINGS.log` so an unattended run leaves a trail. It
still only reports — the scheduled process never releases a lease it did not
create.

`autosync-status.ps1` lists every lease with its owner, purpose, creation time,
age, and a `stale=true` warning after six hours by default. Override the display
threshold with `-StaleLeaseHours <hours>`. Stale or unreadable leases are never
removed automatically: inspect their metadata and repository state before
releasing that exact ID.

## Who actually enforces a lease

A lease only protects the tree if the process doing the committing checks for
it. Four runners can commit this repository, and all four must check:

| Runner | Location | Checks |
|---|---|---|
| `scripts/autosync.ps1` | this repo | marker + leases (always did) |
| `scripts/scheduled-sync-all-repos.ps1` | this repo | marker + leases, and delegates to the repo-local protocol when `scripts/autosync.ps1` exists |
| `scheduled-sync-all-repos.ps1` | DustWeaver's copy | marker + leases, and delegates by protocol presence |
| `sync-repos.ps1` | **machine-wide, one directory above this repo — this is the one `\GitHub-SyncRepos` actually launches today** | marker + leases, and delegates to the repo-local protocol |

Only the first is version-controlled here. The others live outside this
repository, so nothing stops them regressing — which is why the guard described
below resolves the runner from the scheduled task itself rather than from a
fixed path.

Fixed in BUILD 615 after auto-sync committed an agent's in-progress tree twice
while a lease was held (commits `d53116ab` and `134e54ae`). Two independent
defects:

- The machine-wide `sync-repos.ps1` checked only the legacy `AUTOSYNC_PAUSED`
  marker and never `AUTOSYNC_PAUSE_LEASES/`, so every agent lease was invisible
  to it. This is the script that produced both bad commits.
- `scheduled-sync-all-repos.ps1` selected the safe repository-local path with
  `$repositoryName -eq 'StickBlade'`. The working copy is checked out as
  `StickBladeRPG`, so it fell through to the generic `git add -A` path, which
  had no pause check at all. Detection is now by presence of
  `scripts/autosync.ps1`, not by directory name.

`scripts/tests/autosync-integration.ps1` covers all of this: three functional
tests drive the scheduled runner against temporary repositories holding a lease,
a legacy marker, and a deliberately non-`StickBlade` directory name, plus source
guards over the runners that live outside this repository. The three functional
tests were verified to fail against the pre-fix runner.

### The same defect recurred (BUILDs 626–629)

Auto-sync committed and pushed an agent's in-progress work three more times
(`8a919cbe`, `4f8d558c`, and the tree behind `2d66dd13`) while a valid lease was
held. Root cause: the scheduled task does not launch this repository's
wrapper at all — at that time it launched **DustWeaver's** copy of
`scheduled-sync-all-repos.ps1`, which still selected the safe repository-local
path with a directory-name test (`-eq 'DustWeaver'`) and fell through to a
generic `git add -A` with no pause check for everything else. The BUILD 615 fix
had been applied only to this repository's copy, which nothing runs.

The machine-wide `sync-repos.ps1` had independently regressed to the same shape,
special-casing `Equatoria_Idle` by name with no lease check on the generic path.

Both were repaired the same way — delegate by presence of `scripts/autosync.ps1`,
and honour the marker and leases on the generic path — and the guard was
strengthened: it now reads the scheduled task's own action, follows the
`.vbs` wrapper to the `.ps1` it runs, and asserts *that* file checks both, plus
that it does not select its safe path by directory name. A fixed-path guard
could not see this class of failure, which is precisely why it recurred.

### And the guard itself was blind (BUILD 635)

The strengthened guard looked up the task by the fixed name `\SyncGithubRepos`.
No such task exists on this machine — the real one is **`\GitHub-SyncRepos`** —
so `Get-ScheduledTask` returned `$null`, the test took its "not registered"
skip branch, and it asserted nothing at all. `autosync-status.ps1` probed the
same wrong name and printed `not found or inaccessible` for the scheduled task
on every run. A hard-coded name is the same defect as a hard-coded path, one
level up: it points the check at something that is not what commits.

Both now **discover** the task instead, via `Find-AutosyncScheduledTasks` in
`scripts/autosync-common.ps1`: scan every scheduled task, follow each action's
`.vbs` shim to the `.ps1` it runs, and treat any task reaching a sync runner as
in scope. The guard fails loudly when discovery finds nothing, rather than
skipping. Renaming the task can no longer make either check blind.

Note that these runners live outside this repository and are therefore not
version-controlled here. If one is restored from a backup or another machine,
re-apply the lease check — the source guards will fail loudly if it regresses.

## Lock and recovery

`.git/AUTOSYNC_RUNNING` prevents concurrent instances and records process ID and
start time. A matching live process owns it. Missing/reused PIDs are reported as
stale, but scripts never delete stale or unreadable locks automatically. Confirm
no sync process is running, inspect the JSON, then remove only that exact file:

```powershell
Get-Content .git/AUTOSYNC_RUNNING
Get-Process -Id <recorded-pid>
Remove-Item -LiteralPath .git/AUTOSYNC_RUNNING
```

Never remove a lock plausibly owned by a live process. `git status` and files
such as `.git/MERGE_HEAD`, `.git/rebase-merge`, or `.git/rebase-apply` identify
in-progress operations; resolve them manually. Resume refuses during one.

Resume warns but does not block on a dirty tree. Releasing one lease does not
remove any other lease or the emergency marker. This permits concurrent agent
work while making clear that the next scheduled run may commit changes only
after the final pause reason is released.

Before staging, auto-sync saves the exact Git index. If staging or commit fails,
times out, or a pause arrives before commit, it restores that index byte-for-byte
and leaves working-tree content untouched. The backup is deleted only after a
successful commit or successful restoration. If restoration fails, auto-sync
creates the emergency pause marker, preserves the reported
`.git/AUTOSYNC_INDEX_BACKUP_*` file, and exits nonzero for manual recovery.

## Scheduled task

On this machine the task is **`\GitHub-SyncRepos`**, on a ten-minute repetition,
running as `srime`, hidden. It launches:

```text
wscript.exe "C:\Users\srime\Documents\GitHub\sync-repos-hidden.vbs"
```

Read that path carefully: it is the **machine-wide** wrapper one directory above
this repository — not this repo's `scripts/scheduled-sync-all-repos-hidden.vbs`,
and not DustWeaver's copy. Earlier versions of this document asserted each of
those in turn, and being wrong about it is exactly how a fix landed in a copy
nothing runs. Never trust the name or path recorded here; resolve it:

```powershell
powershell -NoProfile -File scripts/autosync-status.ps1
```

The status report now discovers and prints every scheduled task that reaches a
sync runner, with its actions and resolved `.ps1`. To inspect the raw task:

```powershell
(Get-ScheduledTask -TaskName 'GitHub-SyncRepos').Actions | Format-List Execute, Arguments
```

That wrapper runs the machine-wide `sync-repos.ps1`, which delegates any
repository owning `scripts/autosync.ps1` to that script — which verifies its
own repository identity and re-checks the pause state itself. Repositories
without a protocol take a generic path that still honours the marker and leases.
While any lease or the emergency marker is present, StickBlade exits
successfully and the scheduler continues servicing other repositories.

Run the disposable Git-repository regression suite with:

```powershell
powershell -NoProfile -File scripts/tests/autosync-integration.ps1
```
