# Generates the square legacy launcher icons (API 24/25). Devices on 26+ use the
# adaptive vector icon in mipmap-anydpi-v26. Edit the geometry here and re-run.
# Keep this file pure ASCII: PowerShell 5.1 reads .ps1 as ANSI, and a UTF-8 comment
# without BOM breaks the parser on a random line.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$res = Join-Path (Split-Path -Parent $root) 'app\src\main\res'
$sizes = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }

$ink = [System.Drawing.Color]::FromArgb(255, 10, 15, 20)
$teal = [System.Drawing.Color]::FromArgb(255, 88, 199, 189)
$amber = [System.Drawing.Color]::FromArgb(255, 240, 168, 49)

foreach ($k in ($sizes.Keys | Sort-Object)) {
    $s = $sizes[$k]
    $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $r = [int]($s * 0.18)
    $d = $r * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($s - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($s - $d - 1, $s - $d - 1, $d, $d, 0, 90)
    $path.AddArc(0, $s - $d - 1, $d, $d, 90, 90)
    $path.CloseFigure()
    $bg = [System.Drawing.SolidBrush]::new($ink)
    $g.FillPath($bg, $path)

    $ring = [System.Drawing.Pen]::new($teal, [single]($s * 0.055))
    $m = [int]($s * 0.26)
    $g.DrawEllipse($ring, $m, $m, $s - 2 * $m, $s - 2 * $m)

    $c = $s / 2.0
    $needle = [System.Drawing.Pen]::new($amber, [single]($s * 0.06))
    $needle.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $needle.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($needle, [single]$c, [single]$c, [single]($c + $s * 0.13), [single]($c - $s * 0.13))

    $dot = [int]($s * 0.09)
    $core = [System.Drawing.SolidBrush]::new($amber)
    $g.FillEllipse($core, [int]($c - $dot / 2), [int]($c - $dot / 2), $dot, $dot)

    $g.Dispose()
    $dir = Join-Path $res ('mipmap-' + $k)
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $out = Join-Path $dir 'ic_launcher.png'
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ($k + ' -> ' + $s + 'px ' + $out)
}
