# Respaldo completo de la base de PRODUCCIÓN (Railway) — SOLO LECTURA (pg_dump).
# Railway no tiene Backups activados en este proyecto: este es el respaldo antes de cada migración.
#
# Ejecutar desde la carpeta backend/ (lo ejecuta Carlos):
#   railway.cmd run --service Postgres powershell -ExecutionPolicy Bypass -File scripts/respaldo-produccion.ps1 -Nombre antes-de-X
#
# - Guarda en  Desktop\CENTRAL-respaldos\central-AAAA-MM-DD-HHMM-<Nombre>.dump  (formato custom de pg_dump)
# - La base "railway" incluye también las tablas de Kisses and Paws (kp_*): el archivo tiene datos
#   reales de clientes. No subirlo a git, a la nube ni compartirlo.
# - pg_dump debe ser de la misma versión mayor o superior a la de producción (Postgres 18).
# Restaurar (solo en caso de desastre y decidido por Carlos): pg_restore --clean --no-owner -d <URL> <archivo>
param([string]$Nombre = 'respaldo')
$ErrorActionPreference = 'Stop'

$url = $env:DATABASE_PUBLIC_URL
if (-not $url) { throw 'Falta DATABASE_PUBLIC_URL: ejecútalo con  railway.cmd run --service Postgres powershell -File scripts/respaldo-produccion.ps1' }

$pgdump = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
  Sort-Object { [double]($_.Name -replace '[^\d.]', '') } -Descending |
  ForEach-Object { Join-Path $_.FullName 'bin\pg_dump.exe' } |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pgdump) { throw 'No se encontró pg_dump.exe en C:\Program Files\PostgreSQL' }

$dest = Join-Path $env:USERPROFILE 'Desktop\CENTRAL-respaldos'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$safe = ($Nombre -replace '[^\w-]', '-')
$file = Join-Path $dest ('central-{0}-{1}.dump' -f (Get-Date -Format 'yyyy-MM-dd-HHmm'), $safe)

Write-Host "Respaldando producción con $pgdump …"
& $pgdump --format=custom --no-owner --no-privileges --file $file $url
if ($LASTEXITCODE -ne 0) { throw "pg_dump falló (código $LASTEXITCODE)" }

# Comprobación: el archivo se puede leer y tiene las tablas de CENTRAL
$pgrestore = Join-Path (Split-Path $pgdump) 'pg_restore.exe'
$tablas = & $pgrestore --list $file | Select-String -Pattern 'TABLE DATA public (tenants|orders|clients|messages) ' | Measure-Object
$mb = [math]::Round((Get-Item $file).Length / 1MB, 1)
if ($tablas.Count -lt 4) { throw "El respaldo $file no contiene las tablas esperadas de CENTRAL" }
Write-Host "Respaldo listo: $file ($mb MB, tablas de CENTRAL verificadas)"
