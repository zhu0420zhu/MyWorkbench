#!/bin/bash
# 回写实测：每个格式 -> 自身原格式（分别试朴素转换与显式 filter 名）
S="D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe"
cd "$S/samples"
mkdir -p "$S/out/wb"
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"

run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}

echo "########## docx -> docx ##########"
run "$SO" --headless "$P" --convert-to docx --outdir "$S/out/wb" source.docx
run "$SO" --headless "$P" --convert-to "docx:MS Word 2007 XML" --outdir "$S/out/wb" source.docx
run "$SO" --headless "$P" --convert-to "docx:Office Open XML Text" --outdir "$S/out/wb" source.docx

echo "########## xlsx -> xlsx ##########"
run "$SO" --headless "$P" --convert-to xlsx --outdir "$S/out/wb" source-table.xlsx
run "$SO" --headless "$P" --convert-to "xlsx:Calc MS Excel 2007 XML" --outdir "$S/out/wb" source-table.xlsx
run "$SO" --headless "$P" --convert-to "xlsx:Calc Office Open XML" --outdir "$S/out/wb" source-table.xlsx

echo "########## pptx -> pptx ##########"
run "$SO" --headless "$P" --convert-to pptx --outdir "$S/out/wb" source-slide.pptx
run "$SO" --headless "$P" --convert-to "pptx:Impress MS PowerPoint 2007 XML" --outdir "$S/out/wb" source-slide.pptx
run "$SO" --headless "$P" --convert-to "pptx:Impress Office Open XML" --outdir "$S/out/wb" source-slide.pptx

echo "########## odt -> odt ##########"
run "$SO" --headless "$P" --convert-to odt --outdir "$S/out/wb" source.odt
run "$SO" --headless "$P" --convert-to "odt:writer8" --outdir "$S/out/wb" source.odt

echo "########## ods -> ods ##########"
run "$SO" --headless "$P" --convert-to ods --outdir "$S/out/wb" source-table.ods
run "$SO" --headless "$P" --convert-to "ods:calc8" --outdir "$S/out/wb" source-table.ods

echo "########## odp -> odp ##########"
run "$SO" --headless "$P" --convert-to odp --outdir "$S/out/wb" source-slide.odp
run "$SO" --headless "$P" --convert-to "odp:impress8" --outdir "$S/out/wb" source-slide.odp

echo "########## doc -> doc / xls -> xls / rtf -> rtf ##########"
run "$SO" --headless "$P" --convert-to "doc:MS Word 97" --outdir "$S/out/wb" source.doc
run "$SO" --headless "$P" --convert-to "xls:MS Excel 97" --outdir "$S/out/wb" source-table.xls
run "$SO" --headless "$P" --convert-to "rtf:Rich Text Format" --outdir "$S/out/wb" source.rtf

echo "########## 回写产物 ##########"
ls -la "$S/out/wb"
