param([string]$msg = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = Read-Host "Enter commit / release message"
}

Write-Host "Setting Git config..." -ForegroundColor Cyan
git config user.name "Duugrim"
git config user.email "t.g.grovin@gmail.com"

function Assert-LastExitCode([string]$step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$step failed (exit code $LASTEXITCODE)"
    }
}

Write-Host "Checking status..." -ForegroundColor Cyan
$status = @(git status --porcelain)
$hasChanges = $status.Count -gt 0

if ($hasChanges) {
    Write-Host "Found changes" -ForegroundColor Green
    git status --short
} else {
    Write-Host "Working tree clean" -ForegroundColor DarkGray
}

Write-Host "Getting next version..." -ForegroundColor Cyan
$lastTag = git tag --list --sort=-version:refname | Where-Object { $_ -match "^v0\.\d+$" } | Select-Object -First 1

if ($lastTag -match "^v0\.(\d+)$") {
    $nextNumber = [int]$matches[1] + 1
} else {
    $nextNumber = 1
}

$nextVersion = "v0.$nextNumber"
$newVersion = "0.$nextNumber"

Write-Host "Next tag: $nextVersion" -ForegroundColor Yellow

# N -> делаем только commit/tag/push (для бекапа), без релиза и без обновления system.json
# y -> обновляем system.json (version/manifest/download) и создаём GitHub Release с ассетами
$createRelease = Read-Host "Update system.json to version $newVersion and create GitHub Release? (y/N)"
$shouldCreateRelease = $createRelease -eq "y"

$systemJsonPath = Join-Path $PSScriptRoot "system.json"

if ($shouldCreateRelease) {
    if (-not (Test-Path $systemJsonPath)) {
        throw "system.json not found at $systemJsonPath"
    }

    Write-Host "Updating system.json..." -ForegroundColor Cyan
    $systemJson = Get-Content $systemJsonPath -Raw | ConvertFrom-Json

    $systemJson.version = $newVersion

    # Стабильные URL для установки/обновлений через последнюю опубликованную GitHub Release
    $systemJson.manifest = "https://github.com/Duugrim/spaceholder/releases/latest/download/system.json"
    $systemJson.download = "https://github.com/Duugrim/spaceholder/releases/latest/download/spaceholder.zip"

    $jsonText = $systemJson | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText(
        $systemJsonPath,
        $jsonText + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false))
    )

    Write-Host "system.json updated:" -ForegroundColor Green
    Write-Host "  version:  $($systemJson.version)" -ForegroundColor Green
    Write-Host "  manifest: $($systemJson.manifest)" -ForegroundColor Green
    Write-Host "  download: $($systemJson.download)" -ForegroundColor Green
}

$didCommit = $false

if ($hasChanges -or $shouldCreateRelease) {
    Write-Host "Adding and committing (if needed)..." -ForegroundColor Cyan
    git add .

    git diff --cached --quiet
    switch ($LASTEXITCODE) {
        0 { $hasStagedChanges = $false }
        1 { $hasStagedChanges = $true }
        default { throw "git diff --cached --quiet failed (exit code $LASTEXITCODE)" }
    }

    if ($hasStagedChanges) {
        git commit -m $msg
        Assert-LastExitCode "git commit"
        $didCommit = $true
    } else {
        Write-Host "Nothing to commit" -ForegroundColor DarkGray
    }
}

Write-Host "Creating tag..." -ForegroundColor Cyan
$existingTag = (git tag --list $nextVersion)
if (-not [string]::IsNullOrWhiteSpace($existingTag)) {
    throw "Tag already exists: $nextVersion"
}

git tag $nextVersion
Assert-LastExitCode "git tag $nextVersion"

Write-Host "Pushing..." -ForegroundColor Cyan
$branch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
    throw "Could not determine current branch"
}

if ($didCommit) {
    git push origin $branch
    Assert-LastExitCode "git push origin $branch"
}

git push origin $nextVersion
Assert-LastExitCode "git push origin $nextVersion"

Write-Host "Done! Pushed tag $nextVersion" -ForegroundColor Green

if (-not $shouldCreateRelease) {
    Write-Host "Skipping GitHub Release creation (system.json not updated)" -ForegroundColor Yellow
    exit 0
}

Write-Host "Creating release artifacts..." -ForegroundColor Cyan
$zipFileName = "spaceholder.zip"
$zipPath = Join-Path $PSScriptRoot $zipFileName

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Собираем ZIP из содержимого тега. Это гарантирует, что в архив не попадёт .git и прочие незатреканные файлы.
git archive --format=zip --output $zipPath $nextVersion
Assert-LastExitCode "git archive"

Write-Host "Archive created: $zipFileName" -ForegroundColor Green

$ghInstalled = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghInstalled) {
    Write-Host "GitHub CLI (gh) not installed. Install it with: winget install GitHub.cli" -ForegroundColor Yellow
    Write-Host "Upload these files to the GitHub Release for $nextVersion:" -ForegroundColor Yellow
    Write-Host "  $zipPath" -ForegroundColor Yellow
    Write-Host "  $systemJsonPath" -ForegroundColor Yellow
    exit 0
}

Write-Host "Creating/Updating GitHub Release..." -ForegroundColor Cyan

# Если релиз уже существует — перезаливаем ассеты. Иначе — создаём новый релиз.
gh release view $nextVersion *> $null
$releaseExists = ($LASTEXITCODE -eq 0)

if (-not $releaseExists) {
    gh release create $nextVersion --title $nextVersion --notes $msg $zipPath $systemJsonPath
    Assert-LastExitCode "gh release create $nextVersion"
} else {
    gh release upload $nextVersion $zipPath $systemJsonPath --clobber
    Assert-LastExitCode "gh release upload $nextVersion"

    gh release edit $nextVersion --title $nextVersion --notes $msg
    Assert-LastExitCode "gh release edit $nextVersion"
}

Write-Host "GitHub Release ready: $nextVersion" -ForegroundColor Green
Remove-Item $zipPath -Force
