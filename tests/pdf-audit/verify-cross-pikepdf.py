#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
§7.2 交叉验证（独立实现 A：pikepdf / libqpdf）。

判定原则：加解密的真伪只能由【第三方实现】说了算。
  - 解密侧：对 fixture 矩阵每个文件解密后的产物，pikepdf 应【无需口令】打开，且 3 页。
  - 加密侧：我们产出的密文，pikepdf 应 is_encrypted=True；带口令可开；无口令/错口令被拒。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pylibs"))
import pikepdf  # noqa: E402

WORK = os.path.join(HERE, "work")
USER = "LingmoAuditPass123"
OWNER = "OwnerPass456"

fails = []


def line(ok, msg):
    print(("  ✅ " if ok else "  ❌ ") + msg)
    if not ok:
        fails.append(msg)


print("=" * 74)
print("交叉验证 A：pikepdf / libqpdf %s" % pikepdf.__libqpdf_version__)
print("=" * 74)

print("\n[1] 解密产物：pikepdf【不带口令】应能打开且 3 页")
for name in [
    "decrypted-rc4-40-r2.pdf",
    "decrypted-rc4-128-r3.pdf",
    "decrypted-rc4-128-r4.pdf",
    "decrypted-aes128-r4.pdf",
    "decrypted-aes128-r4-nometa.pdf",
]:
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        line(False, "%s 缺失" % name)
        continue
    try:
        with pikepdf.open(p) as d:
            n = len(d.pages)
            enc = d.is_encrypted
        line(n == 3 and not enc, "%-34s 无口令打开 → %d 页, is_encrypted=%s" % (name, n, enc))
    except Exception as e:  # noqa: BLE001
        line(False, "%-34s 打开失败: %s" % (name, e))

print("\n[2] 加密产物：我们写的 AES-128 密文（work/encrypted-aes128.pdf）")
encp = os.path.join(WORK, "encrypted-aes128.pdf")
try:
    with pikepdf.open(encp, password=USER) as d:
        n_user = len(d.pages)
        is_enc = d.is_encrypted
        # 读出 /Encrypt 参数核对
        try:
            ed = d.encryption.to_dict() if hasattr(d.encryption, "to_dict") else None
        except Exception:  # noqa: BLE001
            ed = None
    line(is_enc is True, "is_encrypted = True")
    line(n_user == 3, "用户口令打开 → %d 页" % n_user)
except Exception as e:  # noqa: BLE001
    line(False, "用户口令打开失败: %s" % e)

try:
    with pikepdf.open(encp, password=OWNER) as d:
        n_owner = len(d.pages)
    line(n_owner == 3, "所有者口令打开 → %d 页" % n_owner)
except Exception as e:  # noqa: BLE001
    line(False, "所有者口令打开失败: %s" % e)

try:
    pikepdf.open(encp)
    line(False, "无口令竟然打开（应被拒）")
except Exception:
    line(True, "无口令被拒 ✅")

try:
    pikepdf.open(encp, password="wrong-password")
    line(False, "错误口令竟然打开（应被拒）")
except Exception:
    line(True, "错误口令被拒 ✅")

print("\n[3] 加密参数核对（V / R / CFM）")
try:
    with pikepdf.open(encp, password=USER) as d:
        enc = d.encryption
        V = enc.V if hasattr(enc, "V") else None
        R = enc.R if hasattr(enc, "R") else None
        print("      pikepdf 报告：V=%s R=%s (python 属性)" % (V, R))
except Exception as e:  # noqa: BLE001
    print("      (无法取到属性: %s)" % e)

# 直接解析原始字典更可靠
with open(encp, "rb") as f:
    raw = f.read().decode("latin1")
import re  # noqa: E402
m = re.search(r"/Encrypt\s+(\d+)\s+(\d+)\s+R", raw)
ok_v = bool(re.search(r"/V\s+4\b", raw))
ok_r = bool(re.search(r"/R\s+4\b", raw))
ok_cfm = bool(re.search(r"/CFM\s*/AESV2", raw))
line(m is not None, "/Encrypt 为间接引用（%s）" % (m.group(0) if m else "-"))
line(ok_v, "字典含 /V 4")
line(ok_r, "字典含 /R 4")
line(ok_cfm, "字典含 /CFM /AESV2")

print("\n" + "=" * 74)
print("结果：%s" % ("全部通过 ✅" if not fails else ("失败 %d 项 ❌" % len(fails))))
for f in fails:
    print("   - " + f)
print("=" * 74)
sys.exit(1 if fails else 0)
