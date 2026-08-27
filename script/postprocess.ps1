$lines = Get-Content "d:\Antigravity\opencode-usage\alldiffs.txt"

# Extract price signature from the three universal per-token price columns:
# input (field 2), output (field 3), cache (field 4) after splitting on '|'.
# The trailing per-request limit cap column is intentionally excluded.
function PriceSig($line) {
  $parts = ($line -split '\|').Trim() | Where-Object { $_ -ne '' }
  # parts[0] = marker, parts[1] = model, parts[2..4] = in/out/cache
  ($parts[2..4] -join '|')
}

$curHeader = $null
$curPlus = @{}
$curMinus = @{}
$output = @()

function FlushBlock {
  param($header, $plus, $minus)
  $models = ($plus.Keys + $minus.Keys) | Sort-Object -Unique
  $buf = @()
  $changed = $false
  foreach ($m in $models) {
    $p = $plus[$m]; $mn = $minus[$m]
    if ($p -and $mn) {
      if ((PriceSig $p) -ne (PriceSig $mn)) { $buf += $mn; $buf += $p; $changed = $true }
    } elseif ($p) { $buf += $p; $changed = $true }
    elseif ($mn) { $buf += $mn; $changed = $true }
  }
  if ($changed) {
    $script:output += $header
    $script:output += $buf
    $script:output += ""
  }
}

foreach ($l in $lines) {
  if ($l -match "^=== ") {
    if ($curHeader -ne $null) { FlushBlock $curHeader $curPlus $curMinus }
    $curHeader = $l
    $curPlus = @{}
    $curMinus = @{}
    continue
  }
  if ($l -match "^\+") {
    $parts = $l -split '\|'
    if ($parts.Count -ge 2) { $m = $parts[1].Trim(); $curPlus[$m] = $l }
  } elseif ($l -match "^-") {
    $parts = $l -split '\|'
    if ($parts.Count -ge 2) { $m = $parts[1].Trim(); $curMinus[$m] = $l }
  }
}
if ($curHeader -ne $null) { FlushBlock $curHeader $curPlus $curMinus }

$output | Set-Content "d:\Antigravity\opencode-usage\clean_diffs.txt"
"LINES=$($output.Count)" | Add-Content "d:\Antigravity\opencode-usage\clean_diffs.txt"
