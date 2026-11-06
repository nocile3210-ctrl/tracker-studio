<#
.SYNOPSIS
    把本地 tracker-studio 仓库发布到 GitHub（建仓库 + 推送 + 设置 topics）。

.EXAMPLE
    # 预览将要做什么（不联网、不建仓）
    .\publish.ps1 -Token x -DryRun

.EXAMPLE
    # 真正发布到 nocile3210-ctrl/tracker-studio（公开）
    .\publish.ps1 -Token github_pat_xxx
#>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Owner = "nocile3210-ctrl",
    [string]$Repo = "tracker-studio",
    [string]$Description = "本地 Web 界面 + 篡改猴脚本，批量管理 Transmission / qBittorrent 的 tracker：站点聚合、逐条 diff 预览、自动备份与一键回滚。 | Web UI and Tampermonkey userscript for batch tracker editing: site grouping, diff preview, backup and one-click rollback.",
    [switch]$Private,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$api = "https://api.github.com"
$headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "tracker-studio-publisher"
}
$gitUrl = "https://x-access-token:$Token@github.com/$Owner/$Repo.git"
$html = "https://github.com/$Owner/$Repo"

if ($DryRun) {
    Write-Host "[dry-run] 仓库: $Owner/$Repo  私有: $([bool]$Private)"
    Write-Host "[dry-run] 描述: $Description"
    Write-Host "[dry-run] 将推送: $root -> $Repo (main)"
    Write-Host "[dry-run] 将设置 topics: bt, tracker, transmission, qbittorrent, pt, python"
    exit 0
}

Push-Location $root
try {
    if (-not (Test-Path ".git")) { throw "当前目录不是 git 仓库：$root" }

    # 注意：中文必须显式按 UTF-8 字节发送。
    # 直接 -Body $json 会让 Windows PowerShell 按 ISO-8859-1 编码，中文会变成 "?"。
    function Send-GitHubJson([string]$Uri, [string]$Method, $Payload) {
        $json = $Payload | ConvertTo-Json -Depth 6
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -Body $bytes `
            -ContentType "application/json; charset=utf-8"
    }

    # 1. 建仓库（已存在则跳过）
    try {
        Send-GitHubJson "$api/user/repos" "Post" @{
            name        = $Repo
            description = $Description
            private     = [bool]$Private
            has_issues  = $true
            has_wiki    = $false
        } | Out-Null
        Write-Host "✓ 已创建仓库 $html"
    }
    catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 422) { Write-Host "· 仓库已存在，继续推送" }
        elseif ($code -eq 401) { throw "token 无效或已过期（401）" }
        elseif ($code -eq 403) { throw "token 权限不足（403）：需要 Administration + Contents 写权限" }
        else { throw }
    }

    # 2. 推送（token 只出现在这一条命令的 URL 里，不写进 .git/config）
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    git push --quiet $gitUrl "HEAD:refs/heads/$branch" 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "推送失败（exit=$LASTEXITCODE）" }
    Write-Host "✓ 已推送 $branch"

    # 3. 设置 description / default branch / topics（仓库已存在时也刷新描述）
    try {
        Send-GitHubJson "$api/repos/$Owner/$Repo" "Patch" @{
            description    = $Description
            default_branch = $branch
        } | Out-Null
        Send-GitHubJson "$api/repos/$Owner/$Repo/topics" "Put" @{
            names = @("bt", "tracker", "transmission", "qbittorrent", "pt", "python", "self-hosted")
        } | Out-Null
        Write-Host "✓ 已设置描述、默认分支与 topics"
    }
    catch {
        Write-Warning "仓库已推送，但补充设置失败：$($_.Exception.Message)"
    }

    Write-Host ""
    Write-Host "仓库地址: $html"
}
finally {
    Pop-Location
}
