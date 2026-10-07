#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「真加密 PDF」参考素材矩阵 —— 供解密实现做独立验证。

为什么必须用第三方产出：
    用自己的加密器产出、再用自己的解密器读回来，只能证明自洽；
    两个方向可能共享同一个对规范的误解。必须有外部实现做基准。

工具：pikepdf（内核 libqpdf）。
    注意 —— 本环境的沙箱会按内容拦截 qpdf 【可执行文件】，
    但 pip wheel 里的 qpdf 【库】可以正常加载（已实测）。
    LibreOffice 路线不可用：项目自带的 soffice 被裁剪掉了 python-core，
    启动即 Fatal Python error: init_fs_encoding。

产出落到 fixtures/encrypted/，长期复用。
"""
import json
import os
import re
import sys
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pylibs"))

import pikepdf  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
OUT = os.path.join(FIXTURES, "encrypted")
SRC = os.path.join(FIXTURES, "enhance-source.pdf")

USER_PWD = "LingmoAuditPass123"
OWNER_PWD = "OwnerPass456"

# (文件名, R, aes, metadata) —— 覆盖我们实现的每个算法分支
# 约束（libqpdf 校验）：metadata=False 仅当 R>=4 且 AES；
#                       非 AES 时不能启用 metadata 加密选项。
MATRIX = [
    ("rc4-40-r2.pdf", 2, False, False, "R=2 / V=1 / RC4 40-bit"),
    ("rc4-128-r3.pdf", 3, False, False, "R=3 / V=2 / RC4 128-bit"),
    ("rc4-128-r4.pdf", 4, False, False, "R=4 / V=4 / CFM=V2 / RC4 128-bit"),
    ("aes128-r4.pdf", 4, True, True, "R=4 / V=4 / CFM=AESV2 / AES-128  ← 目标格式"),
    ("aes128-r4-nometa.pdf", 4, True, False, "R=4 / AES-128 / EncryptMetadata=false"),
    ("aes256-r6.pdf", 6, True, True, "R=6 / V=5 / CFM=AESV3 / AES-256  ← 现代格式"),
]

print("=" * 74)
print("生成加密 PDF 参考素材矩阵（pikepdf / libqpdf %s）" % pikepdf.__libqpdf_version__)
print("=" * 74)
print("\n源文档 : %s" % SRC)
print("用户口令: %s" % USER_PWD)
print("所有者  : %s" % OWNER_PWD)

if not os.path.exists(SRC):
    print("❌ 源 PDF 缺失: %s" % SRC)
    sys.exit(1)

os.makedirs(OUT, exist_ok=True)
src_pdf = pikepdf.open(SRC)
print("源文档 : %d 页, %d 字节" % (len(src_pdf.pages), os.path.getsize(SRC)))


def parse_encrypt_dict(path):
    """
    从原始字节里抠出 /Encrypt 字典，核实真实写入了什么参数。

    要点：/Encrypt 通常是【间接引用】（如 `16 0 R`），必须解引用再解析；
    直接找 /Encrypt 后面第一个 `<<` 会误抓到 xref 流自己的字典。
    """
    with open(path, "rb") as f:
        raw = f.read().decode("latin1")

    def balanced_dict(start):
        depth, i = 0, start
        while i < len(raw) - 1:
            if raw[i] == "<" and raw[i + 1] == "<":
                depth += 1
                i += 2
                continue
            if raw[i] == ">" and raw[i + 1] == ">":
                depth -= 1
                i += 2
                if depth == 0:
                    return raw[start:i]
                continue
            i += 1
        return raw[start:start + 900]

    # 1) 找到 /Encrypt 的引用或内联字典
    m = re.search(r"/Encrypt\s+(\d+)\s+(\d+)\s+R", raw)
    enc = None
    ref = None
    if m:
        ref = (int(m.group(1)), int(m.group(2)))
        om = re.search(r"(?<![0-9])%d\s+%d\s+obj" % ref, raw)
        if om:
            open_at = raw.find("<<", om.end())
            if open_at >= 0:
                enc = balanced_dict(open_at)
    if enc is None:
        m2 = re.search(r"/Encrypt\s*(<<)", raw)
        if m2:
            enc = balanced_dict(m2.start(1))
    if enc is None:
        return None

    def num(k):
        mm = re.search(r"/" + k + r"\s+(-?\d+)", enc)
        return int(mm.group(1)) if mm else None

    def name(k):
        mm = re.search(r"/" + k + r"\s*/(\w+)", enc)
        return mm.group(1) if mm else None

    return {
        "dict": re.sub(r"\s+", " ", enc).strip(),
        "ref": ref,
        "V": num("V"),
        "R": num("R"),
        "Length": num("Length"),
        "P": num("P"),
        "CFM": name("CFM"),
        "StmF": name("StmF"),
        "StrF": name("StrF"),
        "EncryptMetadata": not re.search(r"/EncryptMetadata\s+false", enc),
        "hasO": bool(re.search(r"/O\s*[<(]", enc)),
        "hasU": bool(re.search(r"/U\s*[<(]", enc)),
        "hasID": bool(re.search(r"/ID\s*\[", raw)),
        "usesXRefStream": bool(re.search(r"/Type\s*/XRef", raw)),
        "usesObjStm": bool(re.search(r"/Type\s*/ObjStm", raw)),
        "classicXRef": bool(re.search(r"\bxref\r?\n", raw)),
    }


def stream_readability(path):
    """数一数有几个流是明文可解析的（加密后应全部不可解析）。"""
    with open(path, "rb") as f:
        raw = f.read().decode("latin1")
    total = readable = 0
    for m in re.finditer(r"\bstream\r?\n", raw):
        s = m.end()
        e = raw.find("endstream", s)
        if e < 0:
            break
        total += 1
        if re.search(r"BT[\s\S]{0,600}?ET", raw[s:e]):
            readable += 1
    return total, readable


made = []
print("\n[1] 导出加密矩阵")
for fname, R, aes, meta, desc in MATRIX:
    dst = os.path.join(OUT, fname)
    try:
        kw = {"owner": OWNER_PWD, "user": USER_PWD, "R": R, "aes": aes}
        if meta is not None:
            kw["metadata"] = meta
        enc = pikepdf.Encryption(**kw)
        with pikepdf.open(SRC) as pdf:
            pdf.save(dst, encryption=enc)
    except Exception as e:  # noqa: BLE001
        print("    ❌ %-24s %s" % (fname, e))
        continue
    size = os.path.getsize(dst)
    info = parse_encrypt_dict(dst)
    if info is None:
        print("    ⚠ %-24s 产出但未找到 /Encrypt 字典" % fname)
        continue
    total, readable = stream_readability(dst)
    made.append({"file": fname, "desc": desc, "size": size, "info": info,
                 "streams": total, "readable": readable})
    print("    ✅ %-24s %7d B   V=%s R=%s Len=%s CFM=%s Meta=%s  流 %d(明文 %d)"
          % (fname, size, info["V"], info["R"], info["Length"], info["CFM"],
             info["EncryptMetadata"], total, readable))

print("\n[2] 加密参数详情")
for m in made:
    i = m["info"]
    print("\n  --- %s ---" % m["file"])
    print("    " + m["desc"])
    print("    结构: xref流=%s  经典xref=%s  含ObjStm=%s"
          % (i["usesXRefStream"], i["classicXRef"], i["usesObjStm"]))
    print("    /Encrypt 引用=%s  /O存在=%s  /U存在=%s  /ID存在=%s"
          % (i["ref"], i["hasO"], i["hasU"], i["hasID"]))
    print("    字典: " + i["dict"][:230] + (" …" if len(i["dict"]) > 230 else ""))

print("\n[3] 加密有效性（明文可解析流数应归零）")
_, src_readable = stream_readability(SRC)
print("    源文档（未加密）: 明文可解析流 %d 个" % src_readable)
all_sealed = True
for m in made:
    ok = m["readable"] == 0
    all_sealed = all_sealed and ok
    print("    %-24s 流 %2d 个，明文可解析 %d 个 %s"
          % (m["file"], m["streams"], m["readable"], "✅ 已密封" if ok else "⚠ 仍有明文流"))

print("\n[4] 用 pikepdf 反向验证：正确口令能开、错误口令打不开")
for m in made:
    p = os.path.join(OUT, m["file"])
    try:
        with pikepdf.open(p, password=USER_PWD) as d:
            n_user = len(d.pages)
    except Exception as e:  # noqa: BLE001
        n_user = "❌ " + str(e)[:40]
    try:
        with pikepdf.open(p, password=OWNER_PWD) as d:
            n_owner = len(d.pages)
    except Exception as e:  # noqa: BLE001
        n_owner = "❌ " + str(e)[:40]
    try:
        pikepdf.open(p, password="wrong-password")
        wrong = "⚠ 竟然打开了"
    except Exception:  # noqa: BLE001
        wrong = "✅ 被拒"
    try:
        pikepdf.open(p)
        nopwd = "⚠ 无口令也打开了"
    except Exception:  # noqa: BLE001
        nopwd = "✅ 被拒"
    print("    %-24s 用户口令→%s 所有者口令→%s 错口令:%s 空口令:%s"
          % (m["file"], n_user, n_owner, wrong, nopwd))

print("\n" + "=" * 74)
print("素材就绪于 fixtures/encrypted/  共 %d 个" % len(made))
print("用户口令 %s  /  所有者口令 %s" % (USER_PWD, OWNER_PWD))
print("=" * 74)
print("\n机器可读摘要:")
print(json.dumps({"user": USER_PWD, "owner": OWNER_PWD, "files": made},
                 ensure_ascii=False, indent=2))
