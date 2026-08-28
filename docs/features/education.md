# Education guides

Training material workers can read, authored by Admins, published only by
a Super.

The motivating case: a worker standing on a lawn wants to know how to
fertilize Bermuda grass. Everything below follows from that — the content
has to be readable, trustworthy, and available on a phone.

## Roles

| | Worker | Admin | Super |
|---|---|---|---|
| Read published guides | ✔ | ✔ | ✔ |
| Search the catalog | ✔ | ✔ | ✔ |
| Create / edit drafts | — | ✔ | ✔ |
| Submit for approval | — | ✔ | ✔ |
| Approve / publish / send back | — | — | ✔ |
| Unpublish / roll back | — | — | ✔ |
| Archive / permanently delete | — | — | ✔ |
| Upload images | — | ✔ | ✔ |
| Manage images | — | own only | any |
| **Upload or manage video** | — | **—** | **✔** |
| Reference any existing media | ✔ (read) | ✔ | ✔ |

**Admins cannot publish their own work**, deliberately. Content stalls when
the Super is away; that is the accepted cost of the gate.

## State machine

```
        ┌──────── edit ────────┐
        ▼                      │
     DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ PUBLISHED
        ▲                      │                         │
        └──── send back ───────┘                    unpublish
                (REJECTED)                               │
                                                         ▼
                          rollback ◀────────────── ROLLED_BACK
```

`Guide.currentVersionId` points at the one PUBLISHED version workers read.
Editing never mutates it — a new DRAFT is created and reviewed while the
published version keeps serving. That is what makes "edit re-enters the
workflow" safe rather than disruptive.

**REJECTED is ours, not policies'.** "Send it back with a note" is the
common review outcome for training content; without it an author's only
signal is the version silently reverting to draft.

**Approve and publish are one step.** Policies separate them because a
policy version can be approved but held behind a grace period. A guide has
no such need, and a two-step flow would leave APPROVED versions invisible
to everyone — approved but unreadable is a state nobody asked for.

## Visibility is a query, not a flag

A worker's catalog query is scoped by `currentVersionId is not null` in the
WHERE clause. An unapproved guide cannot be *returned*, let alone rendered.
Hiding a draft client-side would still ship its body in the payload.

Enforced by `guides-build-gate.test.ts`.

## Media

### Storage

Its own R2 bucket, `R2_GUIDE_MEDIA_BUCKET_NAME`, keys
`guides/<guideId|library>/<uuid>.<ext>`. Per-purpose buckets is the house
pattern (there are seven): video lifecycle rules differ from receipts and
policy PDFs, and a stray cleanup script cannot reach across content types.

Uploads go **browser → presigned PUT → R2 directly**. That is what makes
video possible at all — routing bytes through the API would hit the
serverless request-body limit. R2 charges no egress, so workers streaming
video is a storage cost, not a bandwidth cost.

### Assets are immutable

There is no replace-in-place. Replacing an image under an approved page
would change published content without an approver ever seeing it, and the
approval gate would quietly become advisory. "Replacing" means uploading a
new asset and editing the page, which re-enters review.

### Video is Super-only

Video is the one asset class that can silently become expensive, and the
one with a format trap: phones record HEVC `.mov`, which Safari plays and
desktop Chrome/Firefox often will not. There is **no transcoding** — what
is uploaded is what plays. Concentrating uploads in one person means that
is learned once rather than repeatedly.

`.mov` is **accepted with a warning**, not rejected — the uploader is told
to export as MP4 (H.264) or set iPhone Camera → Formats → Most Compatible.

Admins still see every video and can reference one in a page. They cannot
add or remove.

### Size limits

| Setting | Default | Behaviour |
|---|---|---|
| `GUIDE_MAX_IMAGE_MB` | 10 | **Hard** — rejected. Admins are many; this is a real ceiling. |
| `GUIDE_MAX_VIDEO_MB` | 200 | **Soft** — warn, require an explicit override, audit it. One trusted uploader, so this catches accidents, not abuse. |
| `GUIDE_VIDEO_HARD_CEILING_MB` | 2048 | **Not overridable.** An override protects against "bigger than usual"; it does not protect against selecting the wrong file. |
| `GUIDE_MEDIA_ALLOWED_TYPES` | jpeg/png/webp/mp4/webm | Allowlist, not blocklist. |
| `GUIDE_ALLOWED_EMBED_DOMAINS` | youtube, vimeo | External embeds; anything else renders as a plain link. |

**The declared size is unenforceable.** A presigned PUT is signed on
content-type only, so a client can claim 5 MB and upload 5 GB. The true
size is read back from R2 with `headObject` after the upload and *that* is
what gets stored and enforced. An unverified byte count shown as metadata
is exactly the kind of number that is wrong for a year before anyone
notices.

### The library is paged

20 per page. Assets are immutable and outlive the guides that referenced
them, so this list is append-mostly and only grows — unpaged means an
unbounded payload and an unbounded wall of rows on a phone. Search narrows
the *total*, not just the visible page, so the pager never offers a page
that renders empty, and a new search resets to page 1 rather than leaving
you deep in the old result set looking at nothing.

### Media access is scoped too

`GET /me/guides/assets/:id/url` scopes workers the same way the catalog
does: the asset must appear in the body of a guide they can read. It
originally rested on asset ids being unguessable cuids — but those ids sit
in plain sight inside the markdown of any guide the caller can already
fetch, so a worker could keep pulling media from a guide that was later
unpublished. A blocked asset 404s exactly like a missing one.

Authors are exempt, because previewing a draft means seeing images that
are not in any published body yet.

### Deleting media is reference-checked

Assets are managed separately from pages, so without this someone
eventually deletes the image a live guide uses and a worker gets a broken
page in a field. Deletion is refused while any non-archived guide
references the asset, and the error names them — a Super deleting a video
especially needs telling, since they may not have written the page.

## Markdown

Rendered by `GuideMarkdown`, which wraps the shared `MarkdownContent` so a
guide looks like every other operator-authored document.

**In-app media**: `![alt](guide-asset:<id>)` resolves to a short-lived
signed URL at render time. The markdown never stores a URL, so a link
cannot expire inside approved content, and "which guides use this asset?"
is a string search rather than an HTML parse.

**Video**, without enabling raw HTML:

```
:::video guide-asset:<id>
:::video https://www.youtube.com/watch?v=...
```

Markdown has no video syntax. Turning on `rehype-raw` to get an `<iframe>`
would reopen XSS for every Admin author, so the directive is lifted out
before parsing and rendered as a real player instead.

**Because the directive is lifted out before parsing, react-markdown's
`urlTransform` never sees it** — the sanitizer that blanks `javascript:`
on every ordinary link does not apply here. A target that is not on the
embed allowlist is therefore scheme-checked before it may become an
`href`; anything but http/https renders as inert text. Without that,
`:::video javascript:alert(1)` produced a working `javascript:` link on a
page every worker can open. YouTube embeds go
through `youtube-nocookie` — this is internal training, so there is no
reason to hand a worker's viewing habits to an ad network. A host not on
the allowlist degrades to a plain link rather than silently embedding a
stranger's page.

### Cross-references between guides

```
[mowing heights](guide:mowing-heights-by-grass-type)
```

Navigates **within the app** rather than opening a tab, and resolves the
target's current title, so re-titling a guide cannot rot the link text.

**Resolution is scoped by the reader's own visibility**, using the same
`visibilityWhere` clause as the catalog. This is the part that matters: a
published guide may legitimately link to one still in draft, and link
resolution is a second door onto the catalog. An unresolvable target
degrades to the plain author-written label with no hint that anything is
hidden — a worker cannot tell "no such guide" from "a guide you may not
see". Authors get the same links flagged `(not published)` or
`(broken link)`, at the point where they can still be fixed.

`react-markdown` blanks any href outside http/https/mailto/tel, so
`MarkdownContent` carries a narrow `urlTransform` exception for this one
scheme and defers everything else to the library default. Without it every
cross-reference silently becomes an empty link.

**Inbound links are a warning, not a block.** Unlike a deleted asset — which
leaves a broken image in a live page — a link that stops resolving degrades
to plain text. So unpublishing or archiving tells a Super how many guides
point at this one and names them, then lets them proceed.

**Hierarchy was considered and rejected.** A page tree fights the approval
model: only versions are approved, so re-parenting a page would change what
workers find with nothing reviewed — the same hole that made assets
immutable. Category grouping plus search covers browsing at this corpus
size, and categories are settings-driven so widening the taxonomy is free.
The one thing flat cannot express is reading order; if onboarding ever needs
it, the answer is **ordered series** (a named list with positions), not
nesting.

## Permanent delete

Super-only, **archived-only**, behind a typed confirmation (the operator
retypes the guide title) — the same gate as "Approve as Worker".

The audit row snapshots the guide and every version body **before**
anything is destroyed, because afterwards it is the only record the guide
existed. Assets survive: they live in the library and may be referenced
elsewhere, so they are detached rather than cascade-deleted.

## Alerting

Pending approvals surface the standard way: an entry in the header alerts
dropdown ("Guides awaiting approval", blue — reviewing content is a task,
not an operational warning) **and** a matching inline section on the Tasks
page. The alert-ordering build gate fails the build if only one exists.

## Search

`contains`, case-insensitive, across title, summary, tags and body. At
catalog scale (tens to hundreds of pages) this is indistinguishable from
full-text and needs no `tsvector` column or GIN index. **Upgrade path**:
Postgres FTS when it stops being enough — this is a deliberate choice, not
an oversight. Workers only ever search published bodies.

## Audit

Every state change writes an `AuditEvent`: create, edit, submit, approve,
reject, publish, unpublish, roll back, archive, unarchive, purge, plus
asset upload, delete and size-limit override. `AuditScope.GUIDE` and
`GUIDE_ASSET` are Prisma enums, added by migration.

There is no `UPDATED` verb for assets, on purpose — they are immutable.

## Testing

| Layer | Where | Proves |
|---|---|---|
| Invariants | `guides-build-gate.test.ts` (34) | Worker scoping is a WHERE clause — for the catalog AND for link resolution; video is Super-only at every entry point; assets have no update path; size comes from R2; deletion is reference-checked; purge snapshots first; roles come from `req.user` not a DB read; every mutation sits behind a ConfirmDialog; `isPublished` is derived on both payloads; the editor never opens blank; the asset list is paged; the video directive is scheme-checked; worker media access is scoped; the edit path validates title + category |
| Ordering | `alert-ordering-build-gate.test.ts` | The alert and the Tasks section exist together and in the same order |
| Audit | `audit-coverage-build-gate.test.ts` | No unaudited mutation in `guides.ts` |
| Browser | `guides-worker.spec.ts`, `guides-admin.spec.ts` | A worker cannot see or reach unpublished content; the workflow round-trips |

## Deliberately not built

- **Worker feedback** ("was this helpful?") — asked for and declined.
- **Transcoding** — a separate product with its own cost. Revisit if `.mov`
  uploads become a recurring support burden.
- **Attaching guides to services or equipment** — the natural next step
  (policies already do it), and where this feature stops being a wiki
  nobody opens.
- **Offline caching** — workers are in the field with one bar; published
  markdown is small and this is the single most valuable follow-up.

---

## Setup (one-time)

Everything except **media upload** works today. Authoring, the approval
workflow, reading, search and the alerts need nothing new. Until the
bucket below exists, an upload returns a 503 that names the missing
variable rather than an opaque SDK error.

### 1. Create the R2 buckets — a dev/prod pair

Every other bucket in this account is a pair, and guides follow it:

| | Bucket |
|---|---|
| Production | `seedlings-guides` |
| Dev | `seedlings-guides-dev` |

The name follows the `seedlings-promotions` precedent — the feature noun,
not the env-var name. (`R2_PROMOTION_IMAGES_BUCKET_NAME` points at
`seedlings-promotions`; the variable and the bucket have never had to
match.)

Cloudflare dashboard → R2 → **Create bucket**, twice.

- Location: Automatic
- **No lifecycle / auto-delete rule** on either. This is a permanent
  bucket, like documents and receipts — approved guides reference these
  objects indefinitely, and an expiry rule would break published pages.

### 2. Re-scope the R2 API token

R2 → **Manage R2 API Tokens** → the existing Object Read & Write token →
Edit. It is scoped to a bucket list, so the two new buckets have to be
added or every upload fails with `AccessDenied`.

The access key and secret do not change, so no other env var moves.

### 3. Add the CORS policy

R2 → each bucket → Settings → CORS policy. The browser PUTs bytes straight
to R2, so without this every upload fails with an opaque CORS error.

The prod bucket does not need localhost, and the dev bucket does not need
the production domains — but a single shared policy is what the other
buckets use, and splitting them buys nothing here.

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "https://seedlings.team",
      "https://seedlingslawncare.com",
      "https://*.vercel.app"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 4. Set the env var

One variable, pointing at a different bucket per environment. The existing
R2 credentials are reused.

| Where | Value |
|---|---|
| `apps/api/.env` (local dev) | `R2_GUIDE_MEDIA_BUCKET_NAME=seedlings-guides-dev` — add it next to the other `R2_*_BUCKET_NAME` lines, then restart the API |
| Vercel → Preview | `seedlings-guides-dev` |
| Vercel → Production | `seedlings-guides` |

Preview points at the dev bucket deliberately: a preview deploy is
throwaway, and letting it write into the production bucket is how test
uploads end up in front of workers.

### 5. Verify

Sign in as Super → Records → Guides → **Media library** → Add image. A
successful upload lists the file with its size read back from R2.

Then as Admin: the Add video button should not be there at all, and any
existing video should still be listed and referenceable.

### Settings you may want to change

All six live in the `Setting` table and take effect without a deploy.
Editing `seed.ts` alone is not enough for an existing database — upsert
the row directly, then copy to production through the Neon UI.

| Key | Default |
|---|---|
| `GUIDE_CATEGORIES` | lawn-care, equipment, safety, admin |
| `GUIDE_MAX_IMAGE_MB` | 10 (hard) |
| `GUIDE_MAX_VIDEO_MB` | 200 (soft — Super can override) |
| `GUIDE_VIDEO_HARD_CEILING_MB` | 2048 (not overridable) |
| `GUIDE_MEDIA_ALLOWED_TYPES` | jpeg, png, webp, mp4, webm |
| `GUIDE_ALLOWED_EMBED_DOMAINS` | youtube, youtu.be, vimeo |
