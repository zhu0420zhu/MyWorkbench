#!/bin/bash
# 修正版导入实测：正确文件名 + PDF 每格式独立目录
S="D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe"
cd "$S/samples"
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"

run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}

echo "########## PDF（独立目录）##########"
for f in source.docx source-table.xlsx source-slide.pptx source.odt source-table.ods source-slide.odp source.rtf source.epub source.doc source-table.xls; do
  base="${f%.*}"
  d="$S/out/pdf-$base"
  mkdir -p "$d"
  run "$SO" --headless "$P" --convert-to pdf --outdir "$d" "$f"
done

echo "########## ods/odp 补测 ##########"
run "$SO" --headless "$P" --convert-to xlsx --outdir "$S/out/xlsx" source-table.ods
run "$SO" --headless "$P" --convert-to csv --outdir "$S/out/csv" source-table.ods
run "$SO" --headless "$P" --convert-to pptx --outdir "$S/out/pptx" source-slide.odp

echo "########## epub 深度确认 ##########"
run "$SO" --headless "$P" --infilter="EPUB" --convert-to pdf --outdir "$S/out/pdf-source.epub" source.epub
run "$SO" --headless "$P" --infilter="writer_EPUB" --convert-to odt --outdir "$S/out/odt-epub" source.epub

echo "########## 产物统计 ##########"
find "$S/out" -type f \( -name "*.pdf" -o -name "*.xlsx" -o -name "*.csv" -o -name "*.pptx" \) -exec ls -la {} \;
