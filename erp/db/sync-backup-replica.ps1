param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [Parameter(Mandatory = $true)]
  [string]$ReplicaDirectory,
  [Parameter(Mandatory = $true)]
  [ValidateSet('remote-machine','remote-account','offline-media')]
  [string]$StorageClass,
  [string]$EvidenceFile = ''
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

$sourceRoot = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))
$replicaRoot = [IO.Path]::GetFullPath($ReplicaDirectory).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))
if ($sourceRoot -eq $replicaRoot) { throw 'Replica directory must differ from the source backup directory.' }
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Source backup directory not found: $sourceRoot" }
New-Item -ItemType Directory -Force -Path $replicaRoot | Out-Null

$latest = Get-ChildItem -LiteralPath $sourceRoot -Filter 'wyerp-*.dump' -File |
  Where-Object {
    $_.Name -match '^wyerp-\d{8}T\d{6}Z\.dump$' -and
    (Test-Path -LiteralPath ($_.FullName + '.sha256') -PathType Leaf) -and
    (Test-Path -LiteralPath ($_.FullName + '.json') -PathType Leaf)
  } |
  Sort-Object Name -Descending |
  Select-Object -First 1
if (-not $latest) { throw 'No complete canonical PostgreSQL backup group was found.' }

$expected = ((Get-Content -LiteralPath ($latest.FullName + '.sha256') -Raw -Encoding ascii).Trim() -split '\s+')[0].ToLowerInvariant()
if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Source backup checksum evidence is invalid.' }
$actual = Get-Sha256 $latest.FullName
if ($actual -ne $expected) { throw 'Source backup checksum mismatch; replica copy aborted.' }

$tempDump = Join-Path $replicaRoot ($latest.Name + '.partial')
$tempHash = $tempDump + '.sha256'
$tempManifest = $tempDump + '.json'
foreach ($path in @($tempDump,$tempHash,$tempManifest)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
try {
  Copy-Item -LiteralPath $latest.FullName -Destination $tempDump -Force
  Copy-Item -LiteralPath ($latest.FullName + '.sha256') -Destination $tempHash -Force
  Copy-Item -LiteralPath ($latest.FullName + '.json') -Destination $tempManifest -Force
  $replicaHash = Get-Sha256 $tempDump
  if ($replicaHash -ne $expected) { throw 'Replica backup checksum mismatch.' }
  $finalDump = Join-Path $replicaRoot $latest.Name
  Move-Item -LiteralPath $tempDump -Destination $finalDump -Force
  Move-Item -LiteralPath $tempHash -Destination ($finalDump + '.sha256') -Force
  Move-Item -LiteralPath $tempManifest -Destination ($finalDump + '.json') -Force

  if (-not [string]::IsNullOrWhiteSpace($EvidenceFile)) {
    $evidencePath = [IO.Path]::GetFullPath($EvidenceFile)
    $evidenceDir = [IO.Path]::GetDirectoryName($evidencePath)
    if ($evidenceDir) { New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null }
    [ordered]@{
      result = 'passed'
      generatedAt = (Get-Date).ToUniversalTime().ToString('o')
      storageClass = $StorageClass
      backup = $latest.Name
      backupSha256 = $expected
      replicaDirectory = $replicaRoot
      verifiedAfterCopy = $true
    } | ConvertTo-Json | Set-Content -LiteralPath $evidencePath -Encoding utf8
    Write-Output "Replica evidence: $evidencePath"
  }
  Write-Output "Replica synced: $finalDump"
} finally {
  foreach ($path in @($tempDump,$tempHash,$tempManifest)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}
