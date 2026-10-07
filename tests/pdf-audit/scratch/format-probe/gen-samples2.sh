#!/bin/bash
# 第二轮样本生成：csv->xlsx/ods, fodp->odp/pptx；并清理上次残留
cd "D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/samples"
rm -f .~lock.* lu*.tmp
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"

run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}

run "$SO" --headless "$P" --convert-to xlsx --outdir . source-table.csv
run "$SO" --headless "$P" --convert-to ods --outdir . source-table.csv
run "$SO" --headless "$P" --convert-to odp --outdir . source-slide.fodp
run "$SO" --headless "$P" --convert-to pptx --outdir . source-slide.fodp
echo "---- samples dir ----"
ls -la
