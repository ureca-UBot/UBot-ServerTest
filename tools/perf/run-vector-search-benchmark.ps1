$ErrorActionPreference = 'Stop'
$benchmarkRoot = if ($env:UBOT_BACKEND_ROOT) { (Resolve-Path -LiteralPath $env:UBOT_BACKEND_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '../../../UBot-BE')).Path }
$previousBenchmarkFlag = $env:RUN_VECTOR_SEARCH_BENCHMARK
Push-Location $benchmarkRoot
try {
    $env:RUN_VECTOR_SEARCH_BENCHMARK = 'true'
    & .\gradlew.bat test --tests com.ubot.embedding.VectorSearchBenchmarkTest --rerun-tasks --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Vector search benchmark failed. Check build/reports/tests/test.' }
    Write-Output 'Results: build/vector-search-benchmark/summary.json (or VECTOR_BENCHMARK_OUTPUT)'
} finally {
    $env:RUN_VECTOR_SEARCH_BENCHMARK = $previousBenchmarkFlag
    Pop-Location
}
