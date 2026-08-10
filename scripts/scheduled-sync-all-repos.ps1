[CmdletBinding()]
param([string]$RepositoriesRoot = 'C:\Users\srime\Documents\GitHub')

$ErrorActionPreference = 'Continue'
$logFile = Join-Path $RepositoriesRoot 'sync-repos.log'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_ASKPASS = 'echo'

function Write-SyncLog([string]$Message) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" |
        Out-File -FilePath $logFile -Append -Encoding utf8
}

function Invoke-GitWithTimeout {
    param([string[]]$GitArgs, [string]$WorkingDirectory, [int]$TimeoutSeconds = 60)
    $job = Start-Job -ScriptBlock {
        param($Directory, $Arguments)
        Set-Location $Directory
        $env:GIT_TERMINAL_PROMPT = '0'
        $env:GIT_ASKPASS = 'echo'
        & git @Arguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "git exited with code $LASTEXITCODE" }
    } -ArgumentList $WorkingDirectory, $GitArgs
    if (Wait-Job $job -Timeout $TimeoutSeconds) {
        $output = Receive-Job $job -ErrorAction Continue
        $state = $job.State
        Remove-Job $job -Force | Out-Null
        if ($state -ne 'Completed') { throw "git $($GitArgs -join ' ') failed: $output" }
        return $output
    }
    Stop-Job $job | Out-Null
    Remove-Job $job -Force | Out-Null
    throw "git $($GitArgs -join ' ') timed out after $TimeoutSeconds seconds"
}

Write-SyncLog '=== Sync run started ==='
Get-ChildItem -LiteralPath $RepositoriesRoot -Directory | ForEach-Object {
    $repository = $_.FullName
    $repositoryName = $_.Name
    if (-not (Test-Path -LiteralPath (Join-Path $repository '.git'))) { return }
    try {
        # Detect the repository-local protocol by its presence, NOT by directory
        # name. The working copy has been checked out as both 'StickBlade' and
        # 'StickBladeRPG'; a name equality test silently routed the latter down
        # the generic path below, which ignores pause leases and auto-committed
        # agents' in-progress work.
        $stickBladeScript = Join-Path $repository 'scripts\autosync.ps1'
        if (Test-Path -LiteralPath $stickBladeScript -PathType Leaf) {
            $commonScript = Join-Path $repository 'scripts\autosync-common.ps1'
            if (Test-Path -LiteralPath $commonScript -PathType Leaf) {
                . $commonScript
                # Only assert StickBlade's identity for a repository that
                # actually claims to be StickBlade. Another repository adopting
                # the same protocol layout must not be rejected outright.
                $identity = Test-StickBladeRepositoryIdentity $repository
                if (-not $identity.Valid -and $identity.PackageName -eq 'stickblade') {
                    throw "StickBlade identity check failed for '$repository': origin '$($identity.Remote)', missing '$($identity.MissingFiles -join ', ')'."
                }
            }
            Write-SyncLog "Syncing $repositoryName through its repository safety protocol"
            $output = & powershell.exe -NoProfile -NonInteractive -File $stickBladeScript -RepositoryRoot $repository 2>&1
            Write-SyncLog "  protocol: $($output -join [Environment]::NewLine)"
            if ($LASTEXITCODE -ne 0) { Write-SyncLog "  protocol stopped safely with exit code $LASTEXITCODE" }
            return
        }

        # Preserve the pre-existing behavior for repositories that have not
        # adopted their own repository-local safety protocol — but still honour
        # an explicit pause. This generic path runs `add -A`, so ignoring a
        # pause here would commit whatever an agent had half-written.
        $gitDirOutput = & git -C $repository rev-parse --absolute-git-dir 2>$null
        if ($LASTEXITCODE -eq 0 -and $gitDirOutput) {
            $gitDir = ([string]($gitDirOutput | Select-Object -Last 1)).Trim()
            if (Test-Path -LiteralPath (Join-Path $gitDir 'AUTOSYNC_PAUSED')) {
                Write-SyncLog "Skipping $repositoryName; auto-sync is paused."
                return
            }
            $leaseDirectory = Join-Path $gitDir 'AUTOSYNC_PAUSE_LEASES'
            if (Test-Path -LiteralPath $leaseDirectory -PathType Container) {
                $leases = @(Get-ChildItem -LiteralPath $leaseDirectory -File -ErrorAction SilentlyContinue)
                if ($leases.Count -gt 0) {
                    Write-SyncLog "Skipping $repositoryName; $($leases.Count) agent pause lease(s) active."
                    return
                }
            }
        }

        Write-SyncLog "Syncing $repositoryName"
        $status = & git -C $repository status --porcelain 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git status failed: $($status -join [Environment]::NewLine)" }
        if ($status) {
            & git -C $repository add -A
            if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
            & git -C $repository commit -m "Auto-sync $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" 2>&1 |
                ForEach-Object { Write-SyncLog "  auto-commit: $_" }
            if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
        }
        $pullOutput = Invoke-GitWithTimeout @('pull', '--no-rebase') $repository
        Write-SyncLog "  pull: $pullOutput"
        $ahead = & git -C $repository rev-list --count '@{u}..HEAD' 2>&1
        if ($LASTEXITCODE -eq 0 -and [int]($ahead | Select-Object -Last 1) -gt 0) {
            $pushOutput = Invoke-GitWithTimeout @('push') $repository
            Write-SyncLog "  push: $pushOutput"
        }
    } catch {
        Write-SyncLog "  ERROR in $repositoryName`: $($_.Exception.Message)"
    }
}
Write-SyncLog '=== Sync run finished ==='
