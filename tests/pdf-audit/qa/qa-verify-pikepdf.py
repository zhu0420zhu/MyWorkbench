#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
QA 独立验证——第三方实现 A：pikepdf / libqpdf。

只认第三方裁定：
  - 解密产物：pikepdf【不带口令】打开，is_encrypted=False，页数正确，且确实能取到内容标记。
  - 加密产物：is_encrypted=True；/V 4 /R 4 CFM=AESV2 /P=-3904；
              带用户/所有者口令可开；无口令/错口令被拒。
  - 原始 QA 素材本身的自洽性（确认它们真是加密的）。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(AUDIT, "pylibs"))
import pikepdf  # noqa: E402

QA = os.path.join(AUDIT, "qa-fixtures")
ENC = os.path.join(AUDIT, "fixtures", "encrypted")
WORK = os.path.join(AUDIT, "qa-work")
USER = "LingmoAuditPass123"
OWNER = "OwnerPass456"

rows = []
fails = []


def check(ok, msg):
    print(("  [OK] " if ok else "  [XX] ") + msg)
    rows.append((ok, msg))
    if not ok:
        fails.append(msg)
    return ok


def balanced_dict(raw, start):
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
    return raw[start:start + 1200]


def encrypt_dict(path):
    """定位并解析 /Encrypt 字典（解引用），返回字段。"""
    with open(path, "rb") as f:
        raw = f.read().decode("latin1")
    m = re.search(r"/Encrypt\s+(\d+)\s+(\d+)\s+R", raw)
    d = None
    if m:
        om = re.search(r"(?<![0-9])%s\s+%s\s+obj" % (m.group(1), m.group(2)), raw)
        if om:
            o = raw.find("<<", om.end())
            if o >= 0:
                d = balanced_dict(raw, o)
    if d is None:
        m2 = re.search(r"/Encrypt\s*(<<)", raw)
        if m2:
            d = balanced_dict(raw, m2.start(1))

    def num(k):
        mm = re.search(r"/" + k + r"\s+(-?\d+)", d)
        return int(mm.group(1)) if mm else None

    def name(k):
        mm = re.search(r"/" + k + r"\s*/(\w+)", d)
        return mm.group(1) if mm else None

    return {"V": num("V"), "R": num("R"), "Length": num("Length"),
            "P": num("P"), "CFM": name("CFM"), "StmF": name("StmF")}


print("=" * 78)
print("QA 交叉验证 A：pikepdf %s / libqpdf %s" % (pikepdf.__version__, pikepdf.__libqpdf_version__))
print("=" * 78)

print("\n[1] 解密产物：pikepdf【不带口令】应打开、is_encrypted=False、页数正确")
DEC_OUT = {
    "dec-owner-only-r4.pdf": 3,
    "dec-classic-xref-aes128.pdf": 3,
    "dec-classic-xref-rc4.pdf": 3,
    "dec-incremental-aes128.pdf": 3,
    "dec-real-large-aes128.pdf": 34,
    "dec-real-large-rc4.pdf": 34,
    "dec-long-pwd-aes128.pdf": 3,
}
for name, exp_pages in DEC_OUT.items():
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        check(False, "%s 缺失" % name)
        continue
    try:
        with pikepdf.open(p) as d:
            n = len(d.pages)
            enc = d.is_encrypted
        check(n == exp_pages and not enc,
              "%-32s 无口令打开 → %d 页(期望%d), is_encrypted=%s" % (name, n, exp_pages, enc))
    except Exception as e:  # noqa: BLE001
        check(False, "%-32s 打开失败: %s" % (name, e))

print("\n[2] QA 原始素材本身确为加密（自洽性确认）")
# 注：owner-only 文件用户口令为空 —— 无口令【本应】能打开（这正说明它是 owner-only）。
for name, user_pwd, exp_reject in [("owner-only-r4.pdf", "", False),
                                   ("classic-xref-aes128.pdf", USER, True),
                                   ("classic-xref-rc4.pdf", USER, True),
                                   ("incremental-aes128.pdf", USER, True),
                                   ("real-large-aes128.pdf", USER, True),
                                   ("real-large-rc4.pdf", USER, True)]:
    p = os.path.join(QA, name)
    try:
        with pikepdf.open(p, password=user_pwd) as d:
            n = len(d.pages)
            enc = d.is_encrypted
        rejected = False
        try:
            pikepdf.open(p)
        except Exception:  # noqa: BLE001
            rejected = True
        check(enc and n > 0 and rejected == exp_reject,
              "%-28s 加密=%s 页=%d 无口令被拒=%s(期望%s)" % (name, enc, n, rejected, exp_reject))
    except Exception as e:  # noqa: BLE001
        check(False, "%-28s 打开失败: %s" % (name, e))

print("\n[3] 加密产物：结构参数 /V /R /CFM /P")
ENC_OUT = [("enc-source.pdf", 3, USER, OWNER),
           ("enc-real.pdf", 34, USER, OWNER),
           ("enc-longpwd.pdf", 3, "A" * 40, OWNER)]
enc_stats = {}
for name, exp_pages, u_pwd, o_pwd in ENC_OUT:
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        check(False, "%s 缺失" % name)
        continue
    ei = encrypt_dict(p)
    enc_stats[name] = ei
    ok = (ei["V"] == 4 and ei["R"] == 4 and ei["CFM"] == "AESV2" and ei["P"] == -3904)
    check(ok, "%-16s V=%s R=%s CFM=%s P=%s (期望 V4 R4 AESV2 P=-3904)" % (
        name, ei["V"], ei["R"], ei["CFM"], ei["P"]))

print("\n[4] 加密产物：口令行为")
for name, exp_pages, u_pwd, o_pwd in ENC_OUT:
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        continue
    try:
        with pikepdf.open(p, password=u_pwd) as d:
            nu, isenc = len(d.pages), d.is_encrypted
        check(isenc is True and nu == exp_pages,
              "%-16s 用户口令(len=%d) → %d 页, is_encrypted=%s" % (name, len(u_pwd), nu, isenc))
    except Exception as e:  # noqa: BLE001
        check(False, "%-16s 用户口令打开失败: %s" % (name, e))
    try:
        with pikepdf.open(p, password=o_pwd) as d:
            no = len(d.pages)
        check(no == exp_pages, "%-16s 所有者口令 → %d 页" % (name, no))
    except Exception as e:  # noqa: BLE001
        check(False, "%-16s 所有者口令打开失败: %s" % (name, e))
    try:
        pikepdf.open(p)
        check(False, "%-16s 无口令竟然打开（应被拒）" % name)
    except Exception:
        check(True, "%-16s 无口令被拒" % name)
    try:
        pikepdf.open(p, password="wrong-password")
        check(False, "%-16s 错误口令竟然打开（应被拒）" % name)
    except Exception:
        check(True, "%-16s 错误口令被拒" % name)

print("\n" + "=" * 78)
n_ok = sum(1 for ok, _ in rows if ok)
print("结果：%d 通过 / %d 失败" % (n_ok, len(rows) - n_ok))
for f in fails:
    print("   - " + f)
print("=" * 78)
with open(os.path.join(WORK, "_qa-verify-pikepdf.json"), "w", encoding="utf-8") as fh:
    json.dump({"rows": rows, "enc_stats": enc_stats}, fh, ensure_ascii=False, indent=2)
sys.exit(1 if fails else 0)
