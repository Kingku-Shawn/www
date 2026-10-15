# 离线站点静态文件服务器（基于 Windows 自带 PowerShell，无需安装任何软件）
# 由"启动离线站点.bat"调用，或手动运行: powershell -ExecutionPolicy Bypass -File server.ps1

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$PORT = 8123
$ListenHost = '127.0.0.1'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
  '.ttf'  = 'font/ttf'
  '.eot'  = 'application/vnd.ms-fontobject'
  '.mp3'  = 'audio/mpeg'
  '.wav'  = 'audio/wav'
  '.ogg'  = 'audio/ogg'
  '.mid'  = 'audio/midi'
  '.pdf'  = 'application/pdf'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://$ListenHost`:$PORT/")
$listener.Start()

# 转发请求到管理后台服务（127.0.0.1:8124），支持 /api/*、/api-v1/* 的 API 路径
function Invoke-Forward($rawPath, $queryPart, $req, $res) {
  $target = 'http://127.0.0.1:8124' + $rawPath + $queryPart
  $fwd = [System.Net.HttpWebRequest]::Create($target)
  $fwd.Method = $req.HttpMethod
  $fwd.Timeout = 30000
  $fwd.ReadWriteTimeout = 30000
  if ($req.HttpMethod -eq 'POST') { $fwd.ContentType = $req.ContentType }
  $tok = $req.Headers['X-Token']
  if ($tok) { $fwd.Headers['X-Token'] = $tok }
  if ($req.ContentLength64 -gt 0) {
    $fs = $fwd.GetRequestStream()
    $req.InputStream.CopyTo($fs)
    $fs.Close()
  }
  try {
    $rsp = $fwd.GetResponse()
    $rs = $rsp.GetResponseStream()
    $ms = New-Object System.IO.MemoryStream
    $rs.CopyTo($ms)
    $b = $ms.ToArray()
    $res.StatusCode = [int]$rsp.StatusCode
    if ($rsp.ContentType) { $res.ContentType = $rsp.ContentType }
    $res.ContentLength64 = $b.Length
    $res.OutputStream.Write($b, 0, $b.Length)
    $res.Close()
    $rsp.Close()
  } catch [System.Net.WebException] {
    $er = $_.Exception.Response
    if ($er) {
      try {
        $es = $er.GetResponseStream()
        $ms2 = New-Object System.IO.MemoryStream
        $es.CopyTo($ms2)
        $b2 = $ms2.ToArray()
        $res.StatusCode = [int]$er.StatusCode
        if ($er.ContentType) { $res.ContentType = $er.ContentType }
        $res.ContentLength64 = $b2.Length
        $res.OutputStream.Write($b2, 0, $b2.Length)
        $res.Close()
      } catch {}
      $er.Close()
    } else {
      $res.StatusCode = 502
      $res.Close()
    }
  } catch {
    $res.StatusCode = 502
    $res.Close()
  }
}

Write-Host "离线站点已启动: http://$ListenHost`:$PORT/"
Write-Host "按 Ctrl+C 停止服务" -ForegroundColor Yellow

# 打开默认浏览器
try {
  Start-Process "http://$ListenHost`:$PORT/"
} catch {}

while ($true) {
  $ctx = $null
  try { $ctx = $listener.GetContext() } catch { break }
  try {
    $req = $ctx.Request
    $res = $ctx.Response
    $rawUrl = [string]$req.RawUrl
    $qIdx = $rawUrl.IndexOf('?')
    $queryPart = ''
    if ($qIdx -ge 0) { $queryPart = $rawUrl.Substring($qIdx); $rawUrl = $rawUrl.Substring(0, $qIdx) }
    $rawPath = [Uri]::UnescapeDataString($rawUrl)
    $origPath = $rawPath   # 保留原始路径，供 API 转发判断使用

    # /api/*.json 优先服务本地静态数据（GitHub Pages 静态化产物）
    if ($rawPath -like '/api/*.json') {
      $apiFile = Join-Path $ROOT ($rawPath.TrimStart('/') -replace '/', '\')
      if (Test-Path -LiteralPath $apiFile) {
        $bytes = [System.IO.File]::ReadAllBytes($apiFile)
        $res.StatusCode = 200
        $res.ContentType = 'application/json; charset=utf-8'
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
        continue
      }
    }
    # /api/* 与 /api-v1/* 请求转发到管理后台服务（127.0.0.1:8124），支持注册、登录、工具页桩接口与查询参数
    if ($rawPath -like '/api/*' -or $rawPath -like '/api-v1/*') {
      Invoke-Forward $rawPath $queryPart $req $res
      continue
    }

    if ($rawPath -eq '/' -or $rawPath -eq '') {
      $rawPath = '/index.html'
    } elseif ($rawPath -like '/www.shawn.com/*') {
      # 兼容旧 /www.shawn.com/ 前缀链接
      $rawPath = $rawPath.Substring('/www.shawn.com'.Length)
      if ($rawPath -eq '') { $rawPath = '/index.html' }
    }

    # 非法字符防护：坏引用 / 恶意 URL（含 URL 编码残留或非法字符）直接 404，避免服务器异常
    if ($rawPath -match '%|<|>|\||\*|\?|"') {
      $res.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }

    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $ROOT ($rawPath.TrimStart('/') -replace '/', '\')))

    # 目录请求自动补 index.html
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
      $fullPath = Join-Path $fullPath 'index.html'
    }

    if (-not $fullPath.StartsWith($ROOT, [System.StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      # 无扩展名请求尝试补 .html（如 /user/login → user/login.html）
      if ([System.IO.Path]::GetExtension($fullPath) -eq '') {
        $alt = $fullPath + '.html'
        if (Test-Path -LiteralPath $alt -PathType Leaf) { $fullPath = $alt }
      }
    }

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }

    $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }

    # 开发环境禁用缓存：确保 header-fix.js 等脚本修改后浏览器立即生效，避免旧顶栏残留
    if ($ext -in @('.html', '.js', '.css', '.json', '.svg', '.xml')) {
      $res.Headers['Cache-Control'] = 'no-store'
    }

    $buffer = [System.IO.File]::ReadAllBytes($fullPath)
    $res.ContentLength64 = $buffer.Length
    $res.OutputStream.Write($buffer, 0, $buffer.Length)
    $res.Close()
  } catch {
    try {
      $errMsg = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message
      [System.IO.File]::AppendAllText((Join-Path $ROOT 'server_error.log'), $errMsg + "`r`n", [System.Text.Encoding]::UTF8)
    } catch {}
    try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
  }
}
