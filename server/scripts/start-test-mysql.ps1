$ErrorActionPreference = "Continue"
$mysql = "D:\laragon\bin\mysql\mysql-9.6.0-winx64\bin\mysqld.exe"
$data = "D:\laragon\data\mysql-9.6"

$existing = Get-Process mysqld -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "mysqld already running (pid $($existing.Id -join ','))"
} else {
    $proc = Start-Process -FilePath $mysql `
        -ArgumentList "--datadir=`"$data`"", "--port=3306", "--bind-address=127.0.0.1", "--skip-networking=0" `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\mysqld-out.log" `
        -RedirectStandardError "$env:TEMP\mysqld-err.log"
    Start-Sleep -Seconds 15
    if ($proc.HasExited) {
        Write-Output "mysqld exited with code $($proc.ExitCode)"
        Get-Content "$env:TEMP\mysqld-err.log" -Tail 20 -ErrorAction SilentlyContinue
    } else {
        Write-Output "mysqld started, pid $($proc.Id)"
    }
}

$ok = Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Output "port 3306 reachable: $ok"
