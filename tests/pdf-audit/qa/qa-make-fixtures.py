#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
QA 独立补充素材生成器（不依赖工程师的物件）。

覆盖工程师矩阵完全没有的真实场景：
  1) owner-only-r4.pdf       空用户口令 / 仅所有者口令（AES-128 R4）
  2) classic-xref-aes128.pdf AES-128 R4，经典 xref 表（无 xref 流 / 无对象流）
  3) classic-xref-rc4.pdf    RC4-128 R3，经典 xref 表
  4) incremental-aes128.pdf  增量更新（多修订版 + /Prev 链）
  5) real-large-aes128.pdf   真实大文件（QQPlayer OpenSourceLicense.pdf）加密后
  6) real-large-rc4.pdf      同上的 RC4-128 R4 版本

产出落 qa-fixtures/。脚本会【自检】产物结构（正则确认 xref / ObjStm / XRef 流），
避免「以为测到了其实没测到」。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(AUDIT, "pylibs"))

import pikepdf  # noqa: E402

FIX = os.path.join(AUDIT, "fixtures")
SRC = os.path.join(FIX, "enhance-source.pdf")
REAL = r"D:\Program Files\Tencent\QQPlayer\OpenSourceLicense.pdf"
OUT = os.path.join(AUDIT, "qa-fixtures")

USER = "LingmoAuditPass123"
OWNER = "OwnerPass456"


def structure(path):
    with open(path, "rb") as f:
        raw = f.read().decode("latin1")
    return {
        "size": os.path.getsize(path),
        "classicXRef": bool(re.search(r"(?:^|[\r\n])xref[\r\n]", raw)),
        "xrefStream": bool(re.search(r"/Type\s*/XRef", raw)),
        "objStm": bool(re.search(r"/Type\s*/ObjStm", raw)),
        "hasEncrypt": bool(re.search(r"/Encrypt\b", raw)),
        "hasPrev": bool(re.search(r"/Prev\s+\d+", raw)),
        "hasLinearized": bool(re.search(r"/Linearized\b", raw)),
        "eofCount": len(re.findall(r"%%EOF", raw)),
    }


def show(tag, path, expect):
    s = structure(path)
    ok = all(s[k] == v for k, v in expect.items())
    print("   %s %-26s %s  -> %s" % (
        "OK " if ok else "!! ", tag, s["size"], s))
    if not ok:
        print("       期望: %s" % expect)
    return s


def make_incremental(path):
    """在既有（经典 xref、已加密）PDF 后追加以 /Prev 相连的第二修订版。"""
    with open(path, "rb") as f:
        data = f.read()
    txt = data.decode("latin1")

    old_xref = 0
    for mm in re.finditer(r"startxref\s+(\d+)", txt):
        old_xref = int(mm.group(1))
    root = re.search(r"/Root\s+(\d+)\s+(\d+)\s+R", txt)
    encref = re.search(r"/Encrypt\s+(\d+)\s+(\d+)\s+R", txt)
    idm = re.search(r"/ID\s*\[\s*(<[0-9A-Fa-f]*>)\s*(<[0-9A-Fa-f]*>)\s*\]", txt)
    size = int(re.search(r"/Size\s+(\d+)", txt).group(1))
    assert root and encref and idm, "原始文件缺少 /Root /Encrypt /ID"

    newnum = size  # 新对象
    base = len(data)
    part1 = "\n%d 0 obj\n<< /QA/Marker /N 42 >>\nendobj\n" % newnum
    new_obj_off = base + 1  # '\n' 之后
    new_xref_off = base + len(part1)
    part2 = "xref\n%d 1\n%010d 00000 n\r\n" % (newnum, new_obj_off)
    trailer = ("trailer\n<< /Size %d /Root %s %s R /Encrypt %s %s R /ID [%s %s] /Prev %d >>\n"
               "startxref\n%d\n%%%%EOF\n") % (
        size + 1, root.group(1), root.group(2), encref.group(1), encref.group(2),
        idm.group(1), idm.group(2), old_xref, new_xref_off)
    append = (part1 + part2 + trailer).encode("latin1")
    with open(path, "ab") as f:
        f.write(append)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("pikepdf", pikepdf.__version__, "/ libqpdf", pikepdf.__libqpdf_version__)
    print("源:", SRC, os.path.getsize(SRC), "B")
    print("真实大文件:", REAL, os.path.exists(REAL))

    # ---- 1) 仅所有者口令（空用户口令）----
    enc = pikepdf.Encryption(owner=OWNER, user="", R=4, aes=True)
    with pikepdf.open(SRC) as pdf:
        pdf.save(os.path.join(OUT, "owner-only-r4.pdf"), encryption=enc)
    show("owner-only-r4", os.path.join(OUT, "owner-only-r4.pdf"),
         {"hasEncrypt": True, "xrefStream": True})

    # ---- 2) AES-128 经典 xref 表（无 xref 流 / 无对象流）----
    enc = pikepdf.Encryption(owner=OWNER, user=USER, R=4, aes=True)
    with pikepdf.open(SRC) as pdf:
        pdf.save(os.path.join(OUT, "classic-xref-aes128.pdf"), encryption=enc,
                 object_stream_mode=pikepdf.ObjectStreamMode.disable)
    show("classic-xref-aes128", os.path.join(OUT, "classic-xref-aes128.pdf"),
         {"hasEncrypt": True, "classicXRef": True, "xrefStream": False, "objStm": False})

    # ---- 3) RC4-128 R3 经典 xref 表 ----
    # 注：R<4 时 metadata 加密不可用（libqpdf 校验），必须显式 metadata=False
    enc = pikepdf.Encryption(owner=OWNER, user=USER, R=3, aes=False, metadata=False)
    with pikepdf.open(SRC) as pdf:
        pdf.save(os.path.join(OUT, "classic-xref-rc4.pdf"), encryption=enc,
                 object_stream_mode=pikepdf.ObjectStreamMode.disable)
    show("classic-xref-rc4", os.path.join(OUT, "classic-xref-rc4.pdf"),
         {"hasEncrypt": True, "classicXRef": True, "xrefStream": False, "objStm": False})

    # ---- 3b) 超长口令（40 字符，规范要求按 32 字节截断）----
    # 注：pikepdf 对 R<=4 的非 ASCII 口令自身不自洽（save 与 open 编码不一致），
    #     故非 ASCII 口令无法用 pikepdf 造可信素材 —— 记入「未覆盖」。
    longp = "A" * 40
    enc = pikepdf.Encryption(owner=OWNER, user=longp, R=4, aes=True)
    with pikepdf.open(SRC) as pdf:
        pdf.save(os.path.join(OUT, "long-pwd-aes128.pdf"), encryption=enc)
    with pikepdf.open(os.path.join(OUT, "long-pwd-aes128.pdf"), password=longp) as pdf:
        print("   OK  long-pwd-aes128           40字口令可开 %d 页" % len(pdf.pages))

    # ---- 4) 增量更新（多修订版 + /Prev 链）----
    # pikepdf 10.15 的 save() 无 incremental 参数（不像 qpdf CLI）。
    # 故改为「字节级追加第二修订版」，这是标准 PDF 增量更新格式：
    #   追加一个新对象 + 只覆盖该对象的 xref 子段 + trailer(/Prev 指回旧 xref)。
    # 新版 xref 只列出新对象，旧对象【只能靠 /Prev 找到】—— 从而真正考验 /Prev 合并。
    inc = os.path.join(OUT, "incremental-aes128.pdf")
    enc = pikepdf.Encryption(owner=OWNER, user=USER, R=4, aes=True)
    with pikepdf.open(SRC) as pdf:
        pdf.save(inc, encryption=enc, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    try:
        make_incremental(inc)
        s = show("incremental-aes128", inc, {"hasEncrypt": True, "hasPrev": True})
        print("       %%EOF 数 = %d (>=2 表示确有第二修订版)" % s["eofCount"])
        # 用 pikepdf 反向确认这个手工增量文件本身是合法的
        with pikepdf.open(inc, password=USER) as pdf:
            print("       pikepdf 复核：增量文件可打开，%d 页" % len(pdf.pages))
    except Exception as e:  # noqa: BLE001
        print("   !! incremental 生成失败: %s" % e)

    # ---- 5/6) 真实大文件加密 ----
    if os.path.exists(REAL):
        enc = pikepdf.Encryption(owner=OWNER, user=USER, R=4, aes=True)
        with pikepdf.open(REAL) as pdf:
            n = len(pdf.pages)
            pdf.save(os.path.join(OUT, "real-large-aes128.pdf"), encryption=enc)
        print("   OK  real-large-aes128        %d 页" % n)
        enc = pikepdf.Encryption(owner=OWNER, user=USER, R=4, aes=False, metadata=False)
        with pikepdf.open(REAL) as pdf:
            pdf.save(os.path.join(OUT, "real-large-rc4.pdf"), encryption=enc)
        print("   OK  real-large-rc4           %d 页" % n)
        # 未加密参照（供文本逐字符比对）
        with pikepdf.open(REAL) as pdf:
            pdf.save(os.path.join(OUT, "real-large-plain.pdf"))
    else:
        print("   !! 真实大文件缺失，跳过 5/6")

    print("\n产出目录:", OUT)
    for f in sorted(os.listdir(OUT)):
        print("   %-28s %8d B" % (f, os.path.getsize(os.path.join(OUT, f))))


if __name__ == "__main__":
    main()
