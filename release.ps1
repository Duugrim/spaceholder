param([string]$msg = "")

if ($msg -eq "") {
    $msg = Read-Host "Enter commit message"
}

Write-Host "Setting Git config..." -ForegroundColor Cyan
git config user.name "Duugrim"
git config user.email "t.g.grovin@gmail.com"

Write-Host "Checking status..." -ForegroundColor Cyan
$status = git status --porcelain
$hasChanges = $status -ne ""

if ($hasChanges) {
    Write-Host "Found changes" -ForegroundColor Green
    git status --short
}

Write-Host "Getting next version..." -ForegroundColor Cyan
$lastTag = git tag --list --sort=-version:refname | Where-Object { $_ -match "^re-v\d+$" } | Select-Object -First 1

if ($lastTag -match "^re-v(\d+)$") {
    $nextNumber = [int]$matches[1] + 1
    $nextVersion = "re-v$nextNumber"
} else {
    $nextVersion = "re-v2"
}

Write-Host "Next version: $nextVersion" -ForegroundColor Yellow

# Спрашиваем об обновлении версии в system.json
$updateVersion = Read-Host "Update version in system.json? (y/N)"
$shouldUpdateVersion = $updateVersion -eq "y"

if ($shouldUpdateVersion) {
    Write-Host "Reading current version from system.json..." -ForegroundColor Cyan
    $systemJsonPath = Join-Path $PSScriptRoot "system.json"
    $systemJson = Get-Content $systemJsonPath -Raw | ConvertFrom-Json
    $currentVersion = $systemJson.version
    Write-Host "Current version in system.json: $currentVersion" -ForegroundColor Yellow
    
    $newVersion = Read-Host "Enter new version for system.json"
    
    Write-Host "Updating system.json..." -ForegroundColor Cyan
    $systemJson.version = $newVersion
    $systemJson | ConvertTo-Json -Depth 10 | Set-Content $systemJsonPath
    
    Write-Host "Version updated to $newVersion" -ForegroundColor Green
}

if ($hasChanges -or $shouldUpdateVersion) {
    Write-Host "Adding and committing..." -ForegroundColor Cyan
    git add .
    git commit -m $msg
}

Write-Host "Creating tag..." -ForegroundColor Cyan
git tag $nextVersion

Write-Host "Pushing..." -ForegroundColor Cyan
$branch = git branch --show-current

if ($hasChanges -or $shouldUpdateVersion) {
    git push origin $branch
}
git push origin $nextVersion

Write-Host "Done! Pushed commit and tag $nextVersion" -ForegroundColor Green

if ($shouldUpdateVersion) {
    Write-Host "Creating GitHub Release..." -ForegroundColor Cyan
    
    # Проверяем, установлен ли GitHub CLI
    $ghInstalled = Get-Command gh -ErrorAction SilentlyContinue
    
    if ($ghInstalled) {
        gh release create $nextVersion --title $nextVersion --notes $msg
        Write-Host "GitHub Release created successfully!" -ForegroundColor Green
    } else {
        Write-Host "GitHub CLI (gh) not installed. Install it with: winget install GitHub.cli" -ForegroundColor Yellow
        $repoUrl = git remote get-url origin
        $releaseUrl = $repoUrl -replace "\.git$", ""
        Write-Host "Create GitHub Release manually: $releaseUrl/releases/new?tag=$nextVersion" -ForegroundColor Cyan
    }
} else {
    Write-Host "Skipping GitHub Release creation (version not updated)" -ForegroundColor Yellow
}
