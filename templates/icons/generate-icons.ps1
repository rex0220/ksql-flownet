# kSQL-FlowNet アプリアイコン生成(Windows / PowerShell 7 + System.Drawing)
# 出力: 同ディレクトリの *.png(256x256)。kintone のアプリ設定「アイコン」から読み込む。
# 再生成: pwsh templates/icons/generate-icons.ps1

Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $PSCommandPath
$size = 256

function New-Canvas([string]$hex) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $color = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $brush = [System.Drawing.SolidBrush]::new($color)
  # 角丸四角(半径 48)
  $r = 48
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)
  return @{ Bitmap = $bmp; Graphics = $g }
}

function Save-Canvas($canvas, [string]$name) {
  $canvas.Graphics.Dispose()
  $out = Join-Path $dir $name
  $canvas.Bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Bitmap.Dispose()
  Write-Host "wrote $out"
}

$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
function New-Pen([int]$width) {
  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $width)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $pen
}

# 1) 実行管理 — ネットワーク(ノード3つと依存線)
$c = New-Canvas '#1D4ED8'
$g = $c.Graphics
$pen = New-Pen 14
$g.DrawLine($pen, 72, 84, 184, 84)
$g.DrawLine($pen, 72, 84, 128, 176)
$g.DrawLine($pen, 184, 84, 128, 176)
foreach ($p in @(@(72, 84), @(184, 84), @(128, 176))) {
  $g.FillEllipse($white, $p[0] - 30, $p[1] - 30, 60, 60)
}
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#1D4ED8'))
# 下ノードは実行中を示す再生マーク
$tri = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(118, 160),
  [System.Drawing.PointF]::new(118, 192),
  [System.Drawing.PointF]::new(146, 176)
)
$g.FillPolygon($blue, $tri)
Save-Canvas $c 'flownet-execution.png'

# 2) 監査履歴 — 台帳(書類と行、チェック)
$c = New-Canvas '#0F766E'
$g = $c.Graphics
$pen = New-Pen 12
$doc = [System.Drawing.Drawing2D.GraphicsPath]::new()
$doc.AddLines([System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(72, 48), [System.Drawing.Point]::new(152, 48),
  [System.Drawing.Point]::new(192, 88), [System.Drawing.Point]::new(192, 208),
  [System.Drawing.Point]::new(72, 208)
))
$doc.CloseFigure()
$g.DrawPath($pen, $doc)
$g.DrawLine($pen, 152, 48, 152, 88)
$g.DrawLine($pen, 192, 88, 152, 88)
$g.DrawLine($pen, 98, 120, 166, 120)
$g.DrawLine($pen, 98, 148, 166, 148)
$g.DrawLine($pen, 98, 176, 134, 176)
Save-Canvas $c 'flownet-audit.png'

# 3) 操作要求 — ベル(人からの依頼)
$c = New-Canvas '#EA580C'
$g = $c.Graphics
$bell = [System.Drawing.Drawing2D.GraphicsPath]::new()
$bell.AddArc(76, 56, 104, 104, 180, 180)
$bell.AddLine(180, 108, 180, 160)
$bell.AddLine(180, 160, 204, 184)
$bell.AddLine(204, 184, 52, 184)
$bell.AddLine(52, 184, 76, 160)
$bell.CloseFigure()
$g.FillPath($white, $bell)
$g.FillEllipse($white, 112, 190, 32, 24)
$g.FillEllipse($white, 118, 40, 20, 20)
Save-Canvas $c 'flownet-request.png'

# 4) JOBログ(kSQL-Flow 所有) — 端末(プロンプトと出力行)
$c = New-Canvas '#15803D'
$g = $c.Graphics
$pen = New-Pen 14
$g.DrawLine($pen, 64, 92, 104, 128)
$g.DrawLine($pen, 104, 128, 64, 164)
$g.DrawLine($pen, 124, 164, 192, 164)
Save-Canvas $c 'ksqlflow-joblog.png'

$white.Dispose()
