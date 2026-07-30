# MindEase database backup script (Windows / PowerShell)
# Usage: .\scripts\backup.ps1 [-DbName mindease_db] [-OutDir backups] [-Retention 7]
param(
    [string]$DbName = "mindease_db",
    [string]$OutDir = "backups",
    [int]$Retention = 7
)

$MYSQLDUMP = "C:\laragon\bin\mysql\mysql-8.4.10-winx64\bin\mysqldump.exe"
if (-not (Test-Path $MYSQLDUMP)) {
    $MYSQLDUMP = (Get-Command mysqldump -ErrorAction SilentlyContinue).Source
    if (-not $MYSQLDUMP) { Write-Error "mysqldump not found. Update the path in this script."; exit 1 }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$file = Join-Path $OutDir "$DbName`_$stamp.sql"

& $MYSQLDUMP -u root --single-transaction --routines $DbName | Set-Content -Path $file -Encoding UTF8
if ($LASTEXITCODE -ne 0) { Write-Error "Backup failed"; exit 1 }

Write-Host "[OK] Backup written: $file ($([math]::Round((Get-Item $file).Length / 1MB, 2)) MB)"

# Retention: delete backups older than $Retention days
Get-ChildItem $OutDir -Filter "$DbName`_*.sql" | Where-Object {
    $_.LastWriteTime -lt (Get-Date).AddDays(-$Retention)
} | Remove-Item -Force

Write-Host "[OK] Retention applied (keep $Retention days)"
