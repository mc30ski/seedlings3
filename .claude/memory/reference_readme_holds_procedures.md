---
name: reference-readme-holds-procedures
description: "README.md documents operational procedures (QR generation, deploy workflow, dev photo-object seeding) — search it before claiming something is undocumented, and ADD to it when a procedure turns out to be unwritten"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-21T00:00:00.000Z
---

`README.md` (~557 lines) is not a stub. It carries **operational procedures**
that exist nowhere else in the repo — steps the user performs by hand, with
specific third-party tools and settings.

Known examples:
- **Equipment QR codes** (§ "Generating QR Codes", ~line 244): codes encode
  `https://seedlings.team/e/{slug}`, generated manually at
  `really-free-qr-code-generator.com` — Type URL, 128px, error correction M,
  margin 4, then printed and laminated. There is NO QR generator in the
  codebase; the app only *scans* (`QRScannerDialog`, `Equipment.qrSlug`,
  `checkoutWithQr`).
- **Seeding the dev photo objects** (§ "Object Storage (Cloudflare R2)",
  added 2026-11-21): `npx tsx scripts/seed-photo-objects.ts <dir-of-jpegs>`
  from `apps/api`, once per machine. `seed.ts` creates photo ROWS and never
  uploads bytes, so a fresh bucket leaves them pointing at nothing — broken
  frames on the wall, no thumbnails on Work → Now, and
  `display-stale-links-*` red. **This is the procedure whose absence from
  the README cost three debugging sessions across a month**; the script had
  existed the whole time. See [[project_now_tab]].
- Summary dev/deploy workflow (migrate → seed → commit migrations).

**Why:** asked where QR generation was documented, I grepped `docs/`, the
memory directory and the source tree, found only the equipment QR-*return*
path, and told the user it wasn't documented. It was — in the README, which I
never opened. The user had to correct me twice.

**The corollary, learned the hard way (2026-11-21):** when a procedure turns
out NOT to be written down — and you only discover that because something
was broken for weeks — write it into the README as part of the fix. The
photo-object script existed, worked, and refused unsafe buckets; nobody knew
to run it, so three sessions re-derived the symptom instead. A fix that
leaves the next person to rediscover the step is half a fix.

**How to apply:** when asked where something is documented, or before
answering "that isn't documented anywhere", grep `README.md` and `CLAUDE.md`
explicitly. `docs/` holds canonical *system* references
([[reference_feature_specs]], [[reference_date_handling]]); the README holds
*how the user does things*. Different questions, different files. Related:
[[feedback_check_current_docs_before_diagnosing]].
