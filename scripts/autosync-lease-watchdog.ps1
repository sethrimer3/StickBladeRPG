# Detect agent pause leases that were never released.
#
# Why this exists: auto-sync was found paused for about three days by two leases
# left behind by agent sessions that ended without releasing them. Nothing
# noticed. The workflow says a task is not finished until its lease is absent,
# but nothing enforced it, and a paused auto-sync is silent by design - it exits
# successfully and looks exactly like a healthy run.
#
# Default behaviour is REPORT ONLY. Releasing a lease that is genuinely
# protecting work is how auto-sync committed agents' in-progress trees three
# times (BUILD 615, BUILDs 626-629), so nothing is released here unless a human
# passes -Release, and even then only leases classified Abandoned - old AND with
# a clean tree AND nothing unpushed. See Get-AutosyncLeaseAssessment.
#
# Exit codes are chosen so a scheduler or CI step can act on them:
#   0  no leases, or all Active
#   2  Stale lease(s) present - needs human inspection, may be protecting work
#   3  Abandoned lease(s) present (or released, with -Release)
#   1  the check itself failed
[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [ValidateRange(1, 8760)][int]$StaleLeaseHours = 6,
    # Opt-in. Releases ONLY leases classified Abandoned; never Stale, never
    # unreadable, and never the emergency marker.
    [switch]$Release,
    # Append a timestamped line per finding to .git/AUTOSYNC_LEASE_WARNINGS.log,
    # so an unattended run leaves a trail a human can find later.
    [switch]$LogWarnings,
    [switch]$Quiet
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'autosync-common.ps1')

function Write-WatchdogHost([string]$Message) {
    if (-not $Quiet) { Write-Host $Message }
}

try {
    $RepositoryRoot = if ($RepositoryRoot) { Get-StickBladeRepositoryRoot $RepositoryRoot } else { Get-StickBladeRepositoryRoot }
    $identity = Test-StickBladeRepositoryIdentity $RepositoryRoot
    if (-not $identity.Valid) {
        throw "StickBlade repository identity check failed. Resolved path: '$($identity.RepositoryRoot)'. Detected origin: '$($identity.Remote)'."
    }
    $paths = Get-AutosyncPaths $RepositoryRoot
    $assessments = @(Get-AutosyncLeaseAssessment -Paths $paths -RepositoryRoot $RepositoryRoot -StaleLeaseHours $StaleLeaseHours)

    if ((Test-Path -LiteralPath $paths.PauseMarker -PathType Leaf)) {
        Write-WatchdogHost 'Emergency pause marker is present. It is a deliberate manual stop and is never touched by this watchdog.'
    }
    if ($assessments.Count -eq 0) {
        Write-WatchdogHost 'No agent pause leases. Auto-sync is not held by any lease.'
        exit 0
    }

    $abandoned = @($assessments | Where-Object { $_.Classification -eq 'Abandoned' })
    $stale = @($assessments | Where-Object { $_.Classification -eq 'Stale' })
    foreach ($assessment in $assessments) {
        $age = if ($null -ne $assessment.AgeHours) { '{0:N1}h' -f $assessment.AgeHours } else { 'unknown' }
        Write-WatchdogHost ("[{0}] id={1} owner={2} age={3} purpose={4}" -f $assessment.Classification, $assessment.LeaseId, $assessment.Owner, $age, $assessment.Purpose)
        Write-WatchdogHost ("    {0}" -f $assessment.Reason)
    }

    if ($LogWarnings -and ($abandoned.Count -gt 0 -or $stale.Count -gt 0)) {
        $logPath = Join-Path $paths.GitDirectory 'AUTOSYNC_LEASE_WARNINGS.log'
        $stamp = [DateTime]::UtcNow.ToString('o')
        foreach ($assessment in @($abandoned + $stale)) {
            $line = "{0} {1} id={2} owner={3} purpose={4} reason={5}" -f $stamp, $assessment.Classification.ToUpperInvariant(), $assessment.LeaseId, $assessment.Owner, $assessment.Purpose, $assessment.Reason
            Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
        }
    }

    if ($abandoned.Count -gt 0 -and $Release) {
        foreach ($assessment in $abandoned) {
            # Re-assess immediately before removing: the tree may have been
            # dirtied by an agent that woke up between the scan and now.
            $recheck = @(Get-AutosyncLeaseAssessment -Paths $paths -RepositoryRoot $RepositoryRoot -StaleLeaseHours $StaleLeaseHours |
                Where-Object { $_.LeaseId -eq $assessment.LeaseId })
            if ($recheck.Count -ne 1 -or $recheck[0].Classification -ne 'Abandoned') {
                Write-WatchdogHost "Skipped releasing '$($assessment.LeaseId)': it no longer classifies as abandoned."
                continue
            }
            Remove-Item -LiteralPath $assessment.Path -Force -ErrorAction Stop
            Write-WatchdogHost "Released abandoned lease '$($assessment.LeaseId)'."
        }
    } elseif ($abandoned.Count -gt 0) {
        Write-WatchdogHost ''
        Write-WatchdogHost "$($abandoned.Count) lease(s) appear abandoned and are protecting nothing. Auto-sync stays paused until they are released. Review the metadata above, then release each exact ID:"
        foreach ($assessment in $abandoned) {
            Write-WatchdogHost "    powershell -NoProfile -File scripts/resume-autosync.ps1 -LeaseId '$($assessment.LeaseId)'"
        }
        Write-WatchdogHost 'Or re-run this watchdog with -Release to release exactly these.'
    }
    if ($stale.Count -gt 0) {
        Write-WatchdogHost ''
        Write-WatchdogHost "$($stale.Count) lease(s) are old but may be protecting real work. These are NEVER released automatically - inspect the repository before touching them."
    }

    if ($abandoned.Count -gt 0) { exit 3 }
    if ($stale.Count -gt 0) { exit 2 }
    exit 0
} catch { Write-Error "Could not run the StickBlade auto-sync lease watchdog: $($_.Exception.Message)"; exit 1 }
