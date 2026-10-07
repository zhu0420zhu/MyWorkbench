#!/bin/bash
# 格式滤镜探测：样本生成阶段（串行执行）
cd "D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/samples"
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"

run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}

run "$SO" --headless "$P" --convert-to rtf --outdir . source.txt
run "$SO" --headless "$P" --convert-to epub --outdir . source.txt
run "$SO" --headless "$P" --convert-to xlsx --outdir . source-table.html
run "$SO" --headless "$P" --convert-to ods --outdir . source-table.html
run "$SO" --headless "$P" --convert-to pptx --outdir . source-slide.html
run "$SO" --headless "$P" --convert-to odp --outdir . source-slide.html
run "$SO" --headless "$P" --convert-to "xlsx:Calc MS Excel 2007 XML" --outdir . source-table.html
run "$SO" --headless "$P" --convert-to "pptx:Impress MS PowerPoint 2007 XML" --outdir . source-slide.html
echo "---- samples dir ----"
ls -la
