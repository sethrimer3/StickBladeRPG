[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    # Empty means "discover it". Pass a name only to inspect one specific task.
    [string]$ScheduledTaskName,
    [ValidateRange(1, 8760)][int]$StaleLeaseHours = 6
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'autosync-common.ps1')
try {
    $RepositoryRoot = if ($RepositoryRoot) { Get-StickBladeRepositoryRoot $RepositoryRoot } else { Get-StickBladeRepositoryRoot }
    $identity = Test-StickBladeRepositoryIdentity $RepositoryRoot
    if (-not $identity.Valid) {
        throw "StickBlade repository identity check failed. Resolved path: '$($identity.RepositoryRoot)'. Detected origin: '$($identity.Remote)'."
    }
    $paths = Get-AutosyncPaths $RepositoryRoot
    $pauseState = Get-AutosyncPauseState $paths
    $branch = Get-CurrentGitBranch $RepositoryRoot
    $porcelain = @(& git -C $RepositoryRoot status --porcelain 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect working-tree details.' }
    $stagedCount = @($porcelain | Where-Object { $_.Length -ge 2 -and $_[0] -notin @(' ', '?') }).Count
    $unstagedCount = @($porcelain | Where-Object { $_.Length -ge 2 -and $_[1] -notin @(' ', '?') }).Count
    $untrackedCount = @($porcelain | Where-Object { $_.StartsWith('??') }).Count
    $dirty = $porcelain.Count -gt 0
    $operation = Get-GitOperationState $paths.GitDirectory
    $lockState = Get-AutosyncLockState $paths.RunningLock
    $ahead = 'unavailable'
    $behind = 'unavailable'
    $divergence = & git -C $RepositoryRoot rev-list --left-right --count 'origin/main...main' 2>$null
    if ($LASTEXITCODE -eq 0 -and $divergence -match '^\s*(\d+)\s+(\d+)\s*$') {
        $behind = $Matches[1]
        $ahead = $Matches[2]
    }
    $lastCommit = & git -C $RepositoryRoot log -1 --date=iso --pretty=format:'%h %ad %s' --grep='^Auto-sync' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $lastCommit) { $lastCommit = 'none found' }
    $scheduledTasks = @()
    $scheduledTaskError = $null
    try {
        $scheduledTasks = @(Find-AutosyncScheduledTasks)
        if ($ScheduledTaskName) {
            $wanted = $ScheduledTaskName.TrimStart('\')
            $scheduledTasks = @($scheduledTasks | Where-Object { $_.TaskPath.TrimStart('\') -eq $wanted -or $_.TaskName -eq $wanted })
        }
    } catch { $scheduledTaskError = $_.Exception.Message }
    Write-Host 'Repository identity: passed (sethrimer3/StickBlade)'
    Write-Host "Auto-sync: $(if ($pauseState.Paused) { 'paused' } else { 'active' })"
    Write-Host "Emergency pause marker: $(if ($pauseState.EmergencyPause) { 'present' } else { 'absent' })"
    Write-Host "Agent pause leases: $($pauseState.Leases.Count)"
    foreach ($leaseFile in $pauseState.Leases) {
        $leaseId = [IO.Path]::GetFileNameWithoutExtension($leaseFile.Name)
        try {
            $lease = Get-Content -LiteralPath $leaseFile.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $createdUtc = [DateTime]::Parse([string]$lease.createdUtc).ToUniversalTime()
            $age = [DateTime]::UtcNow - $createdUtc
            $stale = $age.TotalHours -ge $StaleLeaseHours
            Write-Host ("Lease: id={0} owner={1} age={2:N1}h stale={3} createdUtc={4} purpose={5}" -f $leaseId, $lease.owner, $age.TotalHours, $stale.ToString().ToLowerInvariant(), $createdUtc.ToString('o'), $lease.purpose)
        } catch {
            Write-Host "Lease: id=$leaseId metadata=unreadable stale=unknown path=$($leaseFile.FullName)"
        }
    }
    Write-Host "Branch: $branch"
    Write-Host "Working tree: $(if ($dirty) { 'dirty' } else { 'clean' })"
    Write-Host "Changes: staged=$stagedCount unstaged=$unstagedCount untracked=$untrackedCount"
    Write-Host "Divergence from origin/main: ahead=$ahead behind=$behind"
    Write-Host "Git operation: $operation"
    Write-Host "Running lock: $($lockState.Detail)"
    if ($lockState.Exists) {
        Write-Host "Lock metadata: pid=$($lockState.ProcessId) processStartUtc=$($lockState.ProcessStartUtc) createdUtc=$($lockState.CreatedUtc) repository=$($lockState.Repository)"
    }
    if ($scheduledTaskError) {
        Write-Host "Scheduled sync tasks: not queryable ($scheduledTaskError)"
    } elseif ($scheduledTasks.Count -eq 0) {
        Write-Host 'Scheduled sync tasks: none found (auto-sync will never run unattended)'
    } else {
        Write-Host "Scheduled sync tasks: $($scheduledTasks.Count)"
        foreach ($scheduledTask in $scheduledTasks) {
            Write-Host ("Task: {0} state={1} enabled={2}" -f $scheduledTask.TaskPath, $scheduledTask.State, $scheduledTask.Enabled.ToString().ToLowerInvariant())
            foreach ($action in $scheduledTask.Actions) { Write-Host "  action: $action" }
            foreach ($runner in $scheduledTask.Runners) { Write-Host "  runner: $runner" }
        }
    }
    Write-Host "Last auto-sync commit: $lastCommit"
    exit 0
} catch { Write-Error "Could not inspect StickBlade auto-sync: $($_.Exception.Message)"; exit 1 }
