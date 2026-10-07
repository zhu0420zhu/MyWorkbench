#!/bin/bash
# 补造 .doc / .xls 样本
cd "D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/samples"
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"
run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}
run "$SO" --headless "$P" --convert-to "doc:MS Word 97" --outdir . source.txt
run "$SO" --headless "$P" --convert-to "xls:MS Excel 97" --outdir . source-table.csv
ls -la *.doc *.xls 2>/dev/null
