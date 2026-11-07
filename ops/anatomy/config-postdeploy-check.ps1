# ANAT-CONFIG-01: post-deploy checks with every ANAT flag off. Read-only: GET requests without credentials.
#   powershell -ExecutionPolicy Bypass -File ops\anatomy\config-postdeploy-check.ps1
# Expected: all lines PASS. Prints FAIL and exits 1 otherwise.
param(
  [string]$Api = 'https://radar-fiscal-backend-production.up.railway.app',
  [string]$Site = 'https://www.trifaros.com.br'
)
$fail = 0
function Get-Code([string]$Url) {
  try { return [int](Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 0 -ErrorAction Stop).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}
function Check([string]$Name, [int]$Expected, [int]$Actual) {
  if ($Expected -eq $Actual) { Write-Output "PASS $Name (=$Actual)" } else { Write-Output "FAIL ${Name}: esperado $Expected, obtido $Actual"; $script:fail = 1 }
}
Check 'health HTTP' 200 (Get-Code "$Api/health")
try { $h = Invoke-RestMethod -Uri "$Api/health" -TimeoutSec 20; if ($h.database -eq 'up') { Write-Output 'PASS health database up' } else { Write-Output "FAIL health database: $($h | ConvertTo-Json -Compress)"; $fail = 1 } }
catch { Write-Output "FAIL health database: $($_.Exception.Message)"; $fail = 1 }
Check 'anatomy-config sem token (flag desligada)' 404 (Get-Code "$Api/api/v1/admin/anatomy-config")
Check 'anatomy-rules antiga sem token (flag desligada)' 404 (Get-Code "$Api/api/v1/admin/anatomy-rules/drafts")
Check 'admin/me sem token' 401 (Get-Code "$Api/api/v1/admin/me")
Check 'site' 200 (Get-Code "$Site/")
Write-Output "MANUAL: abrir $Site/admin/anatomia no navegador: deve voltar para a pagina inicial, e o menu admin nao mostra 'Anatomia dos atos'."
exit $fail
