param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Destination = Join-Path $ProjectRoot 'src-tauri\resources\ffmpeg'
$ExpectedFiles = @('ffmpeg.exe', 'ffprobe.exe')

if (-not $Force -and ($ExpectedFiles | Where-Object { -not (Test-Path (Join-Path $Destination $_)) }).Count -eq 0) {
  $FfmpegExisting = Join-Path $Destination 'ffmpeg.exe'
  $FfprobeExisting = Join-Path $Destination 'ffprobe.exe'
  & $FfmpegExisting -hide_banner -version 2>$null | Out-Null
  $FfmpegExit = $LASTEXITCODE
  & $FfprobeExisting -hide_banner -version 2>$null | Out-Null
  $FfprobeExit = $LASTEXITCODE
  if ($FfmpegExit -eq 0 -and $FfprobeExit -eq 0) {
    Write-Host 'Bundled FFmpeg and FFprobe are already installed and launch successfully.' -ForegroundColor Green
    exit 0
  }
  Write-Host 'Existing FFmpeg runtime is incomplete; downloading a clean copy…' -ForegroundColor Yellow
}

# Pinned BtbN Windows x64 LGPL shared build. The shared variant keeps FFmpeg's
# LGPL DLLs beside the executables so downstream users can replace the DLLs.
$ArchiveUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49/ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-shared-9.0.zip'
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("jupiter-ffmpeg-" + [guid]::NewGuid().ToString('N'))
$Archive = Join-Path $TempRoot 'ffmpeg.zip'
$Extracted = Join-Path $TempRoot 'extract'

try {
  New-Item -ItemType Directory -Force -Path $TempRoot, $Destination | Out-Null
  Write-Host 'Downloading the FFmpeg 9.0.2 LGPL shared runtime…' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $Archive -UseBasicParsing
  Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force

  $Ffmpeg = Get-ChildItem -LiteralPath $Extracted -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
  if (-not $Ffmpeg) { throw 'The FFmpeg archive did not contain ffmpeg.exe.' }
  $BinDirectory = $Ffmpeg.Directory.FullName
  $Ffprobe = Join-Path $BinDirectory 'ffprobe.exe'
  if (-not (Test-Path $Ffprobe)) { throw 'The FFmpeg archive did not contain ffprobe.exe beside ffmpeg.exe.' }

  if (Test-Path $Destination) {
    Get-ChildItem -LiteralPath $Destination -Force | Remove-Item -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $BinDirectory -File | Copy-Item -Destination $Destination -Force

  # Preserve the upstream license/readme files in the app's bundled resource folder.
  Get-ChildItem -LiteralPath $Extracted -File -Recurse |
    Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Force }

  $VersionOutput = & (Join-Path $Destination 'ffmpeg.exe') -hide_banner -version 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $VersionOutput) { throw 'FFmpeg was copied but failed to launch. Check the bundled runtime DLLs.' }
  $Version = $VersionOutput | Select-Object -First 1
  $ProbeOutput = & (Join-Path $Destination 'ffprobe.exe') -hide_banner -version 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $ProbeOutput) { throw 'FFprobe was copied but failed to launch. Check the bundled runtime DLLs.' }
  Write-Host "Installed $Version" -ForegroundColor Green
  Write-Host "Runtime folder: $Destination"
}
finally {
  if (Test-Path $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
