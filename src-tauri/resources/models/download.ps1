# Folio OCR 模型与 ONNX Runtime 下载脚本
#
# 下载内容：
#   1. ch_PP-OCRv4_det_infer.onnx   (PP-OCRv4 文本检测, 4.7MB)
#   2. ch_PP-OCRv4_rec_infer.onnx   (PP-OCRv4 文本识别, 10.9MB)
#   3. ppocr_keys_v1.txt            (识别字符表, 6623 字符)
#   4. onnxruntime.dll              (ONNX Runtime 1.23.2, 14.2MB)
#
# 来源：
#   - 模型来自 RapidOCR 3.4.5 wheel（清华 PyPI 镜像），
#     与 Rust 端 ocr_engine.rs 的预处理/后处理参数完全一致
#   - onnxruntime.dll 来自 NuGet 包 Microsoft.ML.OnnxRuntime 1.23.2
#     （与 ort crate 2.0.0-rc.11 的 ORT API v23 匹配）
#
# 运行：powershell -ExecutionPolicy Bypass -File download.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModelsDir = Join-Path $Root ''
$LibDir = Join-Path (Split-Path -Parent $Root) 'lib'
$Temp = Join-Path $env:TEMP 'folio-ocr-download'
$WheelUrl = 'https://pypi.tuna.tsinghua.edu.cn/packages/be/5a/9a61f7c3250d7651c2043e763045e1181fe2fd12d0d5879f726f351818ad/rapidocr-3.4.5-py3-none-any.whl'
$NugetUrl = 'https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime/1.23.2'

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

Write-Host '[1/4] 下载 rapidocr-3.4.5 wheel（清华镜像）...'
$Wheel = Join-Path $Temp 'rapidocr.whl'
Invoke-WebRequest -Uri $WheelUrl -OutFile $Wheel -UseBasicParsing

Write-Host '[2/4] 解压模型文件...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [System.IO.Compression.ZipFile]::OpenRead($Wheel)
foreach ($Entry in $Zip.Entries) {
  if ($Entry.FullName -eq 'rapidocr/models/ch_PP-OCRv4_det_infer.onnx') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $ModelsDir 'ch_PP-OCRv4_det_infer.onnx'), $true)
  }
  elseif ($Entry.FullName -eq 'rapidocr/models/ch_PP-OCRv4_rec_infer.onnx') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $ModelsDir 'ch_PP-OCRv4_rec_infer.onnx'), $true)
  }
  elseif ($Entry.FullName -eq 'rapidocr/models/ppocr_keys_v1.txt') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $ModelsDir 'ppocr_keys_v1.txt'), $true)
  }
}
$Zip.Dispose()

Write-Host '[3/4] 下载 Microsoft.ML.OnnxRuntime 1.23.2（NuGet）...'
$Nupkg = Join-Path $Temp 'onnxruntime.nupkg'
Invoke-WebRequest -Uri $NugetUrl -OutFile $Nupkg -UseBasicParsing

Write-Host '[4/4] 解压 onnxruntime.dll...'
$Zip2 = [System.IO.Compression.ZipFile]::OpenRead($Nupkg)
foreach ($Entry in $Zip2.Entries) {
  if ($Entry.FullName -eq 'runtimes/win-x64/native/onnxruntime.dll') {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $LibDir 'onnxruntime.dll'), $true)
  }
}
$Zip2.Dispose()

Remove-Item -Recurse -Force $Temp
Write-Host ''
Write-Host '完成！模型已安装到:'
Write-Host "  $ModelsDir"
Write-Host "  $LibDir"
