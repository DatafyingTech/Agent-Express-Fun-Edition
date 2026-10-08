<#
Hearth installer and helper for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7).

One line, from any PowerShell window (it downloads Hearth, then installs it):

  irm https://raw.githubusercontent.com/DatafyingTech/Hearth-HQ/main/install.ps1 | iex

or double-click install.bat in a downloaded copy. With options, from a copy:

  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Action <action>] [options]

What `install` does (every step is skipped when it's already done, so running it again is safe):
  1. checks for Node.js 20+, Git, the Claude Code CLI and Tailscale, and offers to install what's
     missing (winget first, the official installers otherwise)
  2. checks that Claude Code is signed in, and offers to sign in
  3. installs the app's packages (npm ci) and builds it (npm run build)
  4. creates your workspace (default %USERPROFILE%\Hearth) with a starter CLAUDE.md and memory/,
     as the first floor, and tells Claude Code to trust that folder
  5. sets the password your phone signs in with (yours, or a generated one it shows you)
  6. optionally starts Hearth when you sign in to Windows (a hidden per-user scheduled task), and
     adds Start Menu and desktop shortcuts
  7. starts Hearth, brings Tailscale up and shares the app on your tailnet with `tailscale serve`
  8. prints the address to open on your phone

Actions (the helper .bat files run these):
  install    (default) everything above
  start      start Hearth in the background (and -Open the browser)
  stop       stop Hearth and its agents
  restart    stop, then start
  status     is it running, and where
  doctor     check every requirement and the running app, and print fixes
  update     get the newest version (git pull, or the ZIP), rebuild, restart
  password   set a new sign-in password
  uninstall  stop it and remove the logon task, the shortcuts and the Tailscale share
             (your workspace and this folder stay; it tells you what to delete by hand)

Options:
  -Edition hearth|hq   which app this is (normally detected; hq = Hearth HQ, the 3D office)
  -Port <n>            port on this PC (default 4600 for Hearth, 4610 for Hearth HQ)
  -Workspace <dir>     your workspace folder (default %USERPROFILE%\Hearth or \HearthHQ)
  -InstallDir <dir>    where the one-line install puts the app (default %LOCALAPPDATA%\Programs\Hearth)
  -NoTailscale         don't install, start or configure Tailscale (this PC only)
  -NoAutostart         don't start Hearth at sign-in (and don't ask); -Autostart: do, without asking
  -NoShortcut          no Start Menu or desktop shortcuts; -NoDesktopShortcut: Start Menu only
  -NoStart             set everything up but don't start it
  -ResetPassword       ask for (or generate) a new password even if one is set
  -Yes                 unattended: take the default for every question, install what's missing
  -DryRun              report what it would do, change nothing
  -Force               reinstall packages and rebuild even when they look up to date

Environment (for the one-line install, which can't take options): HEARTH_EDITION, HEARTH_PORT,
HEARTH_WORKSPACE, HEARTH_INSTALL_DIR, HEARTH_YES=1, HEARTH_DRY_RUN=1, HEARTH_NO_TAILSCALE=1,
HEARTH_NO_AUTOSTART=1, and HEARTH_PASSWORD (the sign-in password, instead of being asked).
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'doctor', 'update', 'password', 'uninstall')]
    [string]$Action = 'install',
    [string]$Edition = '',
    [int]$Port = 0,
    [string]$Workspace = '',
    [string]$InstallDir = '',
    [switch]$NoTailscale,
    [switch]$NoAutostart,
    [switch]$Autostart,
    [switch]$NoShortcut,
    [switch]$NoDesktopShortcut,
    [switch]$NoStart,
    [switch]$ResetPassword,
    [switch]$Open,
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$Force,
    # The checkout to work on. update.bat passes it, because it runs a copy of this script from %TEMP%
    # (git pull rewrites this file while it runs).
    [string]$Repo = ''
)

# The export fills these in for each repo. Left as they are (a development checkout), the edition is
# worked out from package.json and the git remote.
$BakedEdition = 'hq'
# The options as given, for handing on to another copy of this script (the bootstrap).
$ScriptParams = @{} + $PSBoundParameters
# This file's path when it runs as a script file; empty under `irm | iex` (and in a scriptblock).
$ScriptPath = if ($MyInvocation.MyCommand.CommandType -eq 'ExternalScript') { $MyInvocation.MyCommand.Path } else { '' }
$BakedRepo = 'DatafyingTech/Hearth-HQ'

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Editions = @{
    hearth = @{ Name = 'Hearth'; Port = 4600; Workspace = 'Hearth'; Task = 'Hearth'; Repo = 'DatafyingTech/Hearth'; AppDir = 'Hearth' }
    hq     = @{ Name = 'Hearth HQ'; Port = 4610; Workspace = 'HearthHQ'; Task = 'Hearth HQ'; Repo = 'DatafyingTech/Hearth-HQ'; AppDir = 'Hearth-HQ' }
}

# ------------------------------------------------------------------ output and questions
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    [ok]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Bad($msg) { Write-Host "    [fail] $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Fix($msg) { Write-Host "           fix: $msg" -ForegroundColor Yellow }

# Stops the install with a message. A throw, not exit: under `irm | iex` exit would close the
# PowerShell window the line was pasted into.
function Die($msg, $hint) {
    Write-Host ''
    Write-Host '  STOPPED' -ForegroundColor Red
    Write-Host "  $msg" -ForegroundColor Red
    if ($hint) { Write-Host "  -> $hint" -ForegroundColor Yellow }
    throw 'HEARTH_STOPPED'
}

function Test-Truthy($v) { return ($v -and $v -ne '0' -and $v -ne 'false') }

# Under `install.bat < nul`, a CI job or a remote-management tool, [Environment]::UserInteractive is
# still true and Read-Host returns "" at once, so a question that defaults to yes would quietly
# install things nobody asked for. Only ask when there is a real console to answer from.
function Test-CanPrompt {
    $redirected = $false
    try { $redirected = [Console]::IsInputRedirected } catch { $redirected = ($Host.Name -ne 'ConsoleHost') }
    return ([Environment]::UserInteractive -and -not $redirected)
}

# A yes/no question. -Yes takes the default. With nobody to answer, the default stands, except for
# installing software ($Big), which is never done without a yes or -Yes.
function Ask([string]$question, [bool]$default = $true, [switch]$Big) {
    if ($script:Unattended) { return $default -or $Big }
    if (-not (Test-CanPrompt)) { return ($default -and -not $Big) }
    $hint = if ($default) { 'Y/n' } else { 'y/N' }
    $a = Read-Host "    $question [$hint]"
    if ($a -match '^\s*$') { return $default }
    return ($a -match '^\s*[yY]')
}

# Every change goes through here, so -DryRun can report it instead.
function Change([string]$what, [scriptblock]$do) {
    if ($script:Dry) { Write-Host "    [dry-run] would $what" -ForegroundColor Magenta; return $null }
    return (& $do)
}

# ------------------------------------------------------------------ processes and paths
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
    foreach ($extra in @("$env:ProgramFiles\nodejs", "$env:ProgramFiles\Git\cmd", "$env:ProgramFiles\Tailscale", "$env:USERPROFILE\.local\bin")) {
        if ((Test-Path -LiteralPath $extra) -and -not (($env:Path -split ';') -contains $extra)) { $env:Path = "$env:Path;$extra" }
    }
}

# The first match that is a real program: never a .ps1 (the execution policy may block it).
function Find-Exe([string]$name, [string[]]$also = @()) {
    foreach ($p in $also) { if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p } }
    $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

function Quote-Arg([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    return '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# Runs a program and captures what it prints, giving up after $timeoutSec (a `tailscale serve` that
# waits for someone to approve it in a browser, a hung CLI). Never throws.
function Invoke-Capture([string]$exe, [string[]]$argv, [int]$timeoutSec = 30, [string]$stdin = $null) {
    $r = [pscustomobject]@{ Code = -1; Out = ''; Err = ''; TimedOut = $false }
    try {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        $psi.Arguments = (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardInput = ($null -ne $stdin)
        $psi.CreateNoWindow = $true
        $p = [Diagnostics.Process]::Start($psi)
        if ($null -ne $stdin) {
            # Raw UTF-8 bytes: the StandardInput writer starts with a byte-order mark when the console
            # is in UTF-8, and that mark would become part of a password.
            $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($stdin)
            $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
            $p.StandardInput.Close()
        }
        $o = $p.StandardOutput.ReadToEndAsync()
        $e = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($timeoutSec * 1000)) {
            $r.TimedOut = $true
            try { $p.Kill() } catch {}
        } else { $p.WaitForExit(); $r.Code = $p.ExitCode }
        try { $r.Out = $o.Result; $r.Err = $e.Result } catch {}
    } catch { $r.Err = $_.Exception.Message }
    return $r
}

# A native command with its output on the console. PowerShell 5.1 turns a native program's stderr
# into errors, which -ErrorAction Stop would make fatal, so it runs with Continue.
function Invoke-Loud([string]$exe, [string[]]$argv) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @argv | Out-Host } catch { Warn $_.Exception.Message } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

function Get-WingetExe { return (Find-Exe 'winget' @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe")) }

# Installs a package with winget. Returns $true when winget says it worked (or it was already there).
function Install-Winget([string]$id, [string]$label) {
    $winget = Get-WingetExe
    if (-not $winget) { Warn "Windows' package manager (winget) isn't available here, so $label can't be installed for you."; return $false }
    $ok = Change "install $label with: winget install --id $id --exact" {
        Info "Installing $label with winget (Windows may ask for permission)..."
        $code = Invoke-Loud $winget @('install', '--id', $id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
        Update-SessionPath
        # -1978335189 (0x8A15002B): already installed, nothing newer.
        return ($code -eq 0 -or $code -eq -1978335189)
    }
    return [bool]$ok
}

# Adds a folder to the user's PATH through the registry, keeping %VARIABLES% unexpanded
# ([Environment]::SetEnvironmentVariable would write the PATH back expanded).
function Add-UserPath([string]$dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $has = ($cur -split ';') | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $dir.TrimEnd('\') }
        if ($has) { return }
        Change "add $dir to your user PATH" {
            $key.SetValue('Path', ((@(($cur -split ';') | Where-Object { $_ }) + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
            # Setting and clearing a variable tells Explorer to reload the environment for new terminals.
            [Environment]::SetEnvironmentVariable('HEARTH_PATH_REFRESH', '1', 'User')
            [Environment]::SetEnvironmentVariable('HEARTH_PATH_REFRESH', $null, 'User')
            Ok "added $dir to your PATH (new terminals will see it)"
        } | Out-Null
    } finally { $key.Close() }
}

# ------------------------------------------------------------------ where am I
function Test-Checkout([string]$dir) {
    if (-not $dir) { return $false }
    return ((Test-Path -LiteralPath (Join-Path $dir 'package.json')) -and (Test-Path -LiteralPath (Join-Path $dir 'src\server\cli.ts')))
}

function Get-DetectedEdition([string]$root) {
    if ($BakedEdition -notmatch '^\{\{') { return $BakedEdition }
    try {
        $name = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).name
        if ($name -match 'hq') { return 'hq' }
        if ($name -match 'hearth') { return 'hearth' }
    } catch {}
    try {
        $remote = (Invoke-Capture 'git' @('-C', $root, 'remote', 'get-url', 'origin') 10).Out
        if ($remote -match 'hearth-hq') { return 'hq' }
    } catch {}
    return 'hearth'
}

$SettingsKeys = @('EDITION', 'PORT', 'WORKSPACE', 'AGENT', 'AGENT_ARGS', 'MAX_WORKERS', 'TAILSCALE', 'AUTOSTART', 'SHORTCUTS')

function Read-Settings([string]$root) {
    $s = @{}
    $f = Join-Path $root '.hearth\settings.env'
    if (Test-Path -LiteralPath $f) {
        foreach ($line in [IO.File]::ReadAllLines($f)) {
            if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$') { $s[$Matches[1]] = $Matches[2].Trim() }
        }
    }
    return $s
}

function Write-Settings([string]$root, [hashtable]$s) {
    $dir = Join-Path $root '.hearth'
    $lines = @('# Hearth settings, written by the installer. Edit, then run restart (stop.bat, start.bat).')
    foreach ($k in $SettingsKeys) { $lines += "$k=$($s[$k])" }
    Change "save settings to $dir\settings.env" {
        [IO.Directory]::CreateDirectory($dir) | Out-Null
        # The folder ignores itself, so it never shows up in git status or gets committed.
        [IO.File]::WriteAllText((Join-Path $dir '.gitignore'), "*`n", (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $dir 'settings.env'), (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    } | Out-Null
}

# ------------------------------------------------------------------ bootstrap (no checkout yet)
# Run as `irm ... | iex`, or saved on its own: fetch the app (git clone, or the ZIP without git),
# then run that copy's installer with the same options.
function Invoke-Bootstrap {
    $ed = $Edition
    if (-not $ed) { $ed = $env:HEARTH_EDITION }
    if (-not $ed -and $BakedEdition -notmatch '^\{\{') { $ed = $BakedEdition }
    if (-not $ed) { $ed = 'hearth' }
    if (-not $Editions.ContainsKey($ed)) { Die "-Edition is hearth or hq, not $ed" }
    $E = $Editions[$ed]
    $repo = if ($BakedRepo -notmatch '^\{\{') { $BakedRepo } else { $E.Repo }
    $dir = $InstallDir
    if (-not $dir) { $dir = $env:HEARTH_INSTALL_DIR }
    if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA "Programs\$($E.AppDir)" }
    $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir)

    Write-Host ''
    Write-Host "  $($E.Name) installer" -ForegroundColor White
    Step "Getting $($E.Name) (github.com/$repo) into $dir"
    Update-SessionPath
    $git = Find-Exe 'git'
    if (-not $git -and (Ask 'Git is not installed. Install it now with winget?' $true -Big)) {
        if (Install-Winget 'Git.Git' 'Git') { $git = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe") }
    }
    if (Test-Checkout $dir) {
        Ok 'already downloaded'
        if ($git -and (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
            Change "update it with: git -C `"$dir`" pull --ff-only" {
                if ((Invoke-Loud $git @('-C', $dir, 'pull', '--ff-only')) -ne 0) { Warn 'git pull did not succeed; carrying on with the copy that is there.' }
            } | Out-Null
        }
    } elseif ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force).Count -gt 0) {
        Die "$dir already exists and isn't a copy of $($E.Name)." 'Move it out of the way, or pass -InstallDir (or HEARTH_INSTALL_DIR) to install somewhere else.'
    } elseif ($git) {
        Change "clone https://github.com/$repo.git into $dir" {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $dir)) | Out-Null
            if ((Invoke-Loud $git @('clone', '--depth', '1', "https://github.com/$repo.git", $dir)) -ne 0) { Die 'git clone failed (see above).' 'Check your internet connection and try again.' }
        } | Out-Null
    } else {
        $zipUrl = "https://github.com/$repo/archive/refs/heads/main.zip"
        Change "download $zipUrl and unpack it into $dir" {
            $tmp = Join-Path ([IO.Path]::GetTempPath()) ("hearth-" + [guid]::NewGuid().ToString('N'))
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile "$tmp.zip"
                Expand-Archive -Path "$tmp.zip" -DestinationPath $tmp -Force
                $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
                [IO.Directory]::CreateDirectory($dir) | Out-Null
                Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $dir -Recurse -Force
            } catch { Die "Could not download $($E.Name): $($_.Exception.Message)" "Download $zipUrl yourself, extract it, and double-click install.bat inside." }
            finally { Remove-Item -LiteralPath "$tmp.zip", $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        } | Out-Null
    }
    if ($script:Dry -and -not (Test-Checkout $dir)) {
        Info "Dry run: nothing was downloaded, so the rest of the install can't be shown. Run it again inside a copy (install.bat -DryRun)."
        return 0
    }
    if (-not (Test-Checkout $dir)) { Die "The download finished but $dir doesn't look like $($E.Name)." }

    # The checkout's own installer, which may be newer than this one, with the same options.
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dir 'install.ps1'))
    foreach ($kv in $ScriptParams.GetEnumerator()) {
        if ($kv.Key -in @('Repo', 'InstallDir')) { continue }
        if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $argv += "-$($kv.Key)" } }
        else { $argv += "-$($kv.Key)"; $argv += [string]$kv.Value }
    }
    if (-not $Edition -and $ed) { $argv += '-Edition'; $argv += $ed }
    $ps = (Get-Process -Id $PID).Path
    & $ps @argv | Out-Host
    return $LASTEXITCODE
}

# ------------------------------------------------------------------ requirements
function Get-NodeMajor([string]$node) {
    if (-not $node) { return 0 }
    $r = Invoke-Capture $node @('-p', 'process.versions.node') 15
    if ($r.Code -ne 0) { return 0 }
    return [int](($r.Out.Trim() -split '\.')[0])
}

function Get-NodeExe { return (Find-Exe 'node' @("$env:ProgramFiles\nodejs\node.exe")) }
function Get-NpmCmd {
    $node = Get-NodeExe
    $also = @()
    if ($node) { $also += (Join-Path (Split-Path -Parent $node) 'npm.cmd') }
    return (Find-Exe 'npm' $also)
}
function Get-ClaudeExe { return (Find-Exe 'claude' @("$env:USERPROFILE\.local\bin\claude.exe")) }
function Get-TailscaleExe { return (Find-Exe 'tailscale' @("$env:ProgramFiles\Tailscale\tailscale.exe")) }

function Ensure-Node {
    $node = Get-NodeExe
    $major = Get-NodeMajor $node
    if ($major -ge 20) { Ok "Node.js $((Invoke-Capture $node @('-v') 10).Out.Trim()) ($node)"; return }
    if ($node) { Warn "Node.js $major is too old; $($script:E.Name) needs 20 or newer." } else { Warn 'Node.js is not installed.' }
    if (Ask 'Install Node.js LTS now with winget?' $true -Big) { Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS' | Out-Null }
    if ($script:Dry) { return }
    $node = Get-NodeExe
    if ((Get-NodeMajor $node) -lt 20) { Die 'Node.js 20 or newer is needed.' 'Install the LTS version from https://nodejs.org, open a new window, and run install.bat again.' }
    Ok "Node.js $((Invoke-Capture $node @('-v') 10).Out.Trim())"
}

function Ensure-Git {
    $git = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
    if ($git) { Ok "$((Invoke-Capture $git @('--version') 10).Out.Trim())"; return }
    Warn 'Git is not installed. Agents use it for every project, and Claude Code on Windows needs its Git Bash.'
    if (Ask 'Install Git now with winget?' $true -Big) { Install-Winget 'Git.Git' 'Git' | Out-Null }
    if ($script:Dry) { return }
    if (-not (Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe"))) { Die 'Git is needed.' 'Install it from https://git-scm.com/download/win, then run install.bat again.' }
    Ok 'Git installed'
}

function Ensure-Claude {
    $claude = Get-ClaudeExe
    if (-not $claude) {
        Warn 'The Claude Code CLI is not installed. It is what every agent runs.'
        if (Ask 'Install Claude Code now with its official installer (irm https://claude.ai/install.ps1 | iex)?' $true -Big) {
            Change 'install Claude Code: irm https://claude.ai/install.ps1 | iex' {
                $ps = (Get-Process -Id $PID).Path
                Invoke-Loud $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex') | Out-Null
                Update-SessionPath
            } | Out-Null
            Add-UserPath "$env:USERPROFILE\.local\bin"
        }
        if ($script:Dry) { return }
        $claude = Get-ClaudeExe
        if (-not $claude) { Die 'Claude Code is needed.' 'In PowerShell run: irm https://claude.ai/install.ps1 | iex   then run install.bat again. (https://docs.claude.com/claude-code)' }
    }
    $v = Invoke-Capture $claude @('--version') 30
    if ($v.Code -ne 0) { Die "Claude Code is installed ($claude) but 'claude --version' failed: $($v.Err.Trim())" 'Reinstall it: irm https://claude.ai/install.ps1 | iex' }
    Ok "Claude Code $($v.Out.Trim()) ($claude)"
    if ($claude -match '\.cmd$') { Warn "That's the npm version of Claude Code. The native one handles long prompts on Windows better: irm https://claude.ai/install.ps1 | iex" }
}

# $true signed in, $false not, $null can't tell (an old Claude Code without `auth status`).
function Test-ClaudeLogin {
    $claude = Get-ClaudeExe
    if (-not $claude) { return $false }
    $r = Invoke-Capture $claude @('auth', 'status', '--json') 30
    try { return [bool](($r.Out | ConvertFrom-Json).loggedIn) } catch {}
    if ($env:ANTHROPIC_API_KEY) { return $true }
    if (Test-Path -LiteralPath "$env:USERPROFILE\.claude\.credentials.json") { return $true }
    return $null
}

function Ensure-ClaudeLogin {
    if ($script:Dry -and -not (Get-ClaudeExe)) { return }
    $in = Test-ClaudeLogin
    if ($in -eq $true) { Ok 'Claude Code is signed in'; return }
    Warn 'Claude Code is not signed in yet, so agents cannot start.'
    if (-not $script:Unattended -and (Test-CanPrompt) -and (Ask 'Sign in now? (opens your browser)' $true)) {
        Change 'run: claude auth login' { Invoke-Loud (Get-ClaudeExe) @('auth', 'login') | Out-Null } | Out-Null
        if ((Test-ClaudeLogin) -eq $true) { Ok 'Claude Code is signed in'; return }
    }
    Info 'To sign in: open a new terminal, run  claude  once, and follow the login (a Claude Pro/Max plan or an API key).'
    Info 'Hearth installs fine without it; agents start working as soon as you have signed in.'
}

function Ensure-Tailscale {
    if ($script:NoTs) { Info 'Skipping Tailscale (-NoTailscale): Hearth will only be reachable from this PC.'; return }
    if (Get-TailscaleExe) { Ok "Tailscale $(((Invoke-Capture (Get-TailscaleExe) @('version') 15).Out -split "`n")[0].Trim())"; return }
    Warn 'Tailscale is not installed. It is the private network that lets your phone reach this PC from anywhere.'
    if (Ask 'Install Tailscale now with winget?' $true -Big) { Install-Winget 'Tailscale.Tailscale' 'Tailscale' | Out-Null }
    if ($script:Dry) { return }
    if (-not (Get-TailscaleExe)) {
        Warn 'Tailscale is still missing, so the phone step is skipped. Install it from https://tailscale.com/download/windows and run install.bat again.'
        $script:NoTs = $true
    }
}

# ------------------------------------------------------------------ the app
function Get-HearthProcesses {
    $rootN = ($script:Root.TrimEnd('\') + '\').Replace('/', '\').ToLowerInvariant()
    $wsN = $script:S.WORKSPACE
    if ($wsN) { $wsN = $wsN.TrimEnd('\').Replace('/', '\').ToLowerInvariant() }
    try { $all = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop) } catch { return @() }
    # This copy's runner, or this copy's office (and its terminal host) for this workspace. Never
    # anything else: another office on this PC is none of our business.
    return @($all | Where-Object {
        $cl = "$($_.CommandLine)".Replace('/', '\').ToLowerInvariant()
        $cl.Contains($rootN) -and ($cl.Contains($rootN + 'hearth.mjs') -or ($wsN -and $cl.Contains($wsN)))
    })
}

function Test-Health([int]$p) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-PortOwner([int]$p) {
    try {
        # Only listeners that collide with ours on 127.0.0.1. tailscaled itself listens on the
        # tailnet address at the same port once `tailscale serve` shares it, and that's expected.
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') } | Select-Object -First 1
        if ($c) { return (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue) }
    } catch {}
    return $null
}

function Get-Task { try { return (Get-ScheduledTask -TaskName $script:E.Task -ErrorAction Stop) } catch { return $null } }

function Start-Hearth([switch]$Quiet) {
    $port = [int]$script:S.PORT
    if (Test-Health $port) { if (-not $Quiet) { Ok "$($script:E.Name) is already running on port $port" }; return $true }
    $owner = Get-PortOwner $port
    if ($owner) { Bad "Port $port is in use by $($owner.ProcessName) (pid $($owner.Id))."; Fix "close it, or run install.bat -Port <another port>"; return $false }
    $node = Get-NodeExe
    $task = Get-Task
    Change "start $($script:E.Name) on port $port" {
        if ($task) { Start-ScheduledTask -TaskName $script:E.Task }
        else { Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $script:Root 'hearth.mjs') + '"') -WorkingDirectory $script:Root -WindowStyle Hidden | Out-Null }
    } | Out-Null
    if ($script:Dry) { return $true }
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Health $port) { Ok "$($script:E.Name) is running: http://localhost:$port"; return $true }
        Start-Sleep -Seconds 1
    }
    Bad "$($script:E.Name) did not answer on port $port within 90 seconds."
    Fix "look at the end of $($script:Root)\.hearth\logs\hearth.log, or run doctor.bat"
    return $false
}

function Stop-Hearth([switch]$Quiet) {
    $task = Get-Task
    $procs = Get-HearthProcesses
    if (-not $procs.Count -and -not ($task -and $task.State -eq 'Running')) { if (-not $Quiet) { Ok "$($script:E.Name) is not running" }; return }
    Change "stop $($script:E.Name) ($($procs.Count) process(es))" {
        # The task first, so Windows doesn't count the stop as a crash and restart it.
        if ($task -and $task.State -eq 'Running') { try { Stop-ScheduledTask -TaskName $script:E.Task } catch {} }
        foreach ($p in (Get-HearthProcesses)) {
            # /T takes the agents the office started with it.
            Invoke-Capture "$env:SystemRoot\System32\taskkill.exe" @('/PID', "$($p.ProcessId)", '/T', '/F') 30 | Out-Null
        }
        Start-Sleep -Milliseconds 800
        Ok "$($script:E.Name) stopped"
    } | Out-Null
}

function Build-App {
    $root = $script:Root
    $npm = Get-NpmCmd
    if (-not $npm -and -not $script:Dry) { Die 'npm was not found next to Node.js.' 'Reinstall Node.js LTS from https://nodejs.org.' }
    $state = Join-Path $root '.hearth'
    $lock = Join-Path $root 'package-lock.json'
    $lockHash = if (Test-Path -LiteralPath $lock) { (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash } else { 'none' }
    $depsStamp = Join-Path $state 'deps.stamp'
    $haveDeps = (Test-Path -LiteralPath (Join-Path $root 'node_modules')) -and (Test-Path -LiteralPath $depsStamp) -and ((Get-Content -Raw -LiteralPath $depsStamp).Trim() -eq $lockHash)
    # The build is current when it was made from exactly this code (git HEAD, or the lock + package.json).
    $head = (Invoke-Capture 'git' @('-C', $root, 'rev-parse', 'HEAD') 10).Out.Trim()
    if (-not $head) { $head = $lockHash + (Get-FileHash -LiteralPath (Join-Path $root 'package.json') -Algorithm SHA256).Hash }
    $buildStamp = Join-Path $state 'build.stamp'
    $haveBuild = (Test-Path -LiteralPath (Join-Path $root 'dist\server')) -and (Test-Path -LiteralPath $buildStamp) -and ((Get-Content -Raw -LiteralPath $buildStamp).Trim() -eq $head)
    if ($haveDeps -and $haveBuild -and -not $Force) { Ok 'packages installed and app built (up to date)'; return }

    # npm can't replace node-pty's native module while a running office holds it open.
    if ((Get-HearthProcesses).Count) { $script:WasRunning = $true; Stop-Hearth -Quiet }
    if (-not $haveDeps -or $Force) {
        Change 'install packages: npm ci' {
            Info 'Installing packages (npm ci). This takes a minute or two the first time...'
            $script:CiStarted = Get-Date
            Push-Location -LiteralPath $root
            try { $code = Invoke-Loud $npm @('ci', '--no-audit', '--no-fund', '--loglevel=error') } finally { Pop-Location }
            if ($code -ne 0) { Die 'npm ci failed (see above).' 'Check your internet connection, close anything using this folder, and run install.bat again.' }
            [IO.Directory]::CreateDirectory($state) | Out-Null
            [IO.File]::WriteAllText($depsStamp, $lockHash)
        } | Out-Null
    }
    # npm ci already builds when package.json's "prepare" script does; don't build twice.
    if (-not $script:Dry -and $script:CiStarted) {
        $d = Join-Path $root 'dist\server'
        if ((Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d).LastWriteTime -ge $script:CiStarted)) {
            [IO.File]::WriteAllText($buildStamp, $head)
            Ok 'app built (by npm ci)'
            $script:Rebuilt = $true
            return
        }
    }
    Change 'build the app: npm run build' {
        Info 'Building the app...'
        Push-Location -LiteralPath $root
        try { $code = Invoke-Loud $npm @('run', 'build') } finally { Pop-Location }
        if ($code -ne 0) { Die 'npm run build failed (see above).' 'Run doctor.bat, and open an issue with the last 30 lines above if it keeps failing.' }
        [IO.Directory]::CreateDirectory($state) | Out-Null
        [IO.File]::WriteAllText($buildStamp, $head)
        Ok 'app built'
    } | Out-Null
    $script:Rebuilt = $true
}

function Write-IfMissing([string]$file, [string]$text) {
    if (Test-Path -LiteralPath $file) { return }
    Change "create $file" {
        [IO.Directory]::CreateDirectory((Split-Path -Parent $file)) | Out-Null
        [IO.File]::WriteAllText($file, $text.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
    } | Out-Null
}

function Setup-Workspace {
    $ws = $script:S.WORKSPACE
    $name = $script:E.Name
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $fresh = -not (Test-Path -LiteralPath $ws)
    Change "create your workspace $ws" { [IO.Directory]::CreateDirectory($ws) | Out-Null } | Out-Null
    Write-IfMissing (Join-Path $ws 'CLAUDE.md') @"
# My $name

This folder is home base for your $name team: the Claude Code agents you talk to from your phone
or your computer. Everything they make for you lands here, in plain files you own.

Every agent reads this file before it starts work, so tell them about you. Edit it any time.

## About me
- Name: (your name)
- What I do: (your job, your business, your side projects)
- Where I am: (city and time zone)

## How I like to work
- Keep answers short and in plain words.
- Ask before spending money, sending a message for me, or deleting anything.
- (add your own rules: tone, tools you use, things never to touch)

## Where things go
- memory/CURRENT.md: a short summary of where things stand. Every teammate reads it.
- memory/log/: dated notes of what was learned and done, one file per day.
- memory/data/: facts the team builds up (CSV or JSON files).
- TODO.md: the running to-do list.
"@
    Write-IfMissing (Join-Path $ws 'memory\CURRENT.md') @"
# Where things stand (shared team memory)

Keep this short (under 60 lines) and current. Every teammate on this floor sees it with every message.
Details go in memory/log/ (dated) and memory/data/. Last updated: $today (setup).

## Right now
- $name was just installed. Say hello to the team and tell them about yourself (or edit CLAUDE.md).

## This week's priorities
- (add them here, or ask the Chief of Staff to keep them)

## Decisions and facts to remember
- (dated one-liners)
"@
    Write-IfMissing (Join-Path $ws 'memory\log\README.md') "Dated notes go here, one file per day: YYYY-MM-DD.md.`n"
    Write-IfMissing (Join-Path $ws 'memory\data\README.md') "Structured facts the team collects go here, as CSV or JSON.`n"
    Write-IfMissing (Join-Path $ws 'TODO.md') "# To do`n`n- [ ] Tell the team about yourself (edit CLAUDE.md)`n- [ ] Add $name to your phone's Home Screen`n"

    # Agents work in git worktrees of the workspace, so it must be a repository with a first commit.
    $git = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
    if ($git -and -not (Test-Path -LiteralPath (Join-Path $ws '.git'))) {
        Change "make $ws a git repository with a first commit" {
            Invoke-Capture $git @('-C', $ws, 'init', '-b', 'main') 30 | Out-Null
            Invoke-Capture $git @('-C', $ws, 'add', '-A') 30 | Out-Null
            # Named here, so it works before you've ever set up git (only this first commit uses it).
            $r = Invoke-Capture $git @('-C', $ws, '-c', 'user.name=Hearth', '-c', 'user.email=hearth@localhost', 'commit', '-q', '-m', 'Start my workspace') 30
            if ($r.Code -ne 0) { Warn "git commit in the workspace failed: $($r.Err.Trim())" }
        } | Out-Null
    }
    if ($script:Dry) { } elseif ($fresh) { Ok "workspace created: $ws" } else { Ok "workspace: $ws" }
    Trust-Workspace
}

# Claude Code asks "Is this a project you trust?" the first time it opens a folder, and its default
# answer is "No, exit". The office's agents run in the workspace with nobody there to answer, so the
# first teammate you hire would quit at once. The workspace is a folder this installer made for you,
# holding only the starter files above, so it's marked trusted, the same as answering yes once.
function Trust-Workspace {
    $node = Get-NodeExe
    if (-not $node) { return }
    $ws = $script:S.WORKSPACE
    $hm = @((Join-Path $script:Root 'hearth.mjs'), 'trust-workspace', '--workspace', $ws)
    $check = Invoke-Capture $node ($hm + '--check') 30
    if ($check.Code -eq 0) { Ok "Claude Code trusts the workspace"; return }
    if ($check.Code -eq 3) { Warn $check.Out.Trim(); return }
    Info "Telling Claude Code to trust $ws`: agents run there with nobody to answer its"
    Info "'Do you trust this folder?' question, whose default is 'No, exit'. It's the folder this installer made."
    if ($script:Dry) { Write-Host ("    [dry-run] " + (Invoke-Capture $node ($hm + '--dry-run') 30).Out.Trim()) -ForegroundColor Magenta; return }
    $r = Invoke-Capture $node $hm 60
    if ($r.Code -eq 0) { Ok "Claude Code trusts the workspace (~/.claude.json was backed up first)" } else { Warn $r.Out.Trim() }
}

function New-Password {
    # No look-alike letters (0/O, 1/l/I), in groups of four: easy to type on a phone.
    $chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'.ToCharArray()
    $bytes = New-Object byte[] 15
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $s = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    return ($s.Substring(0, 5) + '-' + $s.Substring(5, 5) + '-' + $s.Substring(10, 5))
}

function Ensure-Password([switch]$Reset) {
    $node = Get-NodeExe
    $hm = Join-Path $script:Root 'hearth.mjs'
    $status = if ($node -and (Test-Path -LiteralPath (Join-Path $script:Root '.hearth\settings.env'))) { (Invoke-Capture $node @($hm, 'password-status') 30).Out.Trim() } else { 'none' }
    if ($status -eq 'set' -and -not $Reset) { Ok 'a sign-in password is set (password.bat sets a new one)'; return }
    $pw = $env:HEARTH_PASSWORD
    $generated = $false
    if (-not $pw -and -not $script:Unattended -and (Test-CanPrompt)) {
        Info 'Choose the password you will sign in with on your phone (at least 8 characters),'
        Info 'or just press Enter to get a generated one.'
        while ($true) {
            $a = Read-Host '    Password' -AsSecureString
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
            if (-not $plain) { break }
            if ($plain.Length -lt 8) { Warn 'At least 8 characters, please.'; continue }
            $b = Read-Host '    Same password again' -AsSecureString
            $again = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
            if ($again -ne $plain) { Warn "Those didn't match. Try again."; continue }
            $pw = $plain
            break
        }
    }
    if (-not $pw) { $pw = New-Password; $generated = $true }
    $ok = Change 'save the sign-in password (only a hash of it is stored)' {
        $r = Invoke-Capture $node @($hm, 'set-password') 30 $pw
        if ($r.Code -ne 0) { Die "Could not save the password: $($r.Err.Trim())" }
        return $true
    }
    if ($ok) {
        $script:PasswordChanged = $true
        if ($generated) { $script:ShowPassword = $pw }
        Ok 'sign-in password saved'
    }
}

# A Start Menu / desktop icon from the app's own picture: an .ico can hold a PNG as it is.
function Get-Icon {
    $ico = Join-Path $script:Root '.hearth\hearth.ico'
    if (Test-Path -LiteralPath $ico) { return $ico }
    foreach ($png in @('src\client\public\hearth-192.png', 'dist\public\hearth-192.png')) {
        $f = Join-Path $script:Root $png
        if (-not (Test-Path -LiteralPath $f)) { continue }
        try {
            $data = [IO.File]::ReadAllBytes($f)
            $ms = New-Object IO.MemoryStream
            $w = New-Object IO.BinaryWriter($ms)
            $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
            # The size, from the PNG's own header (0 means 256).
            $pw = ([int]$data[18] -shl 8) + $data[19]; $ph = ([int]$data[22] -shl 8) + $data[23]
            $w.Write([byte]($pw % 256)); $w.Write([byte]($ph % 256)); $w.Write([byte]0); $w.Write([byte]0)
            $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$data.Length); $w.Write([uint32]22)
            $w.Write($data); $w.Flush()
            [IO.File]::WriteAllBytes($ico, $ms.ToArray())
            return $ico
        } catch { return $null }
    }
    return $null
}

function Get-ShortcutPaths {
    $name = $script:E.Name
    return @{
        Menu    = Join-Path ([Environment]::GetFolderPath('Programs')) "$name"
        Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"
    }
}

function New-Shortcut([string]$path, [string]$target, [string]$desc, [string]$icon) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($path)
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $script:Root
    $lnk.Description = $desc
    $lnk.WindowStyle = 7
    if ($icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
}

function Setup-Shortcuts {
    if ($NoShortcut -or ($script:S.SHORTCUTS -eq 'none' -and -not $NoDesktopShortcut)) { $script:S.SHORTCUTS = 'none'; Info 'No shortcuts (-NoShortcut).'; return }
    $name = $script:E.Name
    $paths = Get-ShortcutPaths
    $desktop = $script:S.SHORTCUTS -ne 'menu' -and -not $NoDesktopShortcut
    if (-not $script:S.SHORTCUTS -and -not $NoDesktopShortcut) { $desktop = Ask "Add a $name shortcut to your desktop too?" $true }
    $script:S.SHORTCUTS = if ($desktop) { 'both' } else { 'menu' }
    $icon = if ($script:Dry) { $null } else { Get-Icon }
    Change "add Start Menu shortcuts ($($paths.Menu))" {
        [IO.Directory]::CreateDirectory($paths.Menu) | Out-Null
        New-Shortcut (Join-Path $paths.Menu "$name.lnk") (Join-Path $script:Root 'start.bat') "Open $name (starts it if needed)" $icon
        New-Shortcut (Join-Path $paths.Menu "Stop $name.lnk") (Join-Path $script:Root 'stop.bat') "Stop $name" $icon
        New-Shortcut (Join-Path $paths.Menu "$name doctor.lnk") (Join-Path $script:Root 'doctor.bat') "Check $name's setup" $icon
    } | Out-Null
    if ($desktop) {
        Change "add a desktop shortcut ($($paths.Desktop))" { New-Shortcut $paths.Desktop (Join-Path $script:Root 'start.bat') "Open $name (starts it if needed)" $icon } | Out-Null
    }
    if (-not $script:Dry) { Ok ("shortcuts added: Start Menu" + $(if ($desktop) { ' and desktop' } else { '' })) }
}

function Remove-Shortcuts {
    $paths = Get-ShortcutPaths
    foreach ($p in @($paths.Menu, $paths.Desktop)) {
        if (Test-Path -LiteralPath $p) { Change "remove $p" { Remove-Item -LiteralPath $p -Recurse -Force } | Out-Null }
    }
}

function Register-Autostart {
    $name = $script:E.Name
    $node = Get-NodeExe
    $hm = Join-Path $script:Root 'hearth.mjs'
    Change "register the '$($script:E.Task)' logon task (hidden, restarts if it crashes)" {
        # conhost --headless runs node's console with no window. The task waits on it, so a crash (a
        # non-zero exit) is something Windows sees and restarts, every minute up to 10 times.
        $act = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$node`" `"$hm`"" -WorkingDirectory $script:Root
        $trig = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        # 30 s after sign-in, so the network and Tailscale are up first.
        $trig.Delay = 'PT30S'
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        $prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $script:E.Task -Action $act -Trigger $trig -Settings $set -Principal $prin `
            -Description "Starts $name ($($script:Root)) when you sign in, hidden. Made by its installer; uninstall.bat removes it." -Force | Out-Null
        Ok "$name will start by itself when you sign in to Windows"
    } | Out-Null
}

function Setup-Autostart {
    $name = $script:E.Name
    $want = $null
    if ($NoAutostart -or (Test-Truthy $env:HEARTH_NO_AUTOSTART)) { $want = $false }
    elseif ($Autostart) { $want = $true }
    elseif ($script:S.AUTOSTART -eq '1' -or $script:S.AUTOSTART -eq '0') { $want = ($script:S.AUTOSTART -eq '1') }
    else {
        Info "Signing out of Windows closes every app you own, so $name can't answer your phone until it's started again."
        $want = Ask "Start $name by itself whenever you sign in to Windows?" $true
    }
    $script:S.AUTOSTART = if ($want) { '1' } else { '0' }
    $task = Get-Task
    if ($want) { Register-Autostart }
    elseif ($task) { Change "remove the '$($script:E.Task)' logon task" { Unregister-ScheduledTask -TaskName $script:E.Task -Confirm:$false } | Out-Null }
    else { Info "Not starting at sign-in. Use the $name shortcut (or start.bat) to start it." }
}

# ------------------------------------------------------------------ Tailscale
function Get-TsInfo {
    $ts = Get-TailscaleExe
    if (-not $ts) { return $null }
    $env:HEARTH_TAILSCALE = $ts
    $r = Invoke-Capture (Get-NodeExe) @((Join-Path $script:Root 'hearth.mjs'), 'tailscale-info') 30
    $f = $r.Out.Trim() -split "`t"
    return [pscustomobject]@{ State = $f[0]; Dns = $(if ($f.Count -gt 1) { $f[1] } else { '' }); Ip = $(if ($f.Count -gt 2) { $f[2] } else { '' }) }
}

function Get-ServeTarget([int]$p) {
    $env:HEARTH_TAILSCALE = Get-TailscaleExe
    return (Invoke-Capture (Get-NodeExe) @((Join-Path $script:Root 'hearth.mjs'), 'serve-target', "$p") 30).Out.Trim()
}

function Setup-Tailscale {
    if ($script:NoTs) { return }
    $ts = Get-TailscaleExe
    if (-not $ts) { return }
    $port = [int]$script:S.PORT
    $info = Get-TsInfo
    if ($info.State -ne 'Running') {
        Info "Tailscale is $($info.State). Signing this PC in to your tailnet; a browser window opens for the login."
        Info 'Use the same account you will sign in with on your phone.'
        Change 'run: tailscale up' { Invoke-Loud $ts @('up', '--timeout=5m') | Out-Null } | Out-Null
        if (-not $script:Dry) { $info = Get-TsInfo }
        if ($info.State -ne 'Running' -and -not $script:Dry) {
            Warn 'Tailscale is not connected yet, so your phone cannot reach this PC.'
            Fix 'open Tailscale from the Start menu, sign in, then run install.bat again.'
            return
        }
    }
    if ($info.State -eq 'Running') { Ok "Tailscale is connected as $($info.Dns)" }
    $want = "http://127.0.0.1:$port"
    $have = Get-ServeTarget $port
    if ($have -eq $want) { Ok "tailscale serve already shares port $port"; return }
    if ($have) {
        Warn "Tailscale already serves port $port to $have; leaving it alone."
        Fix "pick another port (install.bat -Port <n>), or remove it with: tailscale serve --http=$port off"
        return
    }
    Change "share it on your tailnet: tailscale serve --bg --http=$port $want" {
        if ((Test-CanPrompt) -and -not $script:Unattended) {
            # Shown live: the first time, Tailscale may print a link to approve Serve for your tailnet,
            # and it waits until you have.
            $code = Invoke-Loud $ts @('serve', '--bg', '--yes', "--http=$port", $want)
        } else {
            $r = Invoke-Capture $ts @('serve', '--bg', '--yes', "--http=$port", $want) 60
            if ($r.Out.Trim() -or $r.Err.Trim()) { Info ($r.Out + $r.Err).Trim() }
            $code = $r.Code
        }
        if ((Get-ServeTarget $port) -eq $want) { Ok "shared on your tailnet (port $port)" }
        else {
            Warn "tailscale serve did not take (exit $code)."
            Fix "if it printed a login.tailscale.com link, open it to allow Serve, then run install.bat again;"
            Fix "or run this yourself in a terminal opened as administrator: tailscale serve --bg --http=$port $want"
        }
    } | Out-Null
}

function Remove-Serve {
    $ts = Get-TailscaleExe
    if (-not $ts) { return }
    $port = [int]$script:S.PORT
    if ((Get-ServeTarget $port) -eq "http://127.0.0.1:$port") {
        Change "remove the Tailscale share: tailscale serve --http=$port off" {
            Invoke-Capture $ts @('serve', "--http=$port", 'off') 30 | Out-Null
            Ok "Tailscale no longer shares port $port"
        } | Out-Null
    }
}

# ------------------------------------------------------------------ summary
function Show-Summary {
    $name = $script:E.Name
    $port = [int]$script:S.PORT
    Write-Host ''
    Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
    Write-Host "  $name is ready." -ForegroundColor Green
    Write-Host ''
    Write-Host "  On this PC:   http://localhost:$port" -ForegroundColor White
    $info = if (-not $script:NoTs) { Get-TsInfo } else { $null }
    if ($info -and $info.Dns -and $info.State -eq 'Running') {
        Write-Host "  On your phone: http://$($info.Dns):$port/app" -ForegroundColor White
        # The share answers to the machine's Tailscale name only (a 100.x address gets a 404), so no IP fallback.
        Info "   (if that name doesn't load on the phone, turn on MagicDNS in Tailscale's admin console)"
        Write-Host ''
        Info '  1. Install Tailscale on your phone (App Store / Google Play) and sign in with the same account.'
        Info '  2. Open the address above in Safari (iPhone) or Chrome (Android) and sign in with your password.'
        Info "  3. Add it to your Home Screen: iPhone: Share, then 'Add to Home Screen'."
        Info "                                 Android: the three-dot menu, then 'Add to Home screen' (or 'Install app')."
    } elseif (-not $script:NoTs) {
        Info '  Your phone address appears once Tailscale is connected: run install.bat again after signing in.'
    }
    Write-Host ''
    if ($script:ShowPassword) {
        Write-Host "  Your sign-in password: $($script:ShowPassword)" -ForegroundColor Yellow
        Info '  Write it down now: it is stored only as a hash and will not be shown again (password.bat makes a new one).'
        try { Set-Clipboard -Value $script:ShowPassword; Info '  (It is also on your clipboard.)' } catch {}
    } else {
        Info '  Sign in with the password you chose (password.bat sets a new one).'
    }
    Write-Host ''
    Info "  Your workspace: $($script:S.WORKSPACE)"
    Info "  In this folder: start.bat, stop.bat, doctor.bat (checks everything), update.bat, uninstall.bat"
    Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
}

# ------------------------------------------------------------------ doctor
function Invoke-Doctor {
    $name = $script:E.Name
    $fails = 0
    $port = [int]$script:S.PORT
    Step "$name doctor: $($script:Root)"

    $node = Get-NodeExe
    $major = Get-NodeMajor $node
    if ($major -ge 20) { Ok "Node.js $major ($node)" } else { Bad "Node.js 20+ not found"; Fix 'winget install OpenJS.NodeJS.LTS  (or https://nodejs.org), then run install.bat'; $fails++ }
    if (Get-NpmCmd) { Ok 'npm' } else { Bad 'npm not found'; Fix 'reinstall Node.js LTS'; $fails++ }
    $git = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
    if ($git) { Ok (Invoke-Capture $git @('--version') 10).Out.Trim() } else { Bad 'Git not found'; Fix 'winget install Git.Git'; $fails++ }
    $claude = Get-ClaudeExe
    if ($claude) {
        $v = Invoke-Capture $claude @('--version') 30
        if ($v.Code -eq 0) { Ok "Claude Code $($v.Out.Trim()) ($claude)" } else { Bad "claude --version failed"; Fix 'irm https://claude.ai/install.ps1 | iex'; $fails++ }
        $in = Test-ClaudeLogin
        if ($in -eq $true) { Ok 'Claude Code is signed in' }
        elseif ($in -eq $false) { Bad 'Claude Code is not signed in'; Fix 'open a terminal, run  claude  and log in'; $fails++ }
        else { Warn "couldn't tell whether Claude Code is signed in"; Fix 'run  claude  once in a terminal to check' }
    } else { Bad 'Claude Code not found'; Fix 'irm https://claude.ai/install.ps1 | iex'; $fails++ }

    if (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules')) { Ok 'packages installed' } else { Bad 'packages not installed'; Fix 'run install.bat'; $fails++ }
    if (Test-Path -LiteralPath (Join-Path $script:Root 'dist\server')) { Ok 'app built' } else { Bad 'app not built'; Fix 'run install.bat (or npm run build)'; $fails++ }

    if (-not $script:HasSettings) { Bad 'not installed yet (no .hearth\settings.env)'; Fix 'run install.bat'; return 1 }
    $ws = $script:S.WORKSPACE
    if (Test-Path -LiteralPath $ws) { Ok "workspace $ws" } else { Bad "workspace $ws is missing"; Fix 'run install.bat to recreate it'; $fails++ }
    if (Test-Path -LiteralPath (Join-Path $ws '.git')) { Ok 'workspace is a git repository' } else { Bad 'workspace is not a git repository (agents need one)'; Fix "run install.bat, or: git -C `"$ws`" init"; $fails++ }
    $hm = Join-Path $script:Root 'hearth.mjs'
    if ($node) {
        $t = Invoke-Capture $node @($hm, 'trust-workspace', '--check', '--workspace', $ws) 30
        if ($t.Code -eq 0) { Ok 'Claude Code trusts the workspace' }
        else {
            Bad "Claude Code doesn't trust the workspace yet: agents would stop at its 'Do you trust this folder?' question ($($t.Out.Trim()))"
            Fix 'doctor.bat -Force marks it trusted (stop Hearth first), or run  claude  in the workspace once and answer yes'
            $fails++
            if ($Force -and (Ask "Mark $ws as trusted in ~/.claude.json now?" $true)) { Trust-Workspace }
        }
        $pw = (Invoke-Capture $node @($hm, 'password-status') 30).Out.Trim()
        if ($pw -eq 'set') { Ok 'sign-in password set' } elseif ($pw -eq 'generated') { Warn 'the office generated its own password'; Fix 'password.bat sets one you know' } else { Bad 'no sign-in password'; Fix 'password.bat'; $fails++ }
    }

    $task = Get-Task
    if ($task) { Ok "logon task '$($script:E.Task)': $($task.State)" } elseif ($script:S.AUTOSTART -eq '1') { Bad 'the logon task is missing'; Fix 'run install.bat -Autostart'; $fails++ } else { Info "      no logon task (start it with start.bat)" }
    $procs = Get-HearthProcesses
    if (Test-Health $port) { Ok "running: http://localhost:$port answers ($($procs.Count) process(es))" }
    else {
        $owner = Get-PortOwner $port
        if ($owner) { Bad "port $port is taken by $($owner.ProcessName) (pid $($owner.Id)), not $name"; Fix "close it, or install.bat -Port <another>" }
        else { Bad "not running"; Fix 'start.bat (then look at .hearth\logs\hearth.log if it stops again)' }
        $fails++
    }

    if ($script:S.TAILSCALE -eq '0') { Info '      Tailscale is off for this install (-NoTailscale)' }
    else {
        $ts = Get-TailscaleExe
        if (-not $ts) { Bad 'Tailscale not installed (your phone cannot reach this PC)'; Fix 'winget install Tailscale.Tailscale, then install.bat'; $fails++ }
        else {
            $info = Get-TsInfo
            if ($info.State -eq 'Running') { Ok "Tailscale connected as $($info.Dns)" } else { Bad "Tailscale is $($info.State)"; Fix 'open Tailscale and sign in (or run: tailscale up)'; $fails++ }
            $want = "http://127.0.0.1:$port"
            $have = Get-ServeTarget $port
            if ($have -eq $want) { Ok "tailscale serve shares port $port -> phone: http://$($info.Dns):$port/app" }
            elseif ($have) { Bad "tailscale serve sends port $port to $have, not $name"; Fix "tailscale serve --http=$port off, then install.bat"; $fails++ }
            else { Bad "port $port is not shared on your tailnet"; Fix "tailscale serve --bg --http=$port $want   (or run install.bat)"; $fails++ }
        }
    }

    $log = Join-Path $script:Root '.hearth\logs\hearth.log'
    if (Test-Path -LiteralPath $log) {
        $errs = @(Get-Content -LiteralPath $log -Tail 200 | Where-Object { $_ -match 'error|EADDRINUSE|unhandled' } | Select-Object -Last 5)
        if ($errs.Count) { Warn 'recent errors in .hearth\logs\hearth.log:'; $errs | ForEach-Object { Info "        $_" } }
    }
    Write-Host ''
    if ($fails) { Write-Host "  $fails problem(s) found; the fixes are listed above." -ForegroundColor Yellow } else { Write-Host '  Everything looks good.' -ForegroundColor Green }
    return [int]($fails -gt 0)
}

# ------------------------------------------------------------------ update and uninstall
function Invoke-Update {
    $root = $script:Root
    Step "Updating $($script:E.Name) in $root"
    $git = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
    $pulled = $false
    if ($git -and (Test-Path -LiteralPath (Join-Path $root '.git'))) {
        $before = (Invoke-Capture $git @('-C', $root, 'rev-parse', '--short', 'HEAD') 10).Out.Trim()
        $code = Change 'git pull --ff-only' { Invoke-Loud $git @('-C', $root, 'pull', '--ff-only') }
        if ($script:Dry -or $code -eq 0) {
            $pulled = $true
            $after = (Invoke-Capture $git @('-C', $root, 'rev-parse', '--short', 'HEAD') 10).Out.Trim()
            if ($before -eq $after) { Ok "already the newest ($after)" } else { Ok "updated $before -> $after" }
        } else { Warn 'git pull --ff-only did not succeed (local changes?); trying the ZIP instead.' }
    }
    if (-not $pulled) {
        $repo = if ($BakedRepo -notmatch '^\{\{') { $BakedRepo } else { $script:E.Repo }
        $zipUrl = "https://github.com/$repo/archive/refs/heads/main.zip"
        Change "download $zipUrl over $root (your settings and workspace are not in it)" {
            $tmp = Join-Path ([IO.Path]::GetTempPath()) ("hearth-" + [guid]::NewGuid().ToString('N'))
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile "$tmp.zip"
                Expand-Archive -Path "$tmp.zip" -DestinationPath $tmp -Force
                $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
                Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $root -Recurse -Force
                Ok 'files updated from the ZIP'
            } catch { Die "Could not download the update: $($_.Exception.Message)" }
            finally { Remove-Item -LiteralPath "$tmp.zip", $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        } | Out-Null
    }
    # The rest is the new version's installer, with the settings you already chose and no questions.
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'install.ps1'), '-Action', 'install', '-Yes')
    if ($script:Dry) { $argv += '-DryRun' }
    if ($Force) { $argv += '-Force' }
    $ps = (Get-Process -Id $PID).Path
    & $ps @argv | Out-Host
    return $LASTEXITCODE
}

function Invoke-Uninstall {
    $name = $script:E.Name
    Step "Uninstalling $name from this PC"
    Stop-Hearth
    if (Get-Task) { Change "remove the '$($script:E.Task)' logon task" { Unregister-ScheduledTask -TaskName $script:E.Task -Confirm:$false; Ok 'logon task removed' } | Out-Null }
    Remove-Shortcuts
    if ($script:HasSettings) { Remove-Serve }
    Write-Host ''
    Info "Left in place, for you to delete by hand if you want:"
    Info "  your workspace and everything the team made: $($script:S.WORKSPACE)"
    Info "  the app itself: $($script:Root)"
    Info "  Node.js, Git, Claude Code and Tailscale (Settings > Apps, if you only installed them for $name)"
    return 0
}

# ------------------------------------------------------------------ main
function Invoke-Main {
    $script:Dry = $DryRun -or (Test-Truthy $env:HEARTH_DRY_RUN)
    $script:Unattended = $Yes -or (Test-Truthy $env:HEARTH_YES)
    if ($script:Dry) { Write-Host '  DRY RUN: checking only, nothing will be changed.' -ForegroundColor Magenta }

    $root = $null
    if ($Repo) { $root = (Resolve-Path -LiteralPath $Repo).Path }
    elseif ($ScriptPath) { $root = Split-Path -Parent $ScriptPath }
    if (-not (Test-Checkout $root)) {
        if ($Action -ne 'install') { Die "This isn't inside a copy of Hearth ($root)." 'Run it from the folder you installed Hearth into.' }
        return (Invoke-Bootstrap)
    }
    $script:Root = $root
    Update-SessionPath

    $saved = Read-Settings $root
    $script:HasSettings = $saved.Count -gt 0
    $ed = $Edition
    if (-not $ed) { $ed = $env:HEARTH_EDITION }
    if (-not $ed) { $ed = $saved.EDITION }
    if (-not $ed) { $ed = Get-DetectedEdition $root }
    if (-not $Editions.ContainsKey($ed)) { Die "-Edition is hearth or hq, not $ed" }
    $script:E = $Editions[$ed]

    $S = @{}
    foreach ($k in $SettingsKeys) { $S[$k] = $saved[$k] }
    $S.EDITION = $ed
    $p = $Port
    if (-not $p -and $env:HEARTH_PORT) { $p = [int]$env:HEARTH_PORT }
    if (-not $p -and $saved.PORT) { $p = [int]$saved.PORT }
    if (-not $p) { $p = $script:E.Port }
    if ($p -lt 1 -or $p -gt 65535) { Die "-Port must be 1-65535, not $p" }
    $S.PORT = "$p"
    $ws = $Workspace
    if (-not $ws) { $ws = $env:HEARTH_WORKSPACE }
    if (-not $ws) { $ws = $saved.WORKSPACE }
    if (-not $ws) { $ws = Join-Path $env:USERPROFILE $script:E.Workspace }
    $S.WORKSPACE = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ws).TrimEnd('\')
    $script:NoTs = $NoTailscale -or (Test-Truthy $env:HEARTH_NO_TAILSCALE) -or ($saved.TAILSCALE -eq '0' -and $Action -ne 'install')
    $S.TAILSCALE = if ($script:NoTs) { '0' } else { '1' }
    $script:S = $S

    switch ($Action) {
        'start' {
            if (-not $script:HasSettings) { Die 'Hearth is not installed yet.' 'Double-click install.bat first.' }
            $ok = Start-Hearth
            if ($ok -and $Open -and -not $script:Dry) { Start-Process "http://localhost:$($S.PORT)/" }
            return [int](-not $ok)
        }
        'stop' { Stop-Hearth; return 0 }
        'restart' { Stop-Hearth; return [int](-not (Start-Hearth)) }
        'status' {
            $up = Test-Health ([int]$S.PORT)
            Write-Host "  $($script:E.Name): $(if ($up) { 'running' } else { 'not running' }) on port $($S.PORT); workspace $($S.WORKSPACE)"
            return [int](-not $up)
        }
        'doctor' { return (Invoke-Doctor) }
        'update' { return (Invoke-Update) }
        'uninstall' { return (Invoke-Uninstall) }
        'password' {
            if (-not $script:HasSettings) { Die 'Hearth is not installed yet.' 'Double-click install.bat first.' }
            $running = Test-Health ([int]$S.PORT)
            Ensure-Password -Reset
            if ($running -and $script:PasswordChanged) { Info 'Restarting so the new password takes effect...'; Stop-Hearth -Quiet; Start-Hearth | Out-Null }
            if ($script:ShowPassword) { Write-Host "`n  Your new sign-in password: $($script:ShowPassword)" -ForegroundColor Yellow }
            return 0
        }
    }

    # ---- install
    Write-Host ''
    Write-Host "  $($script:E.Name) installer" -ForegroundColor White
    Write-Host "  your own team of Claude Code agents, on this PC, in your pocket" -ForegroundColor DarkGray
    Info "app folder: $root"
    Info "workspace:  $($S.WORKSPACE)"
    Info "port:       $($S.PORT)"

    Step 'Checking this PC'
    if ([Environment]::OSVersion.Version.Major -lt 10) { Die 'Windows 10 or 11 is needed.' }
    if (-not [Environment]::Is64BitOperatingSystem) { Die 'A 64-bit Windows is needed.' }
    Ok "Windows $([Environment]::OSVersion.Version) 64-bit"
    if (Get-WingetExe) { Ok 'winget available (used to install anything missing)' } else { Info 'winget not found: anything missing has to be installed by hand (links are given).' }
    Ensure-Node
    Ensure-Git
    Ensure-Claude
    Ensure-ClaudeLogin
    Ensure-Tailscale

    Step 'Installing the app'
    $port = [int]$S.PORT
    $owner = Get-PortOwner $port
    if ($owner -and -not (Get-HearthProcesses).Count) {
        Die "Port $port is already in use by $($owner.ProcessName) (pid $($owner.Id))." "Close it, or choose another port: install.bat -Port $($port + 1)"
    }
    Build-App
    Write-Settings $root $S

    Step 'Your workspace'
    Setup-Workspace

    Step 'Sign-in password'
    Ensure-Password -Reset:$ResetPassword

    Step 'Starting with Windows, and shortcuts'
    Setup-Autostart
    Setup-Shortcuts
    Write-Settings $root $S

    if (-not $NoStart) {
        Step "Starting $($script:E.Name)"
        if ($script:PasswordChanged -or $script:Rebuilt) { Stop-Hearth -Quiet }
        $started = Start-Hearth
        if (-not $started -and -not $script:Dry) { Die "$($script:E.Name) did not start." 'Run doctor.bat to see why.' }
    } else { Info 'Not starting it (-NoStart). Use start.bat when you are ready.' }

    if (-not $script:NoTs) {
        Step 'Reaching it from your phone (Tailscale)'
        Setup-Tailscale
    }
    if ($script:Dry) { Write-Host "`n  Dry run finished: nothing was changed." -ForegroundColor Magenta; return 0 }
    Show-Summary
    return 0
}

$code = 1
try { $code = Invoke-Main }
catch {
    if ("$($_.Exception.Message)" -ne 'HEARTH_STOPPED') {
        Write-Host ''
        Write-Host "  Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  at $($_.InvocationInfo.PositionMessage)" -ForegroundColor DarkGray
    }
    $code = 1
}
# Run from a file: report the result. Under `irm | iex`, exit would close the user's window.
if ($ScriptPath) { exit ([int]$code) }
