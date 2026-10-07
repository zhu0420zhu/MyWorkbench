#!/usr/bin/env bash
# 终验批跑：按串行顺序执行测试与探针，逐项汇总
# 用法: bash tests/run-final-suite.sh <fast|soffice>
export NODE_OPTIONS=""
cd "$(dirname "$0")/.." || exit 1

FAST="test:parse test:encoding test:format-error test:pinyin test:analytics test:analytics-filters test:kb-data-asset test:integration test:hw-cache test:pdf-security test:pdf-guard test:pdf-compress-levels test:pdf-raster-levels test:pdf-crop-select test:pdf-page-number test:pdf-security-cross test:pdf-ocr-extract probe:ocr-resource probe:temp-cleaner probe:watcher-cache probe:watcher-persist probe:pdf-actualtext probe:pdf-overflow probe:docx-surgical probe:surgical probe:pdf-image-list probe:charcard"

SOFFICE="test:pdf-excel-orient test:pdf-split-batch test:smoke-ffmpeg test:smoke-media test:workflow probe:legacy-profile-fallback probe:surgical-legacy"

MODE="${1:-fast}"
case "$MODE" in
  fast) LIST="$FAST" ;;
  soffice) LIST="$SOFFICE" ;;
  all) LIST="$FAST $SOFFICE" ;;
  *) echo "未知模式: $MODE"; exit 1 ;;
esac

PASS=0; FAIL=0; FAILED_LIST=""
for s in $LIST; do
  start=$(date +%s)
  out=$(npm run "$s" --silent 2>&1)
  rc=$?
  dur=$(( $(date +%s) - start ))
  last=$(printf '%s\n' "$out" | grep -E "passed|通过|OK|✓ built|ALL PASS|failed|失败" | tail -1)
  if [ $rc -eq 0 ]; then
    PASS=$((PASS+1))
    printf '[PASS %3ds] %-28s %s\n' "$dur" "$s" "$last"
  else
    FAIL=$((FAIL+1))
    FAILED_LIST="$FAILED_LIST $s"
    printf '[FAIL %3ds] %-28s rc=%s %s\n' "$dur" "$s" "$rc" "$last"
    printf '%s\n' "$out" | tail -12 | sed 's/^/        | /'
  fi
done

echo "=========================================="
echo "汇总[$MODE]: 通过 $PASS / 失败 $FAIL"
[ -n "$FAILED_LIST" ] && echo "失败项:$FAILED_LIST"
exit $FAIL
