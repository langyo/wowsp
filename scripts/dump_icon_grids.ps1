Add-Type -AssemblyName System.Drawing
foreach ($n in @('destroyer','cruiser','battleship','aircarrier','submarine')) {
  $p = "packages/webui/src/res/images/ships/icon_$n.png"
  $b = [System.Drawing.Bitmap]::FromFile((Resolve-Path $p))
  $lines = New-Object System.Collections.Generic.List[string]
  for ($y = 0; $y -lt $b.Height; $y++) {
    $row = ""
    for ($x = 0; $x -lt $b.Width; $x++) {
      $a = $b.GetPixel($x, $y).A
      if ($a -gt 160) { $row += "#" } elseif ($a -gt 60) { $row += "+" } else { $row += "." }
    }
    $lines.Add("$y|$row")
  }
  $b.Dispose()
  $lines | Set-Content -Encoding ASCII "D:\icon_$n.txt"
  Write-Output "dumped $n"
}
