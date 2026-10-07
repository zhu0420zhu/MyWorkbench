#!/usr/bin/env bash
# yan-qa 回归基线跑批（每套件只跑一次，实测数字记入 yan-baseline.log）
cd "$(dirname "$0")/../../.." || exit 1
LOG=tests/pdf-audit/qa/yan-baseline.log
: > "$LOG"

run() {
  echo "" >> "$LOG"
  echo "===== $1 =====" >> "$LOG"
  shift
  NODE_OPTIONS="" "$@" >> "$LOG" 2>&1
  echo "EXITCODE=$? ($1)" >> "$LOG"
  echo "[done] $1"
}

run "typecheck"        npm run typecheck
run "test-enhance-algo" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/pdf-audit/test-enhance-algo.mjs
run "test-crypto-primitives" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/pdf-audit/test-crypto-primitives.mjs
run "test:pdf-security" npm run test:pdf-security
run "audit-functions"  node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/pdf-audit/audit-functions.mjs
run "test:pdf-guard"   npm run test:pdf-guard
run "test:pdf-raster-levels" npm run test:pdf-raster-levels
run "test:pdf-ocr-extract" npm run test:pdf-ocr-extract
run "probe:pdf-ocr"    npm run probe:pdf-ocr

echo "ALL-BASELINE-DONE" >> "$LOG"
echo "ALL-BASELINE-DONE"
