param(
  [string]$OutFile,
  [string[]]$Shas
)

"" | Set-Content $OutFile
foreach ($s in $Shas) {
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
    Add-Content $OutFile "=== $s  $($c.commit.author.date)  $($c.commit.message.Split([Environment]::NewLine)[0]) ==="
    foreach ($f in $files) {
      $lines = $f.patch -split "`n"
      $kept = $lines | Where-Object { $_ -match "^=== " -or ($_ -match "\$" -and $_ -match "^[+-]") } | ForEach-Object { ($_ -replace '\s+',' ').Trim() } | Sort-Object -Unique
      Add-Content $OutFile $kept
    }
    Add-Content $OutFile ""
  }
}
"DONE" | Add-Content $OutFile
