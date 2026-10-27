# Route → entitlement mapping

**Derived from the route guards. Reviewed 2026-10-13 — every group eyeballed.**

> There is no committed generator script: this file is maintained by hand and
> **G5 fails the build whenever it and the guards disagree**, which is what
> keeps it honest. Two ad-hoc "reconcile" scripts destroyed it in the past by
> rewriting rows they did not understand — edit it by hand, let G5 check you.

645 distinct method+path pairs, 0 unmapped, 63 entitlements.

Nine duplicated read routes were DELETED outright rather than renamed: an `admin`-prefixed and a `super`-prefixed path for `/documents` (and the same for `/timeline`) ran the same handler twice, differing only in `restrictedVisible` — and gated on the SAME entitlement, so the URL prefix was the only thing separating them. That let the CLIENT pick its own privilege level by choosing a URL. A path is not a check. Each pair is now one route on a neutral path (`/documents`, `/timeline`) that decides how much to return from a capability.

## The finding that mattered

`schedule.manage` was a **catch-all for every occurrence sub-route**:

```
POST /occurrences/:x/write-off           writes off a payment
POST /occurrences/:x/mark-paid           marks a visit paid
POST /occurrences/:x/recalculate-splits  changes worker pay
POST /occurrences/:x/completion-splits   sets who gets what share
POST /occurrences/:x/approve-hours       approves payroll hours
```

**A manager given scheduling rights could have written off payments and
changed what workers get paid** — behind a label reading "create, move and
reschedule visits". Gated as **G18**.

## Two more that were security-shaped

- **`/client-contacts/:contactId/link-clerk`** binds a LOGIN IDENTITY to a
  client record — that is how a client gets portal access. It sat inside
  `clients.manage`. Now `identity.link`.
- **`POST`/`DELETE /users/:x/roles`** and `/privileges` are ROLE
  GRANTING, inside plain `people.manage`. They are bound by *you cannot
  grant what you do not hold* (**G6**), so they are their own bucket, not an
  ordinary management right.

## Everything else corrected across five passes

- own earnings, own `/dashboard-summary`, and `like`/`pin` bookmarks → OWNERSHIP
- `/invoice-charges` → `materials.charge` (bills the CLIENT), not `expenses.charge`
- `pause`/`resume` → `work.claim`; admin recording a collection → `money.record`
- `payroll.*` split from `books.*` — payroll is individual WAGES
- `reject-estimate` rejoined `accept-estimate`; they had been split
- `clients.contribute` RESTORED — `/properties/:x/photos` is contribute-shaped;
  a photographer should not need `clients.manage` to add a property photo
- `/equipment/:x/return/verify` → `inventory.pull`, the counterpart of checkout
- `crews.view` and `content.view` added for verb consistency
- `/board` → `schedule.view`; it is built for everyone

> **`expenses.charge` has NO enforcing route today.** Stored, displayed,
> checked nowhere. Step 2 must add the check to business-expense creation.

## areas.manage  (9)
| | |
|---|---|
| `DELETE` | `/area-assignments/:x` |
| `GET` | `/area-assignments` |
| `GET` | `/areas` |
| `PATCH` | `/areas/:x` |
| `PATCH` | `/properties/:x/area` |
| `POST` | `/area-assignments` |
| `POST` | `/areas/:x/retire` |
| `POST` | `/areas/:x/unretire` |
| `POST` | `/areas` |

## audit.view  (4)
| | |
|---|---|
| `GET` | `/activity` |
| `GET` | `/audit` |
| `GET` | `/promotions/:x/audit` |
| `GET` | `/users/:x/activity` |

## books.export-tax  (5)
| | |
|---|---|
| `GET` | `/exports/capital.csv` |
| `GET` | `/exports/expenses.csv` |
| `GET` | `/exports/income.csv` |
| `GET` | `/exports/payroll.csv` |
| `GET` | `/exports/workdays.csv` |

## books.manage  (13)
| | |
|---|---|
| `DELETE` | `/business-expenses/:x/receipt` |
| `DELETE` | `/business-expenses/:x` |
| `DELETE` | `/ledger-followups/:x` |
| `PATCH` | `/business-expenses/:x` |
| `PATCH` | `/ledger-followups/:x` |
| `PATCH` | `/supply-purchases/:x/ledger-link` |
| `POST` | `/business-expenses/:x/end-recurrence-series` |
| `POST` | `/business-expenses/:x/receipt/upload-url` |
| `POST` | `/business-expenses/:x/receipt` |
| `POST` | `/business-expenses/:x/reconcile` |
| `POST` | `/business-expenses/:x/skip-recurrence` |
| `POST` | `/ledger-followups/:x/resolve` |
| `POST` | `/ledger-followups` |

## books.view  (18)
| | |
|---|---|
| `GET` | `/business-expenses/:x/receipt-url` |
| `GET` | `/business-expenses/:x` |
| `GET` | `/business-expenses/due-soon/count` |
| `GET` | `/business-expenses/due-soon` |
| `GET` | `/business-expenses/match-recurring` |
| `GET` | `/business-expenses/pnl-report/details` |
| `GET` | `/business-expenses/pnl-report` |
| `GET` | `/business-expenses/summary` |
| `GET` | `/business-expenses/vs-revenue` |
| `GET` | `/business-expenses` |
| `GET` | `/export-summary` |
| `GET` | `/export` |
| `GET` | `/ledger-charges` |
| `GET` | `/ledger-followups/count` |
| `GET` | `/ledger-followups/map` |
| `GET` | `/ledger-followups` |
| `GET` | `/receipts/lookup` |
| `GET` | `/reconcile/period` |

## clients.contribute  (5)
| | |
|---|---|
| `DELETE` | `/properties/:x/photos/:x` |
| `GET` | `/properties/:x/photos` |
| `PATCH` | `/properties/:x/photos/:x` |
| `POST` | `/properties/:x/photos/confirm` |
| `POST` | `/properties/:x/photos/upload-url` |

## clients.manage  (17)
| | |
|---|---|
| `DELETE` | `/clients/:x/contacts/:x` |
| `DELETE` | `/clients/:x` |
| `DELETE` | `/properties/:x` |
| `PATCH` | `/clients/:x/contacts/:x` |
| `PATCH` | `/clients/:x` |
| `PATCH` | `/properties/:x` |
| `POST` | `/clients/:x/archive` |
| `POST` | `/clients/:x/contacts/:x/primary` |
| `POST` | `/clients/:x/contacts` |
| `POST` | `/clients/:x/unarchive` |
| `POST` | `/clients` |
| `POST` | `/contacts/:x/archive` |
| `POST` | `/contacts/:x/unarchive` |
| `POST` | `/properties/:x/archive` |
| `POST` | `/properties/:x/primary-contact` |
| `POST` | `/properties/:x/unarchive` |
| `POST` | `/properties` |

## clients.view  (13)
| | |
|---|---|
| `GET` | `/client-contacts/check` |
| `GET` | `/client-contacts/unlinked` |
| `GET` | `/clients/:x/archive-preview` |
| `GET` | `/clients/:x/unarchive-preview` |
| `GET` | `/clients/:x` |
| `GET` | `/clients/unlinked-accounts` |
| `GET` | `/clients` |
| `GET` | `/properties/:x/archive-preview` |
| `GET` | `/properties/:x/unarchive-preview` |
| `GET` | `/properties/:x` |
| `GET` | `/properties` |
| `GET` | `/properties/points` |
| `POST` | `/properties/points/resolve` |

## clients.view-as  (1)
| | |
|---|---|
| `GET` | `/clients/:x/impersonatable-contacts` |

## compliance.manage  (21)
| | |
|---|---|
| `DELETE` | `/policies/:x/permanent` |
| `DELETE` | `/policies/exceptions/:x` |
| `PATCH` | `/policies/:x` |
| `PATCH` | `/policies/versions/:x` |
| `POST` | `/policies/:x/archive` |
| `POST` | `/policies/:x/exceptions` |
| `POST` | `/policies/:x/force-resign` |
| `POST` | `/policies/:x/unarchive` |
| `POST` | `/policies/:x/versions` |
| `POST` | `/policies/nudge` |
| `POST` | `/policies/signatures/:x/review` |
| `POST` | `/policies/signatures/:x/revoke` |
| `POST` | `/policies/upload-on-behalf/upload-url` |
| `POST` | `/policies/upload-on-behalf` |
| `POST` | `/policies/versions/:x/approve` |
| `POST` | `/policies/versions/:x/confirm-pdf` |
| `POST` | `/policies/versions/:x/pdf-upload-url` |
| `POST` | `/policies/versions/:x/publish` |
| `POST` | `/policies/versions/:x/rollback` |
| `POST` | `/policies/versions/:x/submit` |
| `POST` | `/policies` |

## compliance.view  (9)
| | |
|---|---|
| `GET` | `/policies/:x` |
| `GET` | `/policies/attachable-to-equipment` |
| `GET` | `/policies/counts` |
| `GET` | `/policies/pending-approvals` |
| `GET` | `/policies/pending-upload-reviews` |
| `GET` | `/policies/sign-matrix` |
| `GET` | `/policies/user-compliance` |
| `GET` | `/policies/versions/:x/content-url` |
| `GET` | `/policies` |

## content.approve  (8)
| | |
|---|---|
| `GET` | `/guides/pending-approvals/count` |
| `GET` | `/guides/pending-approvals` |
| `POST` | `/guides/:x/archive` |
| `POST` | `/guides/:x/purge` |
| `POST` | `/guides/:x/unpublish` |
| `POST` | `/guides/versions/:x/approve` |
| `POST` | `/guides/versions/:x/reject` |
| `POST` | `/guides/versions/:x/rollback` |

## content.manage  (8)
| | |
|---|---|
| `DELETE` | `/guides/assets/:x` |
| `DELETE` | `/guides/versions/:x` |
| `PATCH` | `/guides/:x` |
| `POST` | `/guides/:x/draft` |
| `POST` | `/guides/assets/finalize` |
| `POST` | `/guides/assets/upload-url` |
| `POST` | `/guides/versions/:x/submit` |
| `POST` | `/guides` |

## content.view  (4)
| | |
|---|---|
| `GET` | `/guides/:x/inbound-links` |
| `GET` | `/guides/assets/:x/references` |
| `GET` | `/guides/assets` |
| `GET` | `/guides/limits` |

## crews.manage  (9)
| | |
|---|---|
| `DELETE` | `/groups/:x/members/:x` |
| `DELETE` | `/groups/preferred-equipment/:x` |
| `PATCH` | `/groups/:x/members/:x` |
| `PATCH` | `/groups/:x` |
| `POST` | `/groups/:x/archive` |
| `POST` | `/groups/:x/members` |
| `POST` | `/groups/:x/preferred-equipment` |
| `POST` | `/groups/:x/unarchive` |
| `POST` | `/groups` |

## crews.view  (2)
| | |
|---|---|
| `GET` | `/groups/:x` |
| `GET` | `/groups` |

## displays.manage  (5)
| | |
|---|---|
| `GET` | `/displays` |
| `PATCH` | `/displays/:x` |
| `POST` | `/displays/:x/revoke` |
| `POST` | `/displays/approve` |
| `POST` | `/photos/:x/visibility` |

## documents.manage  (13)
| | |
|---|---|
| `DELETE` | `/documents/:x/versions/:x` |
| `DELETE` | `/documents/:x` |
| `PATCH` | `/documents/:x` |
| `POST` | `/documents/:x/archive` |
| `POST` | `/documents/:x/unarchive` |
| `POST` | `/documents/:x/versions/:x/confirm` |
| `POST` | `/documents/:x/versions/:x/restore` |
| `POST` | `/documents/:x/versions/init` |
| `POST` | `/documents/sync/backfill` |
| `POST` | `/documents/sync/run` |
| `POST` | `/documents/sync/tasks/:x/dismiss` |
| `POST` | `/documents/sync/tasks/:x/retry` |
| `POST` | `/documents` |

## documents.view  (8)
| | |
|---|---|
| `GET` | `/documents/:x/versions/:x/text` |
| `GET` | `/documents/:x/versions/:x/url` |
| `GET` | `/documents/:x` |
| `GET` | `/documents/expiration-counts` |
| `GET` | `/documents/sync/failed` |
| `GET` | `/documents/sync/pending` |
| `GET` | `/documents/sync/status` |
| `GET` | `/documents` |

## equipment.capital  (8)
| | |
|---|---|
| `DELETE` | `/equipment/:x` |
| `PATCH` | `/vehicles/:x` |
| `POST` | `/equipment` |
| `POST` | `/vehicles/:x/archive` |
| `POST` | `/vehicles/:x/assign` |
| `POST` | `/vehicles/:x/unarchive` |
| `POST` | `/vehicles/:x/unassign` |
| `POST` | `/vehicles` |

## equipment.manage  (20)
| | |
|---|---|
| `DELETE` | `/equipment-collections/:x` |
| `DELETE` | `/equipment/:x/instructions/:x` |
| `DELETE` | `/equipment/:x/photos/:x` |
| `PATCH` | `/equipment-collections/:x` |
| `PATCH` | `/equipment/:x/instructions/:x` |
| `PATCH` | `/equipment/:x/photos/:x` |
| `PATCH` | `/equipment/:x` |
| `POST` | `/equipment-collections` |
| `POST` | `/equipment/:x/checkout-for/verify` |
| `POST` | `/equipment/:x/instructions` |
| `POST` | `/equipment/:x/maintenance/end` |
| `POST` | `/equipment/:x/maintenance/start` |
| `POST` | `/equipment/:x/photos/confirm` |
| `POST` | `/equipment/:x/photos/upload-url` |
| `POST` | `/equipment/:x/release` |
| `POST` | `/equipment/:x/reserve-for/cancel` |
| `POST` | `/equipment/:x/reserve-for` |
| `POST` | `/equipment/:x/retire` |
| `POST` | `/equipment/:x/return-for/verify` |
| `POST` | `/equipment/:x/unretire` |

## equipment.view  (13)
| | |
|---|---|
| `GET` | `/equipment-collections` |
| `GET` | `/equipment-usage` |
| `GET` | `/equipment/:x/photos` |
| `GET` | `/equipment/all` |
| `GET` | `/equipment/available` |
| `GET` | `/equipment/liked` |
| `GET` | `/equipment/mine` |
| `GET` | `/equipment/pinned` |
| `GET` | `/equipment/unavailable` |
| `GET` | `/equipment` |
| `GET` | `/holdings` |
| `GET` | `/payments/equipment-charges` |
| `GET` | `/vehicles` |

## estimates.accept  (4)
| | |
|---|---|
| `POST` | `/occurrences/:x/accept-estimate` |
| `POST` | `/occurrences/:x/accept-proposal` |
| `POST` | `/occurrences/:x/reject-estimate` |
| `POST` | `/occurrences/:x/reject-proposal` |

## estimates.create  (7)
| | |
|---|---|
| `DELETE` | `/light-estimates/:x` |
| `GET` | `/estimates/stale-followup-count` |
| `PATCH` | `/light-estimates/:x` |
| `POST` | `/convert-light-estimate` |
| `POST` | `/light-estimates` |
| `POST` | `/occurrences/:x/generate-estimate` |
| `POST` | `/occurrences/:x/submit-proposal` |

## expenses.charge  (1)
| | |
|---|---|
| `POST` | `/business-expenses` |

## forecasts.view  (9)
| | |
|---|---|
| `DELETE` | `/forecasts/:x` |
| `GET` | `/forecast/baseline` |
| `GET` | `/forecasts/:x` |
| `GET` | `/forecasts` |
| `PATCH` | `/forecasts/:x` |
| `POST` | `/forecasts/:x/archive` |
| `POST` | `/forecasts/:x/assess` |
| `POST` | `/forecasts/:x/duplicate` |
| `POST` | `/forecasts` |

## identity.link  (2)
| | |
|---|---|
| `DELETE` | `/client-contacts/:x/link-clerk` |
| `POST` | `/client-contacts/:x/link-clerk` |

## inventory.pull  (7)
| | |
|---|---|
| `DELETE` | `/supply-holds/:x` |
| `PATCH` | `/supply-holds/:x` |
| `POST` | `/equipment/:x/checkout/verify` |
| `POST` | `/equipment/:x/reserve/cancel` |
| `POST` | `/equipment/:x/reserve` |
| `POST` | `/equipment/:x/return/verify` |
| `POST` | `/occurrences/:x/supply-holds` |

## marketing.campaigns  (48)
| | |
|---|---|
| `DELETE` | `/promotions/:x` |
| `DELETE` | `/promotions/invoice-photos/:x` |
| `DELETE` | `/promotions/landing/items/:x` |
| `DELETE` | `/promotions/landing/photos/:x` |
| `DELETE` | `/vanity/:x/image` |
| `DELETE` | `/vanity/:x` |
| `GET` | `/promotions/:x/deliveries` |
| `GET` | `/promotions/:x/invoice-photos` |
| `GET` | `/promotions/:x/landing` |
| `GET` | `/promotions/:x` |
| `GET` | `/promotions/allowed-domains` |
| `GET` | `/promotions/contacts/:x/history` |
| `GET` | `/promotions/contacts` |
| `GET` | `/promotions` |
| `GET` | `/vanity/:x` |
| `GET` | `/vanity/animation-settings` |
| `GET` | `/vanity` |
| `PATCH` | `/promotions/:x` |
| `PATCH` | `/promotions/landing/:x` |
| `PATCH` | `/promotions/landing/items/:x` |
| `PATCH` | `/vanity/:x/default` |
| `PATCH` | `/vanity/:x/startup-animation` |
| `PATCH` | `/vanity/:x` |
| `PATCH` | `/vanity/animation-settings` |
| `PATCH` | `/vanity/reorder` |
| `POST` | `/promotions/:x/duplicate` |
| `POST` | `/promotions/:x/invoice-photos/confirm` |
| `POST` | `/promotions/:x/invoice-photos/reorder` |
| `POST` | `/promotions/:x/invoice-photos/upload-url` |
| `POST` | `/promotions/:x/landing/preview-url` |
| `POST` | `/promotions/:x/landing` |
| `POST` | `/promotions/:x/pause` |
| `POST` | `/promotions/:x/resume` |
| `POST` | `/promotions/:x/retire` |
| `POST` | `/promotions/:x/send-now` |
| `POST` | `/promotions/:x/start` |
| `POST` | `/promotions/:x/test-send` |
| `POST` | `/promotions/contacts/:x/opt` |
| `POST` | `/promotions/landing/:x/items/:x/upload-url` |
| `POST` | `/promotions/landing/:x/items/reorder` |
| `POST` | `/promotions/landing/:x/items` |
| `POST` | `/promotions/landing/items/:x/confirm-image` |
| `POST` | `/promotions/landing/items/:x/photos/reorder` |
| `POST` | `/promotions/rotate-hmac-secret` |
| `POST` | `/promotions` |
| `POST` | `/vanity/:x/confirm-image` |
| `POST` | `/vanity/:x/image-upload-url` |
| `POST` | `/vanity` |

## marketing.manage  (6)
| | |
|---|---|
| `DELETE` | `/announcements/:x` |
| `DELETE` | `/banners/:x` |
| `PATCH` | `/announcements/:x` |
| `POST` | `/announcements/:x/complete` |
| `POST` | `/announcements` |
| `POST` | `/banners` |

## marketing.view  (1)
| | |
|---|---|
| `GET` | `/banners` |

## materials.charge  (5)
| | |
|---|---|
| `DELETE` | `/invoice-charges/:x` |
| `GET` | `/occurrences/:x/invoice-charges` |
| `PATCH` | `/invoice-charges/:x/ledger-link` |
| `PATCH` | `/invoice-charges/:x` |
| `POST` | `/occurrences/:x/invoice-charges` |

## money.adjust  (1)
| | |
|---|---|
| `POST` | `/occurrences/:x/recalculate-splits` |

## money.approve  (9)
| | |
|---|---|
| `DELETE` | `/payments/:x` |
| `PATCH` | `/payments/:x` |
| `POST` | `/occurrences/:x/write-off` |
| `POST` | `/payments/:x/approve` |
| `POST` | `/payments/:x/reject` |
| `POST` | `/payments/:x/revert` |
| `POST` | `/payments/:x/skip` |
| `POST` | `/payments/:x/unskip` |
| `POST` | `/payments/:x/write-off` |

## money.record  (2)
| | |
|---|---|
| `POST` | `/occurrences/:x/mark-paid` |
| `POST` | `/occurrences/:x/resend-payment-request` |

## money.view  (3)
| | |
|---|---|
| `GET` | `/payment-requests/outstanding` |
| `GET` | `/payments/pending` |
| `GET` | `/payments` |

## notify.send  (6)
| | |
|---|---|
| `DELETE` | `/notification-templates/:x` |
| `GET` | `/notification-templates` |
| `GET` | `/notify/history` |
| `PATCH` | `/notification-templates/:x` |
| `POST` | `/notification-templates` |
| `POST` | `/notify` |

## payroll.manage  (5)
| | |
|---|---|
| `DELETE` | `/payroll/identities` |
| `GET` | `/payroll/identities/unmatched` |
| `POST` | `/payroll/identities` |
| `POST` | `/payroll/import` |
| `POST` | `/payroll/periods/:x/archive` |

## payroll.view  (4)
| | |
|---|---|
| `GET` | `/payroll/periods/:x/entries` |
| `GET` | `/payroll/periods` |
| `GET` | `/users/:x/earnings-summary` |
| `GET` | `/workers/earnings-today` |

## people.approve  (1)
| | |
|---|---|
| `POST` | `/users/:x/approve` |

## people.grant-roles  (3)
| | |
|---|---|
| `DELETE` | `/users/:x/roles/:x` |
| `POST` | `/users/:x/roles/move` |
| `POST` | `/users/:x/roles` |

## people.manage  (5)
| | |
|---|---|
| `DELETE` | `/users/:x` |
| `GET` | `/users/:x/effective-permissions` |
| `PATCH` | `/users/:x/home-base` |
| `PATCH` | `/users/:x/profile` |
| `PATCH` | `/users/:x/worker-type` |

## people.view  (5)
| | |
|---|---|
| `GET` | `/users/:x/group-archive-cascade` |
| `GET` | `/users/:x` |
| `GET` | `/users/pendingCount` |
| `GET` | `/users` |
| `GET` | `/workers` |

## pricing.manage  (3)
| | |
|---|---|
| `DELETE` | `/pricing/:x` |
| `PATCH` | `/pricing/:x` |
| `POST` | `/pricing` |

## pricing.view  (1)
| | |
|---|---|
| `GET` | `/pricing` |

## reports.business  (1)
| | |
|---|---|
| `GET` | `/operations` |

## reports.view  (2)
| | |
|---|---|
| `GET` | `/dashboard-summary/aggregate` |
| `GET` | `/statistics` |

## roles.define  (7)
| | |
|---|---|
| `DELETE` | `/roles/:x` |
| `PATCH` | `/roles/:x` |
| `POST` | `/roles/:x/suspend` |
| `POST` | `/roles/:x/unsuspend` |
| `POST` | `/roles` |
| `PUT` | `/roles/:x/entitlements` |
| `PUT` | `/roles/perspectives/order` |

## roles.view  (3)
| | |
|---|---|
| `GET` | `/entitlements` |
| `GET` | `/roles/:x/holders` |
| `GET` | `/roles` |

## routes.plan  (1)
| | |
|---|---|
| `GET` | `/routes/operations` |

## schedule.contribute  (15)
| | |
|---|---|
| `DELETE` | `/occurrences/:x/instructions/:x` |
| `DELETE` | `/occurrences/:x/photos/:x` |
| `DELETE` | `/occurrences/comments/:x` |
| `DELETE` | `/photos/:x` |
| `GET` | `/occurrences/:x/comments` |
| `GET` | `/occurrences/:x/photos` |
| `GET` | `/photos` |
| `PATCH` | `/occurrences/:x/customer-notes` |
| `PATCH` | `/occurrences/:x/instructions/:x` |
| `PATCH` | `/occurrences/:x/pinned-note` |
| `PATCH` | `/occurrences/comments/:x` |
| `POST` | `/occurrences/:x/comments` |
| `POST` | `/occurrences/:x/instructions` |
| `POST` | `/occurrences/:x/photos/confirm` |
| `POST` | `/occurrences/:x/photos/upload-url` |

## schedule.manage  (40)
| | |
|---|---|
| `DELETE` | `/events/:x` |
| `DELETE` | `/jobs/:x/default-assignees/:x` |
| `DELETE` | `/jobs/:x` |
| `DELETE` | `/occurrences/:x` |
| `GET` | `/pause-reasons` |
| `PATCH` | `/events/:x` |
| `PATCH` | `/jobs/:x/default-assignees/:x/role` |
| `PATCH` | `/jobs/:x` |
| `PATCH` | `/occurrences/:x/area` |
| `PATCH` | `/occurrences/:x/price` |
| `PATCH` | `/occurrences/:x/stream-pause` |
| `PATCH` | `/occurrences/:x` |
| `POST` | `/change-requests/:x/approve` |
| `POST` | `/change-requests/:x/deny` |
| `POST` | `/events/:x/complete` |
| `POST` | `/events` |
| `POST` | `/followups` |
| `POST` | `/jobs/:x/archive` |
| `POST` | `/jobs/:x/default-assignees/:x/make-claimer` |
| `POST` | `/jobs/:x/default-assignees/add` |
| `POST` | `/jobs/:x/occurrences` |
| `POST` | `/jobs/:x/unarchive` |
| `POST` | `/jobs` |
| `POST` | `/occurrences/:x/archive` |
| `POST` | `/occurrences/:x/attach-group` |
| `POST` | `/occurrences/:x/detach-group` |
| `POST` | `/occurrences/:x/force-next` |
| `POST` | `/occurrences/:x/link-to-job` |
| `POST` | `/occurrences/:x/link` |
| `POST` | `/occurrences/:x/next-start-override` |
| `POST` | `/occurrences/:x/skip` |
| `POST` | `/occurrences/:x/stream-pause` |
| `POST` | `/occurrences/:x/stream-resume` |
| `POST` | `/occurrences/:x/unlink` |
| `PUT` | `/jobs/:x/default-assignees` |
| `PUT` | `/jobs/:x/default-group` |
| `PUT` | `/jobs/:x/property-photos` |
| `PUT` | `/jobs/:x/recommended-collections` |
| `PUT` | `/occurrences/:x/assignees` |
| `PUT` | `/occurrences/:x/property-photos` |

## schedule.view  (27)
| | |
|---|---|
| `GET` | `/board` |
| `GET` | `/change-requests/pending-count` |
| `GET` | `/change-requests` |
| `GET` | `/jobs/:x/pause-preview` |
| `GET` | `/jobs/:x/property-photos` |
| `GET` | `/jobs/:x/recommended-collections` |
| `GET` | `/jobs/:x` |
| `GET` | `/jobs/archived` |
| `GET` | `/jobs` |
| `GET` | `/occurrences/:x/comms-handoff` |
| `GET` | `/occurrences/:x/hourly-weather` |
| `GET` | `/occurrences/:x/invoice-preview` |
| `GET` | `/occurrences/:x/linked` |
| `GET` | `/occurrences/:x/property-photos` |
| `GET` | `/occurrences/:x/site-hint` |
| `GET` | `/occurrences/:x/team-workday-check` |
| `GET` | `/occurrences/available` |
| `GET` | `/occurrences/ghost-expiry-counts` |
| `GET` | `/occurrences/liked` |
| `GET` | `/occurrences/mine` |
| `GET` | `/occurrences/pinned` |
| `GET` | `/occurrences` |
| `GET` | `/reminders` |
| `GET` | `/stream-pauses/reminders/count` |
| `GET` | `/stream-pauses/reminders` |
| `GET` | `/weather/location` |
| `GET` | `/weather` |

## settings.manage  (3)
| | |
|---|---|
| `PATCH` | `/settings/:x` |
| `PATCH` | `/users/:x/owner` |
| `POST` | `/system-audit` |

## supplies.manage  (12)
| | |
|---|---|
| `DELETE` | `/supplies/:x/photos/:x` |
| `DELETE` | `/supplies/purchases/:x` |
| `GET` | `/supplies/upc-lookup` |
| `PATCH` | `/supplies/:x/photos/:x` |
| `PATCH` | `/supplies/:x` |
| `POST` | `/supplies/:x/adjustments` |
| `POST` | `/supplies/:x/archive` |
| `POST` | `/supplies/:x/photos/confirm` |
| `POST` | `/supplies/:x/photos/upload-url` |
| `POST` | `/supplies/:x/purchases` |
| `POST` | `/supplies/:x/unarchive` |
| `POST` | `/supplies` |

## supplies.view  (4)
| | |
|---|---|
| `GET` | `/supplies/:x/history` |
| `GET` | `/supplies/:x/photos` |
| `GET` | `/supplies/:x` |
| `GET` | `/supplies` |

## time.approve  (3)
| | |
|---|---|
| `GET` | `/occurrences/unapproved-hours-count` |
| `GET` | `/occurrences/unapproved-hours` |
| `POST` | `/occurrences/:x/approve-hours` |

## time.manage  (11)
| | |
|---|---|
| `PATCH` | `/mileage/:x` |
| `PATCH` | `/workdays/:x` |
| `POST` | `/mileage/:x/approve` |
| `POST` | `/mileage/:x/reject` |
| `POST` | `/mileage/:x/unapprove` |
| `POST` | `/mileage/approve-day` |
| `POST` | `/vehicles/:x/mileage` |
| `POST` | `/workdays/:x/approve` |
| `POST` | `/workdays/:x/unapprove` |
| `POST` | `/workdays/bulk-approve` |
| `POST` | `/workdays/create` |

## time.view  (5)
| | |
|---|---|
| `GET` | `/mileage/by-date` |
| `GET` | `/mileage/pending-summary` |
| `GET` | `/vehicles/:x/mileage` |
| `GET` | `/workdays/by-date` |
| `GET` | `/workdays/pending-summary` |

## timeline.manage  (6)
| | |
|---|---|
| `DELETE` | `/timeline/:x` |
| `PATCH` | `/timeline/:x` |
| `POST` | `/timeline/:x/archive` |
| `POST` | `/timeline/:x/complete` |
| `POST` | `/timeline/:x/unarchive` |
| `POST` | `/timeline` |

## timeline.view  (4)
| | |
|---|---|
| `GET` | `/timeline/:x` |
| `GET` | `/timeline/upcoming-counts` |
| `GET` | `/timeline/upcoming` |
| `GET` | `/timeline` |

## work.claim  (4)
| | |
|---|---|
| `POST` | `/occurrences/:x/claim` |
| `POST` | `/occurrences/:x/pause` |
| `POST` | `/occurrences/:x/resume` |
| `POST` | `/occurrences/:x/unclaim` |

## work.complete  (3)
| | |
|---|---|
| `POST` | `/occurrences/:x/accept-payment` |
| `POST` | `/occurrences/:x/complete` |
| `POST` | `/occurrences/:x/start` |

## OWNERSHIP  (103)
| | |
|---|---|
| `DELETE` | `/calendar-feeds/:x` |
| `DELETE` | `/followups/:x` |
| `DELETE` | `/me/push-subscriptions/:x` |
| `DELETE` | `/occurrences/:x/addons/:x` |
| `DELETE` | `/occurrences/:x/assignees/:x` |
| `DELETE` | `/standalone-reminders/:x` |
| `DELETE` | `/tasks/:x` |
| `GET` | `/calendar-feeds` |
| `GET` | `/dashboard-summary` |
| `GET` | `/me/business-start` |
| `GET` | `/me/groups-as-claimer` |
| `GET` | `/me/groups` |
| `GET` | `/me/guides/:x` |
| `GET` | `/me/guides/assets/:x/url` |
| `GET` | `/me/guides/assets/resolve` |
| `GET` | `/me/guides/categories` |
| `GET` | `/me/guides/resolve` |
| `GET` | `/me/guides` |
| `GET` | `/me/hourly-pay` |
| `GET` | `/me/mileage/open` |
| `GET` | `/me/mileage` |
| `GET` | `/me/outstanding-payment-requests` |
| `GET` | `/me/payroll/:x` |
| `GET` | `/me/payroll/latest` |
| `GET` | `/me/payroll/pending-match` |
| `GET` | `/me/payroll` |
| `GET` | `/me/policies/count` |
| `GET` | `/me/policies/download` |
| `GET` | `/me/policies` |
| `GET` | `/me/properties/:x/parcel/image` |
| `GET` | `/me/properties/:x/parcel` |
| `GET` | `/me/push-subscriptions` |
| `GET` | `/me/statistics` |
| `GET` | `/me/team` |
| `GET` | `/me/vehicle-summary` |
| `GET` | `/me/vehicles` |
| `GET` | `/me/workday/open-prior` |
| `GET` | `/me/workday/today` |
| `GET` | `/me` |
| `GET` | `/payments/earnings-summary` |
| `GET` | `/payments/mine` |
| `GET` | `/payments/title-bar-earnings` |
| `GET` | `/preview/route-suggestions` |
| `GET` | `/preview/routing-providers` |
| `GET` | `/settings` |
| `PATCH` | `/followups/:x` |
| `PATCH` | `/me/home-base` |
| `PATCH` | `/me/mileage/:x` |
| `PATCH` | `/me/profile` |
| `PATCH` | `/me/workday/:x` |
| `PATCH` | `/occurrences/:x/addons/:x` |
| `PATCH` | `/occurrences/:x/assignees/:x/role` |
| `PATCH` | `/occurrences/:x/next-visit-warning` |
| `PATCH` | `/occurrences/:x/time` |
| `PATCH` | `/standalone-reminders/:x` |
| `PATCH` | `/tasks/:x` |
| `POST` | `/banners/:x/dismiss` |
| `POST` | `/calendar-feeds` |
| `POST` | `/equipment/:x/like` |
| `POST` | `/equipment/:x/pin` |
| `POST` | `/equipment/:x/unlike` |
| `POST` | `/equipment/:x/unpin` |
| `POST` | `/followups/:x/complete` |
| `POST` | `/me/mileage/:x/cancel` |
| `POST` | `/me/mileage/:x/stop` |
| `POST` | `/me/mileage/start` |
| `POST` | `/me/policies/signatures/:x/cancel` |
| `POST` | `/me/policies/versions/:x/acknowledge` |
| `POST` | `/me/policies/versions/:x/page-view` |
| `POST` | `/me/policies/versions/:x/sign` |
| `POST` | `/me/policies/versions/:x/upload-url` |
| `POST` | `/me/push-subscriptions` |
| `POST` | `/me/sync` |
| `POST` | `/me/workday/cancel` |
| `POST` | `/me/workday/end` |
| `POST` | `/me/workday/pause` |
| `POST` | `/me/workday/reopen` |
| `POST` | `/me/workday/resume` |
| `POST` | `/me/workday/start` |
| `POST` | `/occurrences/:x/add-assignee` |
| `POST` | `/occurrences/:x/addons` |
| `POST` | `/occurrences/:x/cancel-payment-request` |
| `POST` | `/occurrences/:x/comms-handoff` |
| `POST` | `/occurrences/:x/completion-splits` |
| `POST` | `/occurrences/:x/confirm` |
| `POST` | `/occurrences/:x/confirmation-requested` |
| `POST` | `/occurrences/:x/like` |
| `POST` | `/occurrences/:x/pin` |
| `POST` | `/occurrences/:x/reassign-claimer` |
| `POST` | `/occurrences/:x/reminder/clear` |
| `POST` | `/occurrences/:x/reminder/snooze` |
| `POST` | `/occurrences/:x/reminder` |
| `POST` | `/occurrences/:x/reschedule` |
| `POST` | `/occurrences/:x/send-payment-request-email` |
| `POST` | `/occurrences/:x/unlike` |
| `POST` | `/occurrences/:x/unpin` |
| `POST` | `/occurrences/create-next` |
| `POST` | `/standalone-reminders/:x/dismiss` |
| `POST` | `/standalone-reminders/:x/reopen` |
| `POST` | `/standalone-reminders` |
| `POST` | `/tasks/:x/close` |
| `POST` | `/tasks/:x/reopen` |
| `POST` | `/tasks` |

## CLIENT-PORTAL  (10)
| | |
|---|---|
| `DELETE` | `/client/change-requests/:x` |
| `GET` | `/client/change-requests` |
| `GET` | `/client/jobs` |
| `GET` | `/client/me` |
| `GET` | `/client/statement` |
| `GET` | `/client/upcoming` |
| `POST` | `/client/link/confirm-candidate` |
| `POST` | `/client/link` |
| `POST` | `/client/occurrences/:x/reschedule-request` |
| `POST` | `/client/occurrences/:x/skip-request` |

## PUBLIC  (24)
| | |
|---|---|
| `GET` | `/public/branding` |
| `GET` | `/public/calendar/:x.ics` |
| `GET` | `/public/display/board` |
| `GET` | `/public/display/photo/:x` |
| `GET` | `/public/display/promo-item-photo/:x` |
| `GET` | `/public/display/promo-photo/:x` |
| `GET` | `/public/feed` |
| `GET` | `/public/mo/:x/:x` |
| `GET` | `/public/mo/:x` |
| `GET` | `/public/pay/:x` |
| `GET` | `/public/promotion/:x` |
| `GET` | `/public/promotion/click/d/:x` |
| `GET` | `/public/promotion/click/p/:x` |
| `GET` | `/public/promotions` |
| `GET` | `/public/stats` |
| `GET` | `/public/vanity/:x` |
| `GET` | `/public/vanity/animation` |
| `POST` | `/public/display/pair/poll` |
| `POST` | `/public/display/pair` |
| `POST` | `/public/pay/:x/promo-opt-in` |
| `POST` | `/public/pay/:x/record-intent` |
| `POST` | `/public/pay/:x/self-report` |
| `POST` | `/public/pay/:x/signup-from-page` |
| `POST` | `/public/promo/opt-out` |

## SYSTEM  (6)
| | |
|---|---|
| `GET` | `/cron/client-backup` |
| `GET` | `/cron/daily-notifications` |
| `GET` | `/cron/document-sync` |
| `GET` | `/healthz` |
| `GET` | `/hello` |
| `POST` | `/cron/test-notification` |
