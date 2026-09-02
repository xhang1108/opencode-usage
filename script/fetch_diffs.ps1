param(
  [string]$OutFile = "alldiffs.txt",
  [string[]]$Shas,
  # Manual cutoff. If omitted, the script reads the newest cursor date from
  # the top of $OutFile (alldiffs.txt) so it only fetches commits after the
  # last crawl, avoiding duplicates.
  [string]$Since
)

# Resolve the cursor date: explicit -Since wins, else parse the first
# "=== <sha> <date> ..." header in $OutFile (date at index 2 after split).
function GetCursor {
  param([string]$Path)
  if ($Since) { return $Since }
  if (Test-Path $Path) {
    # Use the LATEST header date as the cursor (not the first line), because
    # commits may be appended at the end or the file may start with blank lines.
    $latest = $null
    foreach ($h in (Select-String -Path $Path -Pattern '^=== ')) {
      if ($h.Line -match '^\s*===\s+(\S+)\s+(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2}:\d{2})') {
        $dt = [datetime]::ParseExact("$($Matches[2]) $($Matches[3])", "MM/dd/yyyy HH:mm:ss", $null)
        if ($null -eq $latest -or $dt -gt $latest) { $latest = $dt }
      }
    }
    if ($latest) {
      # +1s so the last-fetched commit is not re-fetched.
      return $latest.AddSeconds(1).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
  }
  return $null
}

# Collect SHAs to fetch.
$targets = @()
if ($Shas -and $Shas.Count -gt 0) {
  $targets = $Shas
} else {
  $cursor = GetCursor $OutFile
  if (-not $cursor) {
    Write-Error "No -Since and no cursor found in $OutFile; cannot auto-fetch. Pass -Shas or seed $OutFile."
    exit 1
  }
  Write-Host "Fetching go.mdx commits since $cursor"
  $commits = gh api "repos/anomalyco/opencode/commits?path=packages/web/src/content/docs/go.mdx&since=$cursor&per_page=100" --jq '.[] | "\(.sha)"' 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Error "gh api failed: $commits"; exit 1 }
  $targets = $commits | Where-Object { $_ }
}

# Manual mode overwrites; auto mode appends (preserves existing history).
if ($Shas -and $Shas.Count -gt 0) {
  "" | Set-Content $OutFile
}

# Existing SHAs already recorded, to skip duplicates on append.
$seen = @{}
if (Test-Path $OutFile) {
  foreach ($h in (Select-String -Path $OutFile -Pattern '^=== ')) {
    if ($h.Line -match '^\s*===\s+(\S+)') { $seen[$Matches[1]] = $true }
  }
}

foreach ($s in $targets) {
  if ($seen.ContainsKey($s)) { continue }
  $raw = gh api "repos/anomalyco/opencode/commits/$s" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Add-Content $OutFile "ERROR $s : $raw"
    continue
  }
  try {
    $c = $raw | ConvertFrom-Json
  } catch {
    Add-Content $OutFile "ERROR $s : parse fail"
    continue
  }
  $files = $c.files | Where-Object { $_.filename -like "*go.mdx" }
  if ($files) {
    # Normalize SHA to 7 chars to match existing alldiffs.txt header format.
    $short = $s.Substring(0, [Math]::Min(7, $s.Length))
    Add-Content $OutFile "=== $short  $($c.commit.author.date)  $($c.commit.message.Split([Environment]::NewLine)[0]) ==="
    foreach ($f in $files) {
      $lines = $f.patch -split "`n"
      $kept = $lines | Where-Object { $_ -match "^=== " -or ($_ -match "\$" -and $_ -match "^[+-]") } | ForEach-Object { ($_ -replace '\s+',' ').Trim() } | Sort-Object -Unique
      Add-Content $OutFile $kept
    }
    Add-Content $OutFile ""
  }
}
"DONE" | Add-Content $OutFile
