#!/bin/bash
# 导入能力实测：所有样本 -> pdf；文本类 -> docx/odt；表格类互转；演示类互转
S="D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe"
cd "$S/samples"
mkdir -p "$S/out/pdf" "$S/out/docx" "$S/out/odt" "$S/out/xlsx" "$S/out/ods" "$S/out/csv" "$S/out/pptx" "$S/out/odp"
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"

run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}

echo "########## 全部样本 -> PDF ##########"
for f in source.docx source-table.xlsx source-slide.pptx source.odt source.ods source.odp source.rtf source.epub source.doc source-table.xls; do
  run "$SO" --headless "$P" --convert-to pdf --outdir "$S/out/pdf" "$f"
done

echo "########## 文本类 -> docx ##########"
for f in source.rtf source.epub source.doc source.odt; do
  run "$SO" --headless "$P" --convert-to docx --outdir "$S/out/docx" "$f"
done

echo "########## 文本类 -> odt ##########"
for f in source.rtf source.epub source.doc source.docx; do
  run "$SO" --headless "$P" --convert-to odt --outdir "$S/out/odt" "$f"
done

echo "########## 表格类互转 ##########"
run "$SO" --headless "$P" --convert-to xlsx --outdir "$S/out/xlsx" source-table.xls
run "$SO" --headless "$P" --convert-to xlsx --outdir "$S/out/xlsx" source.ods
run "$SO" --headless "$P" --convert-to ods --outdir "$S/out/ods" source-table.xls
run "$SO" --headless "$P" --convert-to ods --outdir "$S/out/ods" source-table.xlsx
run "$SO" --headless "$P" --convert-to csv --outdir "$S/out/csv" source-table.xlsx
run "$SO" --headless "$P" --convert-to csv --outdir "$S/out/csv" source.ods
run "$SO" --headless "$P" --convert-to csv --outdir "$S/out/csv" source-table.xls

echo "########## 演示类互转 ##########"
run "$SO" --headless "$P" --convert-to pptx --outdir "$S/out/pptx" source-slide.odp
run "$SO" --headless "$P" --convert-to odp --outdir "$S/out/odp" source-slide.pptx

echo "########## 产物清单 ##########"
ls -la "$S/out"/*
