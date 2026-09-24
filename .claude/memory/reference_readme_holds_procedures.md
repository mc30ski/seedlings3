---
name: reference-readme-holds-procedures
description: "README.md documents operational procedures (QR generation, deploy workflow) — search it before claiming something is undocumented"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-24T19:26:09.855Z
---

`README.md` (~531 lines) is not a stub. It carries **operational procedures**
that exist nowhere else in the repo — steps the user performs by hand, with
specific third-party tools and settings.

Known examples:
- **Equipment QR codes** (§ "Generating QR Codes", ~line 244): codes encode
  `https://seedlings.team/e/{slug}`, generated manually at
  `really-free-qr-code-generator.com` — Type URL, 128px, error correction M,
  margin 4, then printed and laminated. There is NO QR generator in the
  codebase; the app only *scans* (`QRScannerDialog`, `Equipment.qrSlug`,
  `checkoutWithQr`).
- Summary dev/deploy workflow (migrate → seed → commit migrations).

**Why:** asked where QR generation was documented, I grepped `docs/`, the
memory directory and the source tree, found only the equipment QR-*return*
path, and told the user it wasn't documented. It was — in the README, which I
never opened. The user had to correct me twice.

**How to apply:** when asked where something is documented, or before
answering "that isn't documented anywhere", grep `README.md` and `CLAUDE.md`
explicitly. `docs/` holds canonical *system* references
([[reference_feature_specs]], [[reference_date_handling]]); the README holds
*how the user does things*. Different questions, different files. Related:
[[feedback_check_current_docs_before_diagnosing]].
