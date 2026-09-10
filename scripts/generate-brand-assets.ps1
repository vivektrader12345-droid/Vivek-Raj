param(
    [string]$Source = (Join-Path $PSScriptRoot '..\public\icons\vmt-logo-source.jpg')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = [System.IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Brand source image not found: $sourcePath"
}

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

function Save-BrandImage {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [int]$Width,
        [Parameter(Mandatory)] [int]$Height,
        [double]$Scale = 1.0,
        [switch]$Transparent
    )

    $directory = Split-Path -Parent $Path
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null

    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        if ($Transparent) {
            $graphics.Clear([System.Drawing.Color]::Transparent)
        } else {
            $graphics.Clear([System.Drawing.Color]::Black)
        }

        $maxWidth = $Width * $Scale
        $maxHeight = $Height * $Scale
        $ratio = [Math]::Min($maxWidth / $sourceImage.Width, $maxHeight / $sourceImage.Height)
        $drawWidth = [int][Math]::Round($sourceImage.Width * $ratio)
        $drawHeight = [int][Math]::Round($sourceImage.Height * $ratio)
        $left = [int][Math]::Round(($Width - $drawWidth) / 2)
        $top = [int][Math]::Round(($Height - $drawHeight) / 2)
        $graphics.DrawImage($sourceImage, $left, $top, $drawWidth, $drawHeight)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Save-IcoFromPng {
    param(
        [Parameter(Mandatory)] [string]$PngPath,
        [Parameter(Mandatory)] [string]$IcoPath,
        [Parameter(Mandatory)] [int]$Size
    )

    $pngBytes = [System.IO.File]::ReadAllBytes($PngPath)
    $stream = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]1)
        $writer.Write([byte]$Size)
        $writer.Write([byte]$Size)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$pngBytes.Length)
        $writer.Write([UInt32]22)
        $writer.Write($pngBytes)
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

try {
    $publicIcons = Join-Path $root 'public\icons'
    foreach ($definition in @(
        @{ Name = 'favicon-48.png'; Size = 48; Scale = 1.0 },
        @{ Name = 'apple-touch-icon.png'; Size = 180; Scale = 1.0 },
        @{ Name = 'icon-192.png'; Size = 192; Scale = 1.0 },
        @{ Name = 'icon-512.png'; Size = 512; Scale = 1.0 },
        @{ Name = 'icon-maskable-192.png'; Size = 192; Scale = 0.8 },
        @{ Name = 'icon-maskable-512.png'; Size = 512; Scale = 0.8 }
    )) {
        Save-BrandImage -Path (Join-Path $publicIcons $definition.Name) -Width $definition.Size -Height $definition.Size -Scale $definition.Scale
    }
    [System.IO.File]::Copy((Join-Path $publicIcons 'favicon-48.png'), (Join-Path $root 'public\favicon-vmt-48.png'), $true)
    Save-IcoFromPng -PngPath (Join-Path $publicIcons 'favicon-48.png') -IcoPath (Join-Path $root 'public\favicon.ico') -Size 48

    $resources = Join-Path $root 'android\app\src\main\res'
    $launcherSizes = [ordered]@{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }
    $foregroundSizes = [ordered]@{ mdpi = 108; hdpi = 162; xhdpi = 216; xxhdpi = 324; xxxhdpi = 432 }
    foreach ($density in $launcherSizes.Keys) {
        $directory = Join-Path $resources "mipmap-$density"
        Save-BrandImage -Path (Join-Path $directory 'ic_launcher.png') -Width $launcherSizes[$density] -Height $launcherSizes[$density]
        Save-BrandImage -Path (Join-Path $directory 'ic_launcher_round.png') -Width $launcherSizes[$density] -Height $launcherSizes[$density]
        Save-BrandImage -Path (Join-Path $directory 'ic_launcher_foreground.png') -Width $foregroundSizes[$density] -Height $foregroundSizes[$density] -Scale 0.7 -Transparent
    }

    $splashes = @(
        @{ Directory = 'drawable'; Width = 480; Height = 320 },
        @{ Directory = 'drawable-land-mdpi'; Width = 480; Height = 320 },
        @{ Directory = 'drawable-land-hdpi'; Width = 800; Height = 480 },
        @{ Directory = 'drawable-land-xhdpi'; Width = 1280; Height = 720 },
        @{ Directory = 'drawable-land-xxhdpi'; Width = 1600; Height = 960 },
        @{ Directory = 'drawable-land-xxxhdpi'; Width = 1920; Height = 1280 },
        @{ Directory = 'drawable-port-mdpi'; Width = 320; Height = 480 },
        @{ Directory = 'drawable-port-hdpi'; Width = 480; Height = 800 },
        @{ Directory = 'drawable-port-xhdpi'; Width = 720; Height = 1280 },
        @{ Directory = 'drawable-port-xxhdpi'; Width = 960; Height = 1600 },
        @{ Directory = 'drawable-port-xxxhdpi'; Width = 1280; Height = 1920 }
    )
    foreach ($splash in $splashes) {
        Save-BrandImage -Path (Join-Path $resources "$($splash.Directory)\splash.png") -Width $splash.Width -Height $splash.Height -Scale 0.5
    }
} finally {
    $sourceImage.Dispose()
}

Write-Output 'Generated Vivek Marco Trader web, PWA, and Android branding assets.'
