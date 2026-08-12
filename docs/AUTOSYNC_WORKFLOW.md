# StickBlade Auto-Sync Workflow

StickBlade's scheduled auto-sync can commit any dirty file. Coding agents must
pause it so incomplete work, failed experiments, and unrelated local changes
cannot become automatic commits.

## Commands

```powershell
powershell -NoProfile -File scripts/pause-autosync.ps1 -LeaseId codex-<new-guid> -Owner Codex -Purpose "<short task>"
powershell -NoProfile -File scripts/autosync-status.ps1
powershell -NoProfile -File scripts/resume-autosync.ps1 -LeaseId codex-<same-guid>
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
| `scheduled-sync-all-repos.ps1` | **DustWeaver's copy — this is the one the scheduled task actually launches** | marker + leases, and delegates by protocol presence |
| `sync-repos.ps1` | machine-wide, one directory above this repo | marker + leases, and delegates to the repo-local protocol |

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
held. Root cause: the `\SyncGithubRepos` task does not launch this repository's
wrapper at all — it launches **DustWeaver's** copy of
`scheduled-sync-all-repos.ps1`, which still selected the safe repository-local
path with a directory-name test (`-eq 'DustWeaver'`) and fell through to a
generic `git add -A` with no pause check for everything else. The BUILD 615 fix
had been applied only to this repository's copy, which nothing runs.

The machine-wide `sync-repos.ps1` had independently regressed to the same shape,
special-casing `Equatoria_Idle` by name with no lease check on the generic path.

Both were repaired the same way — delegate by presence of `scripts/autosync.ps1`,
and honour the marker and leases on the generic path — and the guard was
strengthened: it now reads the `\SyncGithubRepos` task's own action, follows the
`.vbs` wrapper to the `.ps1` it runs, and asserts *that* file checks both, plus
that it does not select its safe path by directory name. A fixed-path guard
could not see this class of failure, which is precisely why it recurred.

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

Task `\SyncGithubRepos` retains its ten-minute schedule, user context, hidden
execution, and `C:\Users\srime\Documents\GitHub` working directory. It launches:

```text
wscript.exe "C:\Users\srime\Documents\GitHub\DustWeaver\scripts\scheduled-sync-all-repos-hidden.vbs"
```

Read that path carefully: it is **DustWeaver's** wrapper, not this repository's.
This repo's own `scripts/scheduled-sync-all-repos-hidden.vbs` is not what the
scheduler runs, and an earlier version of this document claimed otherwise —
which is how a fix landed in the wrong copy and let the defect recur. Confirm
what is actually scheduled before trusting any of this:

```powershell
(Get-ScheduledTask -TaskName 'SyncGithubRepos').Actions | Format-List Execute, Arguments
```

That wrapper runs DustWeaver's `scheduled-sync-all-repos.ps1`, which delegates
any repository owning `scripts/autosync.ps1` to that script — which verifies its
own repository identity and re-checks the pause state itself. Repositories
without a protocol take a generic path that still honours the marker and leases.
While any lease or the emergency marker is present, StickBlade exits
successfully and the scheduler continues servicing other repositories.

Run the disposable Git-repository regression suite with:

```powershell
powershell -NoProfile -File scripts/tests/autosync-integration.ps1
```
