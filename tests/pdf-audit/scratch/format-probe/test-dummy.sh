#!/bin/bash
# dummy 探测：wps/et/dps/mobi/azw3/ofd 无样本，用假文件实测 detect 行为留证
S="D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe"
mkdir -p "$S/samples/dummy"
cd "$S/samples/dummy"
# 用真实的 doc 内容伪装成 .wps（测 libwps detect service 是否拒收 MS Word 内容）
cp ../source.doc probe-realword-as.wps
# 其余用纯文本假文件
for ext in et dps mobi azw3 ofd; do
  echo "dummy content for probe" > "probe-dummy.$ext"
done
SO="D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.com"
P="-env:UserInstallation=file:///D:/YM/MyWorkbench/tests/pdf-audit/scratch/format-probe/lo-profile"
run() {
  "$@" >/tmp/probe-out.txt 2>/tmp/probe-err.txt
  local rc=$?
  echo "=== rc=$rc :: $*"
  cat /tmp/probe-out.txt /tmp/probe-err.txt
}
for f in probe-realword-as.wps probe-dummy.et probe-dummy.dps probe-dummy.mobi probe-dummy.azw3 probe-dummy.ofd; do
  run "$SO" --headless "$P" --convert-to pdf --outdir "$S/out/dummy-pdf" "$f"
done
ls -la "$S/out/dummy-pdf" 2>/dev/null
