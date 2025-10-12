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
$lastTag = git tag --list --sort=-version:refname | Select-Object -First 1

if ($lastTag -match "v?(\d+)") {
    $nextNumber = [int]$matches[1] + 1
    $nextVersion = "v$nextNumber"
} else {
    $nextVersion = "v1"
}

Write-Host "Next version: $nextVersion" -ForegroundColor Yellow

$confirm = Read-Host "Continue with commit '$msg' and tag $nextVersion? (y/N)"
if ($confirm -ne "y") {
    Write-Host "Cancelled" -ForegroundColor Red
    exit
}

if ($hasChanges) {
    Write-Host "Adding and committing..." -ForegroundColor Cyan
    git add .
    git commit -m $msg
}

Write-Host "Creating tag..." -ForegroundColor Cyan
git tag $nextVersion

Write-Host "Pushing..." -ForegroundColor Cyan
$branch = git branch --show-current

if ($hasChanges) {
    git push origin $branch
}
git push origin $nextVersion

Write-Host "Done! Created release $nextVersion" -ForegroundColor Green

$repoUrl = git remote get-url origin
$releaseUrl = $repoUrl -replace "\.git$", ""
Write-Host "Create GitHub Release: $releaseUrl/releases/new?tag=$nextVersion" -ForegroundColor Cyan