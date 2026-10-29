# Permissions, Roles, Portfolios — Feature Reference

**STATUS (verified against the code 2026-10-18): BACKEND AND UI ARE BOTH
BUILT.** This file is the agreed DESIGN, written 2026-10-11 so it stopped
living in one conversation. Read it before writing any code touching roles,
territories, managers or scoped visibility — but read it as the design, not as
a status report. Where the design and the code differ, the code is right.

What has since landed, and what this document's own prose predates:

- The `Role` enum (WORKER/ADMIN/SUPER/STAFF), the `UserRole` table and
  `lib/privileges.ts` are **DELETED**. Where the text below says "today the
  app has three role enum values", or refers to `requireRole`,
  `resolvePrivileges`, `TRAINEE_CANNOT_ACT`, the per-file role guards, or the
  env-var break-glass, it is describing the system this design replaced. The
  same goes for every mention of WORKER, ADMIN, SUPER or STAFF as a value:
  a role is now a `CustomRole` row, which the operator can rename.
- There is **no cutover flag**. `ENTITLEMENTS_ENABLED` was removed with the
  enum; `requires(entitlement)` asks `can()` and nothing else, and a gate
  fails the build if a readable flag returns.
- **The UI is built** (2026-10-16): `apps/web/src/lib/tabRequirements.ts`
  decides which tabs exist, and `RolesTab.tsx` / `PortfoliosTab.tsx` are the role
  and portfolio builders.
- **Counted from the code on 2026-10-18** — re-count rather than trust these,
  they rot: **61 entitlements**, **641 mapped routes** = 498
  entitlement-guarded (across 60 entitlements) + 103 OWNERSHIP + 24 PUBLIC
  + 10 CLIENT-PORTAL + 6 SYSTEM, and **38 build-gate files** under
  `apps/api/src/services/*-build-gate.test.ts`.
  The 61st entitlement is `supplies.hold`, which guards no route on purpose:
  it is read in-handler through `callerCan` to widen a payload and to permit
  reserving stock against any visit.
- `workerType` is **EMPLOYEE | CONTRACTOR | UNPAID**. TRAINEE is gone as a pay
  class — a trainee is an EMPLOYEE who holds the Trainee *role*. Anywhere
  below that calls TRAINEE a `workerType`, or lists `canPullInventory` /
  `canChargeBusinessExpenses` as privilege columns, predates that: the
  columns are deleted. (`canPullInventory` survives only as a field NAME on
  the `/api/me` `privileges` payload, a wire contract carrying the value of
  `inventory.pull`.)
- Current state and remaining work: [`permissions-BUILD.md`](permissions-BUILD.md)
  (backend) and [`permissions-UI-BUILD.md`](permissions-UI-BUILD.md). Route→
  entitlement truth: [`permissions-ROUTE-MAP.md`](permissions-ROUTE-MAP.md),
  which is generated.

---

## In one page

**What it is.** Four independent facts about a person — how they are paid,
what they may do, where they may see, and whether they are a customer. Today
three of those are squashed into one enum with three values.

**What it gives you.** Custom roles defined in the app and assigned to people.
A front-office coordinator who sees everything and changes nothing. Managers
who run a territory without running the company. A portfolio tree that nests
freely, where money is tagged to the visit so reorganising never restates last
year's numbers.

**The two load-bearing decisions.** Managers and coordinators are
*assignments*, never new `Role` enum values — `requireRole` is exact
membership, so each new value would need a judgement call at every one of
the ~1,300 role checks measured in web alone (see *Web audit*), and a
missed `||` fails silently. And portfolios are never reparented;
you copy-and-retire, so history cannot move.

**Scale.** 676 route registrations resolving to 669 distinct method+path
pairs, 630 guarded. 44 tabs, 45 dialogs, 86 components, ~1,300 role
touchpoints in web — measured, with the breakdown under *Web audit*.
**The UI is the bulk of this work, not the schema.**

---

## How the UI behaves

**Controls are additive.** Every control is gated by the entitlement the
server would need to accept it. No entitlement, no control. A WORKER sees
exactly what they see today; entitlements only ever light up more.

Three different treatments, by entitlement kind:

| Kind | UI treatment |
|---|---|
| Company-global (`books.*`, `compliance.*`) | **Hide the whole tab.** Simpler than filtering and correct — these are company-wide by definition. |
| Portfolio-scopable (`schedule.*`, `money.*`) | **Show the tab, filter the rows** to the assignment subtree. |
| Action (`money.approve`, `work.claim`) | **Show the row, hide the button.** |

> **A surface hidden by entitlement must never look broken.** This is the
> same failure the claimer bug produced: a card with no buttons and no
> explanation reads as the app being broken, and the worker standing at the
> property has no idea why. A read-only surface says so **once, at the top** —
> "You can view this; you cannot change it" — never per-row clutter, never
> silence.

And: **never render an empty tab.** If someone holds no entitlement in a
family, the tab does not appear at all. A tab that opens onto nothing is worse
than a missing tab.

---

## In-app help (role builder)

Shown beside the permissions matrix. This is the canonical copy.

> ### How access works here
>
> Four separate things decide what a person sees and does.
>
> | | |
> |---|---|
> | **Worker type** | how they are **paid** — employee, contractor, unpaid |
> | **Role** | what they may **do** |
> | **Portfolios** | where they may **see** it |
> | **Customer** | whether they are also a client of yours |
>
> They are independent. A contractor can manage a territory. A worker can also
> be a customer.
>
> **Everyone starts with a base role.** Staff can sign in and little else.
> Worker adds field work. Admin runs the company. Super adds this screen.
>
> **Roles only ever add.** Ticking a box grants something; nothing takes
> anything away. To give someone less, start from a smaller base role and
> build up — that way nobody can be locked out by accident.
>
> **Assigning a role to a portfolio limits where it applies.** "District Manager
> of Raleigh" can manage Raleigh and everything under it, and nothing else.
> Assign the same role to a parent portfolio and it covers every portfolio beneath it.
>
> **Running a portfolio is not managing the people in it.** Someone who runs
> Raleigh keeps Raleigh running — its schedule, its customers, its money.
> They cannot set anyone's pay, change a worker type, or hand out roles.
> There is no reporting line in this app: people are organised flat, and
> ownership is of **places**, not people.
>
> **Some things cannot be limited to a portfolio** — payroll, policies, the price
> list. Those are company-wide, and they are marked. Granting one grants it
> everywhere.
>
> **Field work is never limited to a portfolio.** Someone who manages Raleigh can
> still pick up a job anywhere. Managing a territory does not stop you working
> in another one.
>
> You cannot grant something you do not have yourself.

---

## In-app help (assigning someone to a portfolio)

Shown on the portfolio assignment editor — the moment the misunderstanding is
most likely, because putting a person on a portfolio *looks* like putting them
in charge of people. Canonical copy.

> ### Assigning someone to a portfolio
>
> You are making this person accountable for **operations here** — the
> schedule, the customers, the money for this patch. They will see what
> happens in this portfolio and in every portfolio beneath it.
>
> **This is not a reporting line.** They can see who is working here and
> approve hours and mileage. They cannot set anyone's pay, change a worker
> type, or give anyone a role. Those stay company-wide, with you.
>
> **Nobody is tied to a portfolio.** Assigning someone to Raleigh does not stop
> them picking up a job in Durham, and it does not stop anyone else working
> in Raleigh. Portfolios decide what people **see**, never where they can work.
>
> To change what this person is allowed to do — rather than where — change
> their role.

---

## The four axes

The single most important idea here. Four independent facts about a person,
which compose freely and must never be collapsed into each other:

| Axis | Answers | Where it lives |
|---|---|---|
| **`workerType`** | how you are **paid** | `User.workerType` — EMPLOYEE · CONTRACTOR · UNPAID · null |
| **Roles + entitlements** | what you may **do** | `UserCustomRole` → `CustomRole` |
| **Portfolio assignments** | where you may **see** | `PortfolioAssignment` into the portfolio tree |
| **ClientContact link** | you are a **customer** | `ClientContact.clerkUserId` |

Worked example: a CONTRACTOR (paid 1099) who holds the Worker starter role
plus a custom "District Manager" role assigned to Raleigh, and who is also a
client because you mow his mother's lawn. Four axes, four independent
answers, no conflict.

**`workerType` is a tax and employment fact, not a permission.** EMPLOYEE is
W-2 and is made whole on a write-off; CONTRACTOR is 1099 and is not; UNPAID is
neither and must never reach a split, a wage, a payroll row or a tax export
(G33). It must never become something an operator ticks boxes on.

*(As designed, this paragraph read "EMPLOYEE and TRAINEE are W-2" and listed
`TRAINEE_CANNOT_ACT`, `canPullInventory` and `canChargeBusinessExpenses` as
permission side effects that would "become default entitlement bundles seeded
from the type". That is what happened, and it is finished: TRAINEE is no longer
a `workerType`, those three constructs are deleted, and the bundles are the
starter roles in `apps/api/scripts/install-starter-roles.ts`.)*

**Clients are never staff.** Portal access comes from the ClientContact link,
not from a role.

*(As designed, this read "Clients are never STAFF … that is what STAFF is
for" — STAFF being a `Role` enum value held by a deliberate view-only staff
member. There is no STAFF and no enum now. What shipped instead: `index.tsx`
offers TWO shells, `"client" | "staff"`, and holding no capability is a real
state. Someone on payroll whom nobody has given a role yet, and the unpaid
helper, both get the CLIENT shell rather than an empty staff one.)*

---

## Base roles

> **SUPERSEDED — this section describes the enum, which is DELETED.**
> Kept because the reasoning below is why the enum could not survive, and
> that reasoning is still the argument against reintroducing one.
>
> **What shipped instead** (`apps/api/scripts/install-starter-roles.ts`):
> four starter `CustomRole` rows in an INHERITANCE ladder, each adding to the
> one below — **Trainee → Worker → Admin → Super** — plus **Field Clearance**
> (claim, complete, pull inventory) and two single-entitlement exception
> roles, **May pull inventory** and **May charge business expenses**.
>
> They are DATA, not code: keyed on an immutable `key` so re-running the
> installer preserves ids and grants, and the operator may rename any of
> them. "Admin" is a row someone can call "Office" tomorrow. Nothing in the
> code branches on these names — read
> [[reference_capabilities_model]] and the route map instead.

As designed:

`Role` stays an enum. One value is added — **STAFF** — and no more, ever.

| Role | Grants |
|---|---|
| **STAFF** | sign in, own profile, sign policies, read announcements, set theme |
| **WORKER** | STAFF + claim / complete work, per `workerType` defaults |
| **ADMIN** | runs the company |
| **SUPER** | ADMIN + role definition, settings, destructive paths |

**Why adding STAFF is safe when adding MANAGER would not be.** `requireRole`
is exact membership, not ranked:

```ts
if (!roles?.includes(role)) throw app.httpErrors.forbidden("NOT_AUTHORIZED");
```

There is no hierarchy in code — "super implies admin" is hand-written as
`r.role === "ADMIN" || r.role === "SUPER"`. So a role that grants a *partial*
set of powers needs a judgement call at every one of those ~1,300 web role
checks — plus the API's own — and a missed `||` fails silently. A role that
grants **nothing extra** needs none of them: every existing check returns false
for STAFF, which is the correct answer. It fails closed for free.

**STAFF is the floor and is not removed while an account is active.** Demoting
someone by deleting their only role would leave zero rows and lock them out of
their own profile. With STAFF underneath, demotion lands on "has an account, no
powers."

**Everything above STAFF that is not one of the four is an assignment, not a
role.** Manager, secretary, dispatcher, bookkeeper — all custom roles. This
mirrors how the app already works: a *claimer* is not a role either
(`JobOccurrenceAssignee.role` is a plain `String?`).

---

## Entitlements

Derived from a full inventory of **676 route registrations**, resolving to
**669 distinct method+path pairs** once routes registered in two files are
collapsed (630 guarded, 46 public — those sum to the 676, not the 669).
Not from one file. Three verbs, not two.

Several whole categories need no entitlement. The counts live in
[`permissions-ROUTE-MAP.md`](permissions-ROUTE-MAP.md) and are quoted from its
groups, not recounted here — an earlier version of this list counted URL
PREFIXES (`me/*`, `public/*`) while the map counted authorization CATEGORIES,
so the two could never reconcile and both looked authoritative.

- **OWNERSHIP.** My workday, my mileage, my policies, my payroll, my
  properties — and a worker acting on their own visit. "My own X" is
  **always ownership**, never an entitlement.
- **PUBLIC.** Pay links, promotion pages, vanity URLs, the paired display.
  Outside auth entirely.
- **CLIENT-PORTAL.** Reached through the `ClientContact` link, which is its
  own axis.
- **Hard-gated** and deliberately not expressible as an
  entitlement — see *Not entitlements* below.
- **ROLE-GRANT.** Bounded by *you cannot grant what you do not hold* (G6).

Of the 669 distinct method+path pairs, **503 carry an entitlement** and the
rest fall into those groups.

### The three verbs

| Verb | Means |
|---|---|
| `view` | read it |
| `contribute` | **add content attached to a record without controlling the record** — notes, photos, guidance, comments |
| `manage` | create, edit, restructure, delete |

`contribute` exists because view/manage is too coarse for real jobs: a plant
specialist who annotates visits, or a photographer who uploads job photos,
would otherwise need `schedule.manage` — which also grants reschedule and
reassign. Letting someone add a note should not let them restructure the week.

### Grouped as the role builder shows them

Grouped by **what a person does**, not by resource — a role is built by
thinking about a job, not about a database table. Each line is the copy shown
beside its checkbox.

#### Daily work *(field capability — never portfolio-scoped)*

`inventory.pull` and `expenses.charge` are **seeded from worker type** when a
user is created or their type changes, then live as ordinary grants — see
*grants, not inferred defaults* below.

| Entitlement | Copy shown in the UI |
|---|---|
| `work.claim` | Pick up and release visits — including pausing and resuming |
| `work.complete` | Start a visit, finish it, and take payment at the door |
| `inventory.pull` | Take equipment and supplies out for a job |
| `materials.charge` | Add billable materials to a visit — charged to the client |
| `expenses.charge` | Charge the company's own purchases to the business |

#### Scheduling and customers *(portfolio-scopable)*

| Entitlement | Copy shown in the UI |
|---|---|
| `schedule.view` | See the calendar, jobs and visits |
| `schedule.view-all` | See every visit, not only the ones you are on |
| `schedule.contribute` | Add notes, photos and guidance to a visit |
| `schedule.manage` | Create, move and reschedule visits, and assign who does them |
| `crews.view` | See crews and who is on them |
| `crews.manage` | Build and change crews |
| `routes.plan` | Plan and optimise the driving order for a day |
| `clients.view` | See customers, properties and contacts |
| `clients.view-all` | See every customer and property, not only the ones you work |
| `clients.contribute` | Add photos and notes to a property |
| `clients.manage` | Add and edit customers, properties and contacts |
| `estimates.create` | Write and send quotes |
| `estimates.accept` | Accept or reject a quote on the customer's behalf |

#### Money *(NEVER portfolio-scopable — decided 2026-10-14)*

> This heading used to read *(portfolio-scopable)* while resolved question C said
> `books.*` is global-only, and the two sat in the same document
> contradicting each other for long enough that the build gate had to exclude
> all four money capabilities pending an answer. The answer is **global**:
> the company's books are the owner's, and there is no district P&L. A gate
> now fails if `books.*` or `payroll.*` is added to the portfolio-scopable list,
> so this cannot quietly flip back.
>
> `money.view` IS portfolio-filtered on the payment reads, which is not a
> contradiction: that narrows WHICH VISITS' money you see, by the territory
> of the visit. It does not slice the books.

| Entitlement | Copy shown in the UI |
|---|---|
| `money.view` | See what was invoiced and collected |
| `money.approve` | Approve a payment, reverse one, or write it off |
| `money.record` | Record a payment that came in — a posted cheque, a transfer |
| `money.adjust` | Rework how a payment splits between the crew |
| `pricing.view` | See the price list |
| `pricing.manage` | Change the price list |
| `books.view` | See business expenses, the P&L and the reconcile period |
| `books.manage` | Record and reconcile business expenses |
| `books.export-tax` | Download the tax exports — income, expenses, capital, workdays, payroll |
| `payroll.view` | See imported payroll and what each person was paid |
| `payroll.manage` | Import payroll and manage pay periods |

#### People and time

| Entitlement | Copy shown in the UI |
|---|---|
| `people.view` | See the team and who is working *(portfolio-scopable)* |
| `people.manage` | Add people, set pay and worker type |
| `people.approve` | Admit a pending sign-up, or decline it |
| `people.grant-roles` | Put a role on a person — never one you do not hold yourself |
| `time.view` | See other people's hours and mileage *(portfolio-scopable)* |
| `time.manage` | Create and edit workday and mileage records |
| `time.approve` | Approve hours and mileage *(portfolio-scopable)* |

#### Equipment and supplies

| Entitlement | Copy shown in the UI |
|---|---|
| `equipment.view` | See equipment and vehicles |
| `equipment.manage` | Edit equipment and vehicles, their photos, instructions and collections |
| `equipment.capital` | Put equipment and vehicles on the books, retire them, and assign a vehicle to a driver |
| `supplies.view` | See the supply catalogue |
| `supplies.manage` | Change the supply catalogue |
| `supplies.hold` | Reserve supplies against a visit |

#### Company records

| Entitlement | Copy shown in the UI |
|---|---|
| `compliance.view` | See policies and who has signed them |
| `compliance.manage` | Write policies and manage signatures |
| `timeline.view` | See the company timeline |
| `timeline.manage` | Add and edit timeline events, and see hidden ones |
| `documents.view` | See company documents |
| `documents.manage` | Upload and organise company documents |
| `audit.view` | See the audit log of who changed what |

#### Marketing and content

| Entitlement | Copy shown in the UI |
|---|---|
| `marketing.view` | See promotions, public pages, banners and announcements |
| `marketing.manage` | Post banners and announcements |
| `marketing.campaigns` | Run promotions and public vanity pages |
| `content.view` | See guide drafts and the media library |
| `content.manage` | Write education guides and upload their images |
| `content.approve` | Approve, publish, roll back or archive a guide — and add video |
| `notify.send` | Send push notifications and emails to the team |

#### Insight

| Entitlement | Copy shown in the UI |
|---|---|
| `reports.view` | See the team rollup — your crew's hours, pay and jobs |
| `reports.business` | See the business-wide Insights rollup — money, jobs, equipment and clients across the company |
| `forecasts.view` | See and run the forecasting tool |

#### Administration

| Entitlement | Copy shown in the UI |
|---|---|
| `roles.view` | See the roles that exist and what each one grants |
| `roles.define` | Create roles and choose what they grant |
| `settings.view` | See business settings, taxonomies and feature switches |
| `settings.manage` | Change business settings, taxonomies and feature switches |
| `displays.manage` | Pair and revoke wall screens |
| `identity.link` | Connect a login to a client record |
| `clients.view-as` | Look at the app as one of your clients sees it |
| `portfolios.view` | See the portfolio tree and what is in each one |
| `portfolios.manage` | Create, rename, retire and reorganise portfolios |

**68 entitlements.**

**Symmetry is deliberate and applied completely.** Every family carries both
verbs even where `view` is rarely granted, for two reasons. Irregularity
costs something on *every* read — seeing `documents.view`/`documents.manage`
but only `marketing.manage` makes a reader stop and work out whether that is
intentional. And the base bundles pre-fill the view verbs, so nobody building
a role from WORKER ever sees them; the person who does is building up from
STAFF, and that is exactly when "see supplies but do not manage them" is the
distinction they need.

The deliberate single-verb exceptions, where the other half is not an act
that exists: `audit.view` (an audit log cannot be managed), `reports.view`,
`notify.send`, `routes.plan`, `inventory.pull`, `expenses.charge`,
`materials.charge`, `work.claim`, `work.complete`, and the
`estimates.create` / `estimates.accept` pair, which is a separation of
duties rather than a view/manage split.

Five entitlements were added by the full route sweep —
`audit.view`, `pricing.view`, `reports.view`, `routes.plan`, `crews.manage` —
were each found by a route with no home, not by imagining a role. The human
review of the generated map then added two more and corrected three
mappings — see `permissions-ROUTE-MAP.md`:

- **`materials.charge`** — `/invoice-charges` bills the CLIENT for materials.
  That is not `expenses.charge`, which is the company's own spend. Conflating
  them crosses the two-books line.
- **`money.record`** — recording a collection is not approving it. Neither
  existing checkbox's wording described a posted cheque, and if the label
  does not describe the act, the mapping is wrong. It also gives two-eyes for
  free: record and approve can sit with different people.
- A worker's **own earnings** (`/payments/mine` and friends) are OWNERSHIP,
  not `money.view`. Otherwise every worker needs `money.view` and it means
  nothing.
- **`pause`/`resume` travel with `work.claim`.** Someone who can start a visit
  but not pause it is stuck at lunchtime.

**Payroll is split out of books** because it is the only category in there
about *people* rather than the business. Letting someone reconcile fuel
receipts should not also hand them every person's hourly rate. The deciding
case is an outside bookkeeper categorising expenses who must not see wages —
exactly the kind of help a small company takes on first. Three further
corrections came from the second sweep: `crews.view` (reading a crew should
not need manage rights), a worker's own `/dashboard-summary` is OWNERSHIP not
a report, and `/board` is `schedule.view` because it is built for everyone.

> **`expenses.charge` has NO enforcing route today.** `canChargeBusinessExpenses`
> is stored and displayed but checked nowhere on the server. Step 2 must add
> the check to business-expense creation — a behaviour change inside the
> migration, not a relabel.

### Not entitlements — hard-gated

- **Role definition** — creating a role, ticking its entitlements
- **Linking a login to a client record** (`link-clerk`) — binding an identity
  is an auth act, not customer admin
- **Settings** — taxonomies, feature flags, business configuration
- **Displays** — paired wall screens
- **Forecasts** — owner planning, not a job function

Roughly **30 entitlements** as designed; the built set is **61** — count
`ENTITLEMENTS` rather than trusting either number. The earlier draft had
seventeen because it was derived from one route file instead of the whole
layer — a method error, not a missed role, and the reason a full inventory
is the first task of Step 2.

## Schema

Field-level, as it will be written. `entitlement` is a **String**, not a
Prisma enum: entitlements are defined in code (each maps to routes), so adding
one should be a code change, not a migration. The TS union is the source of
truth and **G7** gates that every member appears in the matrix.

```prisma
enum Role { STAFF WORKER ADMIN SUPER }          // STAFF added; no further values, ever

model CustomRole {
  id           String    @id @default(cuid())
  name         String    @unique                // display text — "District Manager"
  description  String?
  isSystem     Boolean   @default(false)        // worker-type defaults; cannot be deleted
  suspendedAt  DateTime?                        // reversible; grants go inactive
  createdAt    DateTime  @default(now())
  createdById  String?
  entitlements RoleEntitlement[]
  userGrants   UserCustomRole[]
  portfolioGrants   PortfolioAssignment[]
}

model RoleEntitlement {
  id           String     @id @default(cuid())
  customRoleId String
  customRole   CustomRole @relation(fields: [customRoleId], references: [id], onDelete: Cascade)
  entitlement  String
  @@unique([customRoleId, entitlement])
}

model UserCustomRole {                           // role held GLOBALLY
  id           String    @id @default(cuid())
  userId       String
  customRoleId String
  suspendedAt  DateTime?
  grantedAt    DateTime  @default(now())
  grantedById  String?
  @@unique([userId, customRoleId])
}

model Portfolio {
  id          String    @id @default(cuid())
  name        String
  tier        String?                            // from PORTFOLIO_TIER_NAMES — display only
  parentId    String?
  parent      Portfolio?     @relation("AreaTree", fields: [parentId], references: [id], onDelete: Restrict)
  children    Portfolio[]    @relation("AreaTree")
  path        String                             // materialized, of IDS not names:
                                                 // "/ck3.../ck7.../" — names are
                                                 // neither unique nor stable, so a
                                                 // slug path would break on rename
  retiredAt   DateTime?
  createdAt   DateTime  @default(now())
  assignments PortfolioAssignment[]
  properties  Property[]
  occurrences JobOccurrence[]
  @@index([path])
  @@index([parentId])
  // NO uniqueness on name, by design. A name is a label for humans: you may
  // retire "Raleigh" and create a new "Raleigh", under the same parent or a
  // different one. Only the id is never reused. The UI therefore MUST
  // disambiguate — show the full path, and badge a retired portfolio with the
  // date it was retired.
}

model AreaMembership {                           // "usually works here" — NO authority
  userId String
  portfolioId String
  @@id([userId, portfolioId])
}

model PortfolioAssignment {                           // role held WITHIN a subtree
  id           String    @id @default(cuid())
  userId       String
  portfolioId       String
  customRoleId String
  isTemporary  Boolean   @default(false)         // surfaces in the cover audit check
  note         String?
  suspendedAt  DateTime?
  grantedAt    DateTime  @default(now())
  grantedById  String?
  @@unique([userId, portfolioId, customRoleId])
}

model Property {
  portfolioId String?                                 // EXACTLY ONE, and optional
  portfolio   Portfolio?   @relation(fields: [portfolioId], references: [id], onDelete: Restrict)
  @@index([portfolioId])
}
```

Added to existing models:

```prisma
// SUPERSEDED 2026-10-28 — membership became a SET, so the column became a
// join. The rule it carried is unchanged; only its shape is different.
model JobOccurrencePortfolio {
  occurrenceId String
  portfolioId  String
  occurrence   JobOccurrence @relation(fields: [occurrenceId], references: [id], onDelete: Cascade)
  portfolio    Portfolio     @relation(fields: [portfolioId], references: [id], onDelete: Restrict)
  @@id([occurrenceId, portfolioId])
  @@index([portfolioId])
}
// There is NO `frozenAt` — a column of that name existed and was dropped on
// 2026-10-29 (migration 20261029180000), because nothing in the app ever
// wrote it. "Frozen" is `occurrence.completedAt != null`.

model Job     { defaultPortfolioId String? }          // projections only
model User    { /* canPullInventory + canChargeBusinessExpenses are DROPPED */ }
```

`onDelete: Restrict` on both portfolio foreign keys, never `SetNull` — a null here
silently de-attributes revenue, which is the `assignedById` incident.

### The three sources `can()` unions

```
base role bundle                     code constant, by Role
UserCustomRole  → RoleEntitlement    global
PortfolioAssignment  → RoleEntitlement    within that subtree
```

**Every grant goes through a named role. There are no per-person entitlement
grants.** The cost is that an exception needs its own role — to stop one
contractor pulling inventory you assign "Contractor — no inventory" instead of
"Contractor defaults". That is the point: exceptions become **named, visible
and reusable** rather than scattered as per-person ticks nobody can audit.
"Why does Jake have this?" always has exactly one kind of answer.

### Worker-type defaults are system roles — SUPERSEDED

> **This section records what was planned, not what shipped.** It is kept
> because the reasoning still explains why the privilege columns had to go;
> the mechanism it proposes was replaced before it was built.
>
> **Planned:** three `isSystem` roles — Employee Defaults, Contractor
> Defaults, Trainee Defaults — assigned when a user is created or their
> worker type changes, behind an "apply defaults?" prompt.
>
> **Shipped instead:** worker type grants nothing at all. `workerType ==
> null` resolves to zero entitlements (**G31**) and a non-null value resolves
> to no entitlements either — it is a tax and employment fact, and the gate
> that keeps it one is **G30**. Two things killed the planned design. *Trainee
> is not a worker type* (**G32**): it carried no payroll meaning, so a
> trainee is an EMPLOYEE who lacks the field-work role, which makes a
> "Trainee Defaults" role a category error. And a defaults role assigned on a
> worker-type change is still a capability that moves when a dropdown is
> edited — the thing *§`inventory.pull` and `expenses.charge`* objects to, one
> level up.
>
> `isSystem` survives with a different meaning: the **starter ladder**
> (Trainee → Super), installed by script, undeletable, and
> held one rung at a time because the rungs inherit each other. The reseed
> deletes the three Defaults roles by name so none survive as live grants.

### What the STAFF migration actually does — SUPERSEDED

> **There is no STAFF role, and no `Role` enum to add one to.** Decision 40
> deleted the enum outright rather than capping its values (**G19**): a
> vestigial enum carrying no entitlements is a second source of truth for a
> fact the worker type already states. So the migration described here never
> ran. What did run converted every `UserRole` row into a `UserCustomRole`
> grant on the matching starter role, with an in-transaction assertion that
> refuses rather than silently dropping anyone's access.
>
> The rest of this section held up exactly as written, and shipped:
> `/users/:id/privileges` retired with the two columns it wrote, and
> per-person capability changes go through `people.grant-roles` like every
> other grant. The user detail does **not** get a "Defaults role" picker —
> there are no Defaults roles — it reports each capability and the role it
> comes from, with no editable control, because editing one person's
> capability directly is what **G20** forbids.

### Many roles per person — except one

`UserCustomRole` is unique on the **pair**, not on `userId`, so grants stack
freely: Jake holds WORKER + "Contractor Defaults" + "District Manager @
Raleigh". The union rule depends on this.

**The single exception: at most ONE `isSystem` defaults role per person.**
Holding both "Contractor Defaults" and "Employee Defaults" would union two
worker types' privileges, which is incoherent — you have one worker type.

Not expressible as a unique index (it is "at most one row whose joined role
has `isSystem`"), so it is enforced in the app and gated. The user detail's
**Defaults role** control is therefore a picker, never a multi-select, and
changing worker type swaps the one role rather than adding a second.

### Suspending and deleting a role

**There is no "retire" for a role.** One path, two steps, both warned, the
first reversible:

1. **Suspend** — `suspendedAt` set. Grants go **inactive immediately**;
   assignments survive. Hidden from pickers. Un-suspending restores
   everything. This is also how you switch a role off for everyone at once:
   no separate role-wide mechanism, because suspend already is one.
2. **Delete** — only available on an already-suspended role. Assignments
   cascade and it is gone; the audit log retains who held it and when.

Both actions warn **by name**: "4 people lose `money.approve`: Jake, Dana…"

> Roles **suspend**; portfolios **retire**. Different words because different
> meanings — a suspended role is paused and coming back, a retired portfolio is
> permanently closed but preserved so history still resolves through it.

## Portfolio hierarchy

**One construct that nests freely.** A portfolio contains portfolios. A "region" is just
a portfolio with children. Regional / District / Portfolio are job titles, never schema,
so the tree reshapes without a migration.

**One parent per portfolio, strictly.** A tree, never a graph. Two portfolios sharing a
child would need two materialized paths, and rollups would **double-count** —
Raleigh under both Triangle and Eastern means a company total that sums regions
invents revenue. That is the failure `payments-build-gate`'s "Income aggregate
EXCLUDES write-offs (no phantom revenue)" already exists to prevent.

**A property belongs to exactly ONE portfolio, and the field is optional.** A
column, not a join table — the schema makes "two portfolios" unrepresentable
rather than merely discouraged.

Moving a property is free and **cannot move money**: revenue is recorded where
the work was *completed*, on the occurrence, frozen at completion. Move a
property to Durham and last year's Raleigh visits stay Raleigh.

One consequence to settle at build time: when a property moves, its
**already-SCHEDULED visits should follow** — they have not happened yet and
the new portfolio will be doing them — while completed ones never move. That is
the direct reading of "recorded where it was completed".

### Unassigned is allowed, and discouraged hard

`portfolioId` is nullable because forcing it would block property creation on an
org decision nobody wants to make at 7am. But an unassigned property is not
harmless, and the UI says so plainly rather than politely:

> **A property with no portfolio produces visits with no portfolio, and those are
> counted in no portfolio's totals and seen by nobody assigned to one.**

- the portfolio selector appears **on property creation**, pre-filled where a
  sensible default exists
- an unassigned property carries a **visible warning**, worded for the
  consequence — **"Not in a portfolio — work here won't appear in any portfolio's
  totals, or to anyone assigned to one"** — never a neutral "no portfolio set"
- the portfolio tree shows an **"Unassigned (7)"** bucket derived from
  `portfolioId IS NULL`, not a real Portfolio row, so the backlog is visible and
  fixable in one place instead of hiding across 75 property pages
- the **day-one migration assigns every property to the root portfolio**, so
  nothing starts invisible

### Assigning and moving properties — the surfaces

Placing 75 properties one page at a time is not a plan, so this needs real
filtering and bulk action:

- **`PropertiesTab` gains an Portfolio filter**, alongside the existing kind and
  status filters, including an explicit **"Unassigned"** option — the filter
  that turns the backlog into a worklist
- **Multi-select + "Assign to portfolio…"** on that filtered list. This is how the
  initial placement actually happens, and every later reshuffle
- **"Add properties" picker on a portfolio node**, filtered and searchable, for
  working from the tree inwards
- The active-filter chip pattern already used there shows the portfolio filter the
  same way, so a filtered view is never mistaken for the whole list

**Rights follow the retag rule (decision 14):** moving a property between
portfolios needs `schedule.manage` in BOTH source and destination; placing an
unassigned one needs it in the destination. Nobody pulls properties into
their own numbers from a territory they do not run.

**A portfolio may hold both child portfolios and properties at once.** Not either/or.

### Money rides the occurrence

The occurrence's OWN portfolio rows (`JobOccurrencePortfolio`), synced from the
property while the visit is open and left alone once it completes — the same
rule as completion splits. Money is filtered
`Payment → occurrence → JobOccurrencePortfolio`, never through the property's
*current* membership, which is what makes the next paragraph true.
`Payment.occurrenceId` is `@unique`: the occurrence *is* the money-bearing row.

Enforced in two places, both asserted by **G22**: `resyncPortfoliosForProperty`
selects only open visits, and `syncOccurrencePortfolios` returns early on a
completed one even if handed its id. **Verified against real rows 2026-10-29** —
removing a property from a zone moved its 6 open visits and left the 25
completed ones, and the zone's payment total was identical before and after.

`Job.defaultAreaId` is **gone**: an open visit follows its property directly,
so there is no unanswerable case left for a job-level default to answer.

Consequence worth keeping: **reassigning a property cannot move last year's
revenue**, because the occurrence snapshotted its portfolio. History stays put by
construction, not by a rule someone must remember.

### Where a new occurrence's `portfolioId` comes from

Resolved in order, first hit wins:

1. **The previous occurrence in the chain** — the same carry-forward pattern
   `price` and `frequencyDays` already use.
2. **`Job.defaultPortfolioId`**.
3. **The property's portfolio**.
4. **Prompt.**

Step 4 is only reachable for a brand-new job on an UNASSIGNED property — which
means **a human is always present when it fires.** Automatic chain rollover
always has a predecessor, so the background path can never hit an
unanswerable prompt. That is the property that makes this safe, and it is why
inheritance comes first rather than the job default.

### What portfolio ownership is, and is not

> *"Assign region X to person Y. That person needs to make sure operations
> are smooth in that portfolio — not that they hire, fire or manage the people
> directly, only indirectly via association."*

**The organisation of PEOPLE is flat.** There is no reporting line in the
schema. The only hierarchy is of places.

| A portfolio assignee CAN | A portfolio assignee CANNOT |
|---|---|
| see who is working in their portfolio (`people.view`) | set pay or worker type (`people.manage`) |
| see hours and mileage (`time.view`) | grant anyone a role (`people.grant-roles`) |
| approve hours and mileage (`time.approve`) | hire, approve or remove a person |
| run the schedule, clients and money for their patch | touch anything company-wide |

`people.manage` and `people.grant-roles` are **global-only** — deliberately
not portfolio-scopable — which is what keeps employment decisions out of
territorial ownership.

`time.approve` sits closest to the line and is portfolio-scopable on purpose: it
is operational verification ("did this work happen in my portfolio") rather than
an employment decision ("what is your rate"). A portfolio owner is accountable
for whether the work got done, so they are the right person to confirm it.

**The forward path, if people-management is ever wanted.** Nothing here
forecloses it. A future `people.manage` scoped to a portfolio, or a genuine
reporting edge, would be purely additive — a new scope on an existing
entitlement, or a new relation. It is left out now because it is not needed,
not because the model resists it. The only people-shaped concept today is
the **claimer / crew lead**, which is ownership of a visit (permission
system two), not of a person.

### The tree models AREAS, not people

Oversight is **implied by containment**: Dana is assigned to Triangle, Pete to
Raleigh beneath it, so Dana sees Pete's territory. There is no "Dana manages
Pete" edge in the schema and there should not be — management flows through
territory, not a person-to-person org chart. Consequence: *"who is my
manager?"* is derived, not stored — whoever holds an assignment at or above
my portfolio.

**Nesting was challenged in a from-scratch review and kept.** Flat portfolios plus
multi-assignment can express "Dana covers Raleigh, Durham and Chapel Hill",
but cannot express a tier *above* other overseers and gives no intermediate
node to roll up to. A real regional → district → local structure is a tree,
and retrofitting one once money is attached is far worse than carrying it
from the start.

### Home portfolios vs. authority — two different things

> **Managing a portfolio is not managing the people in it.** The Raleigh manager
> runs Raleigh; they do not run Jake.

Two separate relationships, deliberately not merged:

| | Means | Grants |
|---|---|---|
| `AreaMembership` | "Jake usually works Raleigh" — his **home portfolio**, one or more | **nothing** |
| `PortfolioAssignment` | "Dana runs Raleigh" — authority, via a role | that role, in that subtree |

Three consequences:

- **`people.manage` stays global-only.** A portfolio manager cannot set wages,
  roles or worker types for anyone. Only `people.view` is portfolio-scoped.
- **Membership must never gate anything.** It is informational. The moment a
  permission check reads it, you have restricted where people may work —
  the exact thing *visibility is scoped, capability is not* protects. Gate it.
- **Visitors are badged, not hidden.** A portfolio's rollup shows work by its home
  crew *and* by anyone else who picked up a job there — "3 visits by workers
  outside the Raleigh crew" is precisely what a manager should notice. A
  roaming contractor has no home portfolio and appears as a visitor wherever they
  work; no special case needed.

The rollup's **"My team"** toggle therefore means **the home crew**, and their
work anywhere — not "people I have authority over", which is nobody.

### Retagging a visit's portfolio

While SCHEDULED the tag is editable, and editing it moves revenue between two
managers' numbers. So:

> **Retagging requires `schedule.manage` in BOTH the source and the
> destination portfolio.**

Neither one alone. `schedule.manage` in the destination would let a manager
pull other territories' work into their own figures; in the source alone it
would let them push an awkward job onto someone else's. Requiring both means
you can only move a visit between two portfolios you already answer for. Holders of `schedule.manage`
and Holders of `settings.manage` hold it globally, so a genuine cross-territory mistake can always
be corrected — a manager who spots one outside their patch reports it.

Frozen at completion, as above, so this is only ever a correction to future
work.

### Portfolios are never reparented

Moving a node would restate group history: move Raleigh out of Triangle and
Triangle's past revenue silently shrinks. Instead, **copy and retire**, as one
guided action in one transaction:

1. create the new node under the new parent
2. move the properties across
3. retire the old node (`retiredAt`)
4. write an `AuditEvent` with a before-snapshot

Past visits keep pointing at the retired node, which still hangs under its
original parent. **Nobody's past numbers move.** This also makes the
materialized `path` effectively immutable, which removes cycle-prevention and
reparent-rewrite entirely.

Costs, accepted: retired nodes accumulate (hide them from pickers), and a
report spanning the move shows the portfolio under two parents — which is correct,
it genuinely was two organisational things, but the UI must say so.

> **Retired hides a portfolio from PICKERS. It must never hide it from
> REPORTING.** If retired nodes drop out of rollups, history vanishes the
> moment you retire one, which defeats the whole pattern.

Portfolios are soft-deleted only. The FK is `onDelete: Restrict` as a backstop —
never `SetNull`, which would silently de-attribute revenue (see the
`assignedById` incident in `lib/claimerInvariant.ts`).

### Assignment

Two shapes:

```
UserCustomRole(userId, roleId)             → grants everywhere
PortfolioAssignment(userId, portfolioId, roleId)     → grants within that subtree
```

The portfolio assignment **carries the role**, so the same person can be District
Manager in Raleigh and merely a viewer in Durham.

> **Authority = global (if ADMIN/SUPER) OR the union of assignments. NEVER the
> intersection.** Otherwise the day the owner assigns himself to one portfolio he
> locks himself out of the company.

A manager over a parent portfolio covers the whole subtree automatically — one
indexed prefix match on `path`. Multiple assignments are needed only for a
territory that is not a single subtree.

### Visibility is scoped; capability is not

`work.claim` and `work.complete` are deliberately **not** portfolio-scopable. A
worker promoted to manage Raleigh must still be able to pick up a job in Durham
— people cover for each other and move around.

> **Portfolio scoping applies to MANAGEMENT surfaces, not to a worker's own job
> feed.** That feed is already "my jobs + unassigned + announcements", which is
> assignment-based. Narrowing it by portfolio would shrink the list of jobs a
> promoted worker can pick up — the exact opposite of intent. This is the most
> likely bug in the portfolio phase and needs its own gate.

### A grant is not a lens

Two different questions, and the feature only works because they stay apart:

| | Decides | Direction | Who sets it |
|---|---|---|---|
| **Grant** (`PortfolioAssignment`) | what you are **allowed** to see | only ever **widens** | an operator, on the Portfolios tab |
| **Lens** (`X-Portfolio-Lens`) | what you are **currently looking at** | only ever **narrows** | the viewer, from the header |

The lens exists because "scoped down to Durham" and "allowed only Durham" are
not the same thing. Someone who can see the whole company still wants to read
one district at a time, and before this they had no way to — the only control
was the grant, which is the wrong tool: it is an operator action, it is
recorded, and it is not something a reader should edit to answer a question.

**How it cannot escalate.** The chosen path is INTERSECTED with the granted
subtrees in `visiblePortfolioPaths` (`apps/api/src/lib/portfolioScope.ts`). The
intersection of two subtrees is one of them or nothing:

- lens inside grant → the lens *(a global reader asking for Durham)*
- grant inside lens → the grant *(a Durham lead asking for the region)*
- neither contains the other → **empty**

That last line is the whole security story: a Durham lead who sends a Chapel
Hill lens gets **200 with no rows**, never Chapel Hill's data. So no validation
of the header is load-bearing, and the worst a crafted value achieves is
showing its sender less than they are owed.

**It rides on the principal, not on each route.** `principal.lensPath` is
resolved once in `plugins/rbac.ts`, so the ~100 query sites already calling
`portfolioWhere(principal, …)` honour it with no edit — and so does a view written
next year. A per-route `?portfolioId=` param existed briefly on `/operations` and
was removed: it made exactly one panel narrowable, and the failure mode of
forgetting it elsewhere is the silent one this whole feature exists to avoid.

**A lens may hide a row. It may never refuse an action.** `can()` does not read
`lensPath` — **G47** fails the build if anything in `@repo/permissions` after
the type declaration does, or if any API file outside `portfolioScope` / `portfolioLens`
/ `rbac` reads it. A lens that could 403 would hand a worker a refusal naming a
capability they genuinely hold, from a dropdown they set last Tuesday. This is
also why the lens *does* narrow lists for `work.claim` / `work.complete`, which
a **grant** never narrows: filtering what you are shown is the request; the
Chapel Hill visit opened by its link is still claimable.

**It is persisted, and therefore it is loud.** The choice survives a reload,
which is the convenience being asked for. The cost is the feature's one real
hazard — "Chapel Hill earned nothing this month" and "you have been looking at
Durham since Tuesday" are the identical empty screen. So the header chip names
the portfolio whenever one is in force, and the INSIGHTS note stops claiming "the
whole company". The chip is what pays for the persistence; do not remove one
without removing the other.

**It is hidden when there is no choice.** Fewer than two selectable portfolios means
no picker: somebody granted Durham alone already sees Durham, and a control
that cannot change anything teaches people to distrust the ones that can.

Enforced by `portfolio-lens-owner.spec.ts` (both properties: one control narrows
the whole app, and a forged lens shows nothing rather than more) and the lens
block in `apps/api/src/lib/portfolioScope.test.ts`.

---

## The three permission systems

After this work there are three, answering three different questions. This is
correct, not accidental — collapsing them is worse. Ownership as an entitlement
would need per-record ACLs; redaction as entitlements would need dozens of
field-level flags and still could not express context (peek redaction depends
on whether you are assigned, not on your role).

| System | Answers | Shape at the call site |
|---|---|---|
| **Entitlements** | may you reach this resource at all? | `can(user, "money.approve")` |
| **Ownership** | may you act on this specific record? | `isClaimer` / `isActiveAssignee` |
| **Redaction** | which fields survive? | `redact*ForCaller(rows, uid, canManageSchedule)` |

> **Entitlements gate the route. Ownership gates the record. Redaction trims
> the payload.** In that order, and never substitute one for another. In
> particular: **a missing entitlement is never worked around by redacting the
> response.** A route that answers and then blanks the sensitive fields is
> still a route that should not have answered.

The three naming shapes above are already visually distinct in this codebase.
Keep them that way and the code says which system it is in.

"My own X" — my payouts, my hours, my jobs — is **always ownership**, never an
entitlement.

**And so is acting on a record you are the claimer of.** This is the subtle
half, and the route map got it wrong on 36 routes before it was caught. A
worker rescheduling their own visit, adding an addon to it, snoozing its
reminder, cancelling its payment request or writing its completion splits is
exercising OWNERSHIP, not `schedule.manage` or `money.record`. Every one of
those handlers already proves it: they resolve `currentUserId(req)` and check
claimer or assignee before doing anything — `completion-splits` comments
"Auth: the claimer, or `schedule.manage`" in as many words.

The test for which system a route belongs to is **not the verb in its path**.
It is: *would someone with `schedule.manage` with no relationship to this record be allowed to do
it?* If yes, it needs an entitlement. If the answer is "only because they are
someone with `schedule.manage`", the worker's version of that route is ownership and the manager’s
version is the entitlement — two routes, two systems, same verb.

Getting this wrong is not a labelling error, it is an escalation. Mapping a
worker-guarded own-visit route to `schedule.manage` and then deriving WORKER's
bundle from the guards would have handed every worker all 85 of that
entitlement's routes, `/change-requests/:x/approve` among them — and
ownership checks cannot catch it, because approving a change request has no
owner.

---

## Traps found by stress-testing the design

Each of these was found by inventing a role or situation and asking what
breaks. They are listed because every one of them is invisible until it bites.

### `can()` must never touch the database

This codebase already has the rule, learned the hard way: *resolve roles from
`req.user`, never a DB lookup — a fresh read bypasses view-as and restores
real powers.*

`can(user, cap)` is **exactly** where someone will reintroduce that bug,
because entitlements live in new tables that are not on the token. Someone with `schedule.manage`
viewing-as a worker calls `can()`, it queries the database, it finds the
**admin's** entitlements, and the view-as session silently has full powers
while the UI insists it is showing a worker.

`req.user` is already populated by a single DB read per request in
`plugins/rbac.ts` (`services.currentUser.me(clerkUserId)`). So the rule is not
"never read the database" — it is **where** that read happens:

> **Entitlements resolve inside `me()`, alongside roles, and ride on
> `req.user`. `can()` takes an already-resolved principal — NEVER a userId.**

A `can(userId, cap)` signature guarantees someone adds a lookup. Make the
type make it impossible: `can(principal, cap)`.

### Impersonation swaps roles ONLY — RESOLVED, kept for the rule it yielded

`plugins/rbac.ts` applies role impersonation like this:

```ts
const impersonation = resolveImpersonation(me.roles, req.headers[IMPERSONATE_HEADER]);
const effective = impersonation ? { ...me, roles: impersonation.roles } : me;
```

The trap: **add entitlements as a sibling field on `me` and impersonation
will not swap them** — someone viewing as a lesser role would get that role
plus their own full entitlement set, while the UI insists it is showing the
lesser one.

> **This was avoided.** A perspective is not a role swap: it carries its own
> `entitlements` subset on the principal
> (`principal.perspective.entitlements`), and `can()` intersects with it. It
> can only ever narrow, which G35 enforces. The rule below is why the shape
> came out that way, and it still binds.

> **Resolution order is load-bearing: resolve roles → apply impersonation →
> resolve entitlements FROM the possibly-impersonated roles.** Never resolve
> entitlements before impersonation, and never carry them as an independent
> field that impersonation does not touch.

There is a second impersonation path — `plugins/clientImpersonation.ts`, which
swaps the effective Clerk user id for client view-as. It is read-only at the
plugin layer, so writes cannot leak, but it must be checked against the same
rule.

### Audit scopes need a migration

`AuditScope` is a Prisma enum, and every state change in this app writes an
`AuditEvent`. There is no `ROLE`, `PORTFOLIO` or `ASSIGNMENT` scope today, and the
enum's own comments show scopes being added with each feature.

- **Step 1** adds `ROLE` (definition and grant/revoke).
- **Step 3** adds `PORTFOLIO` and `PORTFOLIO_ASSIGNMENT`.

Easy to forget, and forgetting it means role changes mutate state with no
trail — which the audit-coverage gate exists to prevent.

### `inventory.pull` and `expenses.charge` — grants, not inferred defaults

*(As designed: `User.canPullInventory` and `canChargeBusinessExpenses` WERE
nullable columns with per-workerType defaults, resolved at runtime by
`lib/privileges.ts`. All three are now deleted — the design below is what
replaced them. `canPullInventory` survives only as a field NAME on the
`/api/me` `privileges` payload, a wire contract carrying the value of
`inventory.pull`.)*

Carried over as-is those columns broke the additive rule: a per-user `false`
on a CONTRACTOR who defaults to `true` is a **subtraction**.

The conflict exists only because the default is *permissive and implicit*.
Remove the inference and it disappears:

> **Materialise the grant as a row instead of inferring it at runtime.**
> Creating a user — or changing their worker type — SEEDS the matching
> grants. Denying one person means **deleting their row**, which is an
> absence, not a negative entry.

So both stay ordinary role-layer entitlements and `can()` keeps a single
layer. `resolvePrivileges`' two-tier resolution goes away.

**Migration:** write today's *effective* values into rows — computed through
`resolvePrivileges`, so nobody's access changes on the day — then drop the two
columns.

**The one behaviour change, and it is an improvement:** changing a worker type
no longer silently grants anything. Today TRAINEE → EMPLOYEE starts allowing
inventory pulls because the default moved underneath them. With rows it
becomes an explicit step — *"Apply Employee defaults? `inventory.pull` will be
granted."* A capability that changes on a dropdown edit is exactly what nobody
notices until a trainee walks off with a mower.

### Custom roles are absolute grants, not deltas

A custom role lists **what it grants**, full stop. It never describes a
difference from a base role, for one concrete reason: the same role is
assigned to people with different bases. "District Manager" goes to a WORKER
in the field and to an office-based STAFF manager; the role definition is
identical and the resulting union differs per person.

Consequences:

- **Promotion is purely additive and breaks nothing.** A STAFF coordinator
  holding a custom role who is promoted to WORKER simply gains WORKER's
  bundle. The custom role is untouched; overlap is harmless because a union
  holds a grant once.
- **Demotion is symmetric.** Dropping WORKER removes that bundle and leaves
  the custom role intact — it never depended on it.
- **You never re-tick what a base role already gives.** The role builder shows
  the built-in bundles as read-only columns beside the one being edited, so
  redundancy is visible rather than guessed at.
- When assigning, show the overlap: *"3 of these 8 are already granted by
  their base role."*

Promotion should still **prompt a review** of any custom role the person
holds — not because anything breaks, but because a role written for a
desk-bound coordinator may read oddly on someone now in the field.

### Day one: backfill every occurrence

Shipping with one all-encompassing portfolio is only safe if **existing rows point
at it**. A nullable `JobOccurrence.portfolioId` left unset means every subtree
rollup returns zero and last year's revenue vanishes from the manager view the
day portfolios ship.

The Step 3 migration backfills all existing occurrences, jobs and properties
to the root portfolio, in the same migration that creates it.

---

### Non-human callers need a named principal

`can(user, …)` assumes a user. These have none:

| Caller | Authenticates with |
|---|---|
| `cron/*` | shared `CRON_SECRET` bearer |
| `public/pay` | per-payment token |
| `public/display` | paired device token |
| `public/promotion`, `public/vanity`, `public/mo` | nothing |

The gap is already visible in the code — `enforceAssigneeInvariants(tx, id, null)`
carries the comment *"No actor in scope — this runs during automatic chain
rollover."*

Introduce an explicit **`SYSTEM` principal** that bypasses `can()` by design,
rather than every background path passing `null` and hoping. It must appear in
the audit log as a system action, so "who did this?" never answers "nobody."

### Offboarding is a flow, not a flag

Someone leaves holding WORKER, managing a portfolio, and as **claimer on a dozen
open visits**. They cannot be deleted — `JobOccurrenceAssignee.userId` is
`onDelete: Restrict`. Suspending their grants removes *authority* and does
nothing about *ownership*, so those visits keep pointing at someone who will
never log in again.

Offboarding needs: transfer open work → suspend grants → retire the account.
Design it in Step 2; the first departure will otherwise be handled by hand.

### Temporary cover needs to be visible

Someone covers another manager's portfolio for two weeks. With suspension and no
expiry, the assignment stays until a human removes it, and the dormancy check
**will not catch it** — the stand-in is active, merely over-privileged.

Mark such assignments temporary with a note, and surface them in the same
audit panel: *"Dana has held District Manager (Raleigh) as temporary cover
since Oct 4."* Visibility, not automation — but it has to exist rather than
being assumed away.

### ~~Break-glass must bypass entitlements entirely~~ — SUPERSEDED (decision 47)

The proposal was to keep the env-var break-glass, resolving independently of
the entitlement tables so one bad row could not lock the owner out.

It was deleted instead. With no enum roles left to grant, break-glass would
have had to resolve THROUGH those tables — making the recovery path the
thing that needs recovering. Recovery is re-running
`install-starter-roles.ts` against the database, which cannot be locked out
because it never calls `can()`.

---

## Privilege escalation

Two rules, both load-bearing:

1. **Role definition needs `roles.define`.** Without
   this, anyone holding `people.manage` creates a role called "Helper", ticks
   `money.approve`, and assigns it to themselves.
2. **You can never grant an entitlement you do not hold.** Someone with `schedule.manage` can make
   someone a dispatcher; they cannot make someone a bookkeeper if they cannot
   see the books.

Rule 2 needs a build gate. It is obviously right and silently missing by
default.

---

## Suspension, not expiry

Grants carry `suspendedAt`, per grant — "pause Jake's Raleigh management"
without touching his ability to mow. Account-level suspension already exists as
`User.isApproved`.

**Deliberately NOT time-based expiry.** Date-based revocation fails silently
and at the worst moment: the seasonal worker arrives Monday, the date rolled
over Sunday, and they cannot start a job with no explanation on screen. That is
the same silent-failure shape as the view-as and claimer bugs. Manual
suspension fails loudly, because a human did it and knows why. It is also one
fewer date field in a codebase that needs a build gate to keep dates correct.

The real risk — forgetting — is solved by **visibility, not automation**. A new
AuditTab check, using the `lastSignInAt` already on User:

> **Dormant access** — *"Jake holds WORKER and District Manager (Raleigh). Last
> signed in 94 days ago."*

Surfaces it, revokes nothing. Same philosophy as the compliance banner.

---

## UI

**Role builder (SUPER).** Building a role starts by optionally **copying a
base role's entitlements** — pick Worker and its boxes fill in, then add the
one you actually wanted. The copy is a **starting point, not a link**: the
saved role holds every entitlement explicitly and never consults Worker
again, which is what keeps roles absolute rather than deltas.

> The copy MUST warn at the moment it happens: *"This copies 6 entitlements
> from Worker. Anyone assigned this role receives them, whether or not they
> are a Worker."* Otherwise a "Worker+1" role handed to the office
> coordinator quietly lets her claim and complete jobs.

Record "created from Worker" on the role for display only — no behaviour, but
a year later it explains where the role came from.

 A matrix: rows are entitlements, columns are
STAFF · WORKER · ADMIN · SUPER · each custom role. Built-in columns are
read-only with a lock — they are documentation, not configuration.

> The matrix must be **generated from the same table `can()` reads.** A
> hand-maintained copy drifts and then lies to you about your own security.
> Gate it: every entitlement must appear.

The four-axes table above belongs in the informational help on this page.

**Effective permissions (per user).** "What can this person actually do?",
resolved across base role, custom roles and portfolio assignments — **with
provenance**:

```
money.view     global   via "Estimator"
money.view     Raleigh  via "District Manager"
```

Provenance is not a nicety. Because the union means a global grant always beats
portfolio scoping, "Pete is District Manager of Raleigh" reads like a boundary while
a stray global grant quietly erases it. Without provenance nobody can debug
that.

**Where assignments appear:** ProfileTab (own, read-only), a caller with `schedule.manage` user
detail beside wages and worker type (edit), and the portfolio tree — click Raleigh,
see who covers it. No new top-level tab; a Manager tab would imply manager is a
role.

**Naming.** A custom role's `name` is its display text ("Regional Manager"),
to be suggested from a `MANAGER_TITLES` setting, same pattern as the other
config-driven taxonomies; portfolio tier names likewise from `PORTFOLIO_TIER_NAMES`.

> **BUILT 2026-10-18.** Both Setting rows exist in the `catalogs` section
> and are editable on the Settings tab. `MANAGER_TITLES` is a flat string
> array, offered by `RolesTab` as clickable chips under the new-role name
> box. `PORTFOLIO_TIER_NAMES` is an array of `{ name, description }`
> (2026-10-29 — it shipped as bare strings, and both shapes are still
> read): `PortfoliosTab` renders the tier field as a Select over it and
> shows the chosen tier's description under the picker. The "Other
> (specify…)" free-text escape was **removed the same day** — it was right
> while the list needed a developer to extend, and wrong once the list
> became operator-editable AND each entry carried its definition, because
> a typed-in tier is a level with no meaning recorded anywhere. A saved
> value that is off-list is still shown and still selected; it just cannot
> be chosen again. `Portfolio.tier` remains a free string in the schema
> and the API still accepts any text — this is about where a new level is
> born, not a new constraint on the data. That sentence is the point of the richer shape —
> "Zone" and "Route" are ordinary words whose difference here is a rule
> (a route has an order, a zone has a boundary), and an operator choosing
> blind mixes them. The shipped vocabulary is **State → Market → District
> → Zone** as a nesting spine, plus **Route** and **Book**, which cut
> across it and sit at the lowest node containing everything they touch.
> `install-starter-roles.ts` replaces a value only when it still matches
> one we shipped exactly (`supersedes`), so an edited vocabulary is never
> overwritten.
>
> Both remain **suggestions, not vocabularies** — `Portfolio.tier` and
> `CustomRole.name` are free strings and stay that way, because an operator
> who runs "Zones" rather than "Districts" must not have to ask. A saved tier
> that is not in the list opens in free-text mode rather than being silently
> reset, and a malformed taxonomy degrades to "no suggestions" rather than
> throwing.

> **"Manager" never appears in UI copy.** It is a job title someone typed
> into the `MANAGER_TITLES` taxonomy, not something the system knows. The
> schema has portfolios and assignments; it has no concept of a manager. Copy says
> **"anyone assigned to this portfolio"**, or names the portfolio's totals directly.
> Writing "manager" in an interface quietly promotes a label into a role and
> undoes the decision this whole design rests on.
>
> Surfaces are named for what they show, not who looks at them: *Portfolio
> rollup*, not *Manager dashboard*.

> **No code ever branches on a role or tier name.** It is a label. The
> entitlements are the behaviour. One grep-based gate: the name field must
> never appear in a conditional.

---

## Every UI surface this touches

> **This section is a SURVEY OF THE BEFORE STATE, taken 2026-10-11/14, and
> the work it describes shipped on 2026-10-17.** Its counts, its file lists
> and its "CLEAN / RESIDUAL" findings are all from before the change; they
> are kept because the reasoning that follows depends on them. For what the
> UI does now: one tab per feature, `TAB_REQUIREMENTS` in
> `apps/web/src/lib/tabRequirements.ts` decides which tabs exist, and
> `scope.can(entitlement)` decides what is on each. `Scope` has one field.
> The surface-flag factory, its capability map, `purpose` and the three
> surface flags are all deleted.

**44 tabs, 45 dialogs, 86 components, ~1,300 role touchpoints in web** —
measured; the breakdown is under *Web audit*. The UI is the bulk of this
work.

### New surfaces

| Surface | Where | Step |
|---|---|---|
| Role builder + permissions matrix | Settings | 2 |
| Effective permissions, with provenance | Admin user detail | 2 |
| "Your access" (read-only) | ProfileTab | 2 |
| Offboarding flow — transfer work, suspend, retire | Admin user detail | 2 |
| Dormant access check | AuditTab | 2 |
| Worker-type defaults prompt on type change | Admin user detail | 2 |
| Portfolio tree manager + guided move action | Super | 3 |
| Portfolio assignment editor | User detail **and** portfolio tree | 3 |
| "Who covers this portfolio" | Portfolio tree node | 3 |
| Portfolio rollup tab (conditional on holding an assignment) | Shell | 3 |
| Portfolio selector, like view-as | `BreadcrumbNav` `headerRight` | 3 |
| Portfolio-assignment badge component | Board roster, assignee lists, user detail | 3 |
| Temporary cover check | AuditTab | 3 |

### Changed surfaces, by kind of change

**A — Tab visibility.** `navTabs` in `pages/index.tsx`: every `visible:`
function moves from role checks to `can()`. One file, high leverage, do first.

**B — In-tab gating. 28 of 44 tabs** branched on
one of the role flags when this was written. All 28 have since been
converted:

> TasksTab · CrewsTab · NotifyTab · ComplianceTab ·
> ClientsTab · CollectionsTab · DocumentsTab · GuidesTab · HomeTab (+parts) ·
> InventoryTab · JobsTab (+parts) · PayrollTab · PaymentsTab ·
> PreviewRoutesTab (+parts) · ProfileTab · PricingTab · PropertiesTab ·
> ServicesTab · ReconcileTab · SettingsTab · UnclaimedTab · SuppliesTab ·
> UsersTab · TimelineTab · VehiclesTab

**C — Portfolio filtering.** The list surfaces behind the ~101 scopable routes.
Where a missed filter silently shows another territory's clients.

**D — New data on existing screens.** ProfileTab (your roles and portfolios),
UsersTab (assignments beside wages and worker type), HomeTab (rollups become
portfolio-aware).

**E — Settings.** Two new taxonomies, `PORTFOLIO_TIER_NAMES` and `MANAGER_TITLES`.
`MANAGER_TITLES` uses the generic string-list editor; `PORTFOLIO_TIER_NAMES`
has its own name + description editor, because the generic one coerces each
row with `String(x)` and would save `"[object Object]"` over the vocabulary.
**Built 2026-10-18** — sections A–E have all shipped.

### Web audit, 2026-10-11

Measured, not estimated — and this is the **only** role count this design
publishes. Everywhere else points here, because three different figures
(~987, ~1,100, ~1,300) were once in circulation with no definition
attached to any of them. **~1,300 role touchpoints in `apps/web`**, the
breakdown below summing to 1,303. The API has its own, uncounted:

```
353  top-role flag      227  tab-scope flag     82  scope.is*
342  staff-role flag    169  staff-extras flag  15  me?.roles
109  top-extras flag                            6  hasRole()
```

**FINDING 1 — there is no shared `Scope` type.** *(Seventeen, not sixteen:
`ui/pages/TasksPage.tsx` declares it across multiple lines, so a one-line
grep misses it. G1 matches flexible whitespace — trust the gate, not a grep.)* Seventeen files declare it
inline:

```ts
scope?: { /* three role booleans, one per deleted role */ };
```

Each is its own structural type. Adding `can` or `portfolios` means editing
seventeen literals, and **TypeScript cannot tell you which one you missed** — a
tab left on the three-field shape compiles perfectly and silently keeps the
old behaviour.

> **Step 1 must introduce one exported `Scope` type and convert all seventeen
> before anything else.** It is a mechanical refactor whose entire value is
> that the compiler then enforces every later change. Without it the portfolio and
> entitlement work has no safety net on the web side at all.

**FINDING 2 — scope construction is not uniform.** Ten tabs fall back to
deriving scope from legacy props (`purpose`, `role`, `readOnly`) when none is
passed, and the derivations disagree with each other:

```ts
// most tabs      — staff flag from the shell
purpose === "ADMIN" || purpose === "SUPER"
// SuppliesTab    — top flag, ANDed with a prop
purpose === "SUPER" && !readOnly
// PricingTab     — a different shape entirely
!topFlag && !!readOnly
```

Two parallel sources of scope, inconsistently mapped. Collapse onto the
single prop as part of Finding 1's refactor.

**FINDING 3 — `CrewsTab` fails OPEN.**

```ts
const effScope = scope ?? { /* …the staff flag defaulted to TRUE… */ };
```

A missing scope prop yields the staff surface. Harmless today because the caller
always passes one; actively dangerous once scope carries capabilities, since
a forgotten prop would grant admin-level UI. Every default must fail closed.

**CLEAN at the time — the top-role flag never fell back.** All ten
definitions read the scope prop, optionally ANDed with the real grant.
*(Moot now: the flag and the rule about it are both gone. What replaced the
rule is that a control asks for the entitlement its own route is guarded on,
which G15 enforces.)*

**CLEAN — the web is lens-aware.** `GET /me` passes the perspective header
through to `services.users.me(...)`, which narrows the capability set before
returning it, so the web receives an already-narrowed `capabilities` array and
cannot widen it. The server-side impersonation trap does **not** have a web
twin.

> Written when the surface-flag factory read `me.roles`. Both it and its
> capability map are now deleted; every component reads
> `me.capabilities` through `scope.can()` or `scopeFromMe(me)`. The
> conclusion is unchanged and the mechanism is stronger: narrowing happens
> once on the server rather than being re-derived in the browser.

**RESIDUAL, not audited — UI/server agreement per action.** This session found
one real instance: the Unclaim button was gated on `isClaimer` alone while
`unclaimOccurrence` permits `isClaimer || schedule.manage`, so a visit that lost its
claimer could not be released by anyone, at any role. That class exists and
has not been swept. A gate asserting every UI action's condition matches its
route's guard is worth building during Step 2, while the guards are being
rewritten anyway.

### The riskiest UI change — and what actually happened

The prediction was the additive scope object — three role booleans gaining
portfolios and capabilities, with the footgun that the top-role flag must not
fall back to the staff one.

That is not where the risk turned out to be. The object was not extended —
it was **reduced to one field**, `can`, which deleted the footgun outright
along with the three flags. The real risk was the opposite shape: a flag
RENAMED to a capability it does not hold. Converting one role flag to a
single capability across a file produced 23 sites in JobsTab where the name
said `settings.manage` and the control needed `schedule.manage`. A
confidently wrong name is worse than the honest role flag it replaced,
because nothing about it reads as suspicious. Convert site by site against the route map; never sed.

---

## Build order

**One project, one arrival point.** Nothing intermediate is deployed: the
operator will not commit or promote until the whole thing is built and tested
locally. That removes the usual argument for staged releases and, with it, the
compatibility scaffolding a staged build would need — notably a `can()`
backed by existing roles, which exists only to keep an app working between
drops. Build `can()` against real entitlements from the start.

What remains is **dependency order**, not release phases:

| Step | What | Depends on |
|---|---|---|
| **1 · Foundations** | one exported `Scope` type, fail-closed defaults, `can(principal, cap)`, capabilities resolved after impersonation | — |
| **2 · Permissions** | STAFF, `CustomRole` / `RoleEntitlement` / `UserCustomRole`, route→entitlement mapping, migrate off the privilege columns, role builder, effective-permissions view, offboarding | 1 |
| **3 · Portfolios** | `Portfolio` + `PortfolioAssignment`, materialized `path`, `portfolioScope()`, root portfolio + backfill, tree UI, guided move, rollup tab, portfolio selector | 2 |
| **4 · Join** | `can(principal, cap, { portfolioId })` | 2, 3 |

Migrations still accumulate one at a time — a migration applied to dev is
frozen and superseded by a new one, never edited — but they ship as one set.

**The gates are the only continuous feedback.** With no intermediate deploys
there is no production signal until the end, so the gates and the test
matrix are what tell you it is working. Write each gate before the code it
guards.

## Questions carried over from the original portfolio design

These were open in the September design. Four were lost when that memory file
was rewritten; they are restored here with their current status.

| | Question | Status |
|---|---|---|
| **A** | When does a visit's portfolio freeze? | **Resolved, and shipped as a join rather than a column.** Synced from the property while the visit is open, left alone from completion — the same rule as completion splits. There is no `frozenAt` stamp: completion *is* the record. |
| **B** | Worker activity vs. portfolio work | **Resolved — both.** A Raleigh-assigned worker doing a Durham job appears for both managers. The rollup **defaults to portfolio** ("Raleigh") with a **toggle to people** ("My team"), because a territory's revenue is the territorial number; the toggle exists so the manager can see the two answers differ. Never merged into one figure — that would double-count the same visit across two managers. |
| **C** | What money can a manager see? | **Resolved by the entitlement split.** `money.view` scoped to a portfolio gives payments on occurrences in that subtree. `books.*` is global-only, so no company P&L unless explicitly granted. |
| **D** | Two managers over one portfolio? | **Resolved.** Allowed — the union is safe. Design the UI for the single-manager case and let the second be a list. |
| **E** | Cycle prevention on reparent | **Resolved** — portfolios are never reparented. |
| **F** | Does moving a portfolio rewrite list history? | **Resolved** — copy-and-retire; nothing moves. |
| **G** | Order of scoping the portfolio-scopable routes | **Guidance, no longer a release decision.** Money surfaces first: highest consequence, smallest surface, and they start at the occurrence so they gain one `where` clause with no joins. Lists after. |
| **H** | Read-only or read-write manager? | **Dissolved.** Once entitlements exist it is a checkbox on a role, not an architecture decision. |
| **I** | Does someone with `settings.manage`'s assignment act as a UI lens? | **Resolved.** Yes — a filter, never a cage. Authority is global OR the union of assignments, never the intersection. |

## Settled late, worth the note

- **Role assignment is `people.grant-roles`**, an entitlement bounded by *you
  cannot grant what you do not hold* (**G6**). Definition stays `roles.define`.
  Assignment is operational — someone with `schedule.manage` should be able to make someone a
  dispatcher without the owner — and the bound is what makes that safe. A
  full admin could already perform those actions directly, so passing them on
  is not an escalation.
- **A role held globally AND on a portfolio shows BOTH lines**, the portfolio one
  marked *"redundant — already granted globally"*. Deduplicating silently
  would hide a misconfiguration; the provenance view exists to explain why
  someone has something, so it shows the pointless row rather than tidying it
  away.
- **Warn past four levels** of portfolio depth. State › Region › District › Portfolio
  covers any realistic org chart at this size; the fifth is usually someone
  modelling something that is not a territory. Warn, never block.

## Where invariants must be enforced

Write each gate **before** the first route it guards. Both of this codebase's
worst recurring bug classes — view-as endpoints (shipped three times) and the
claimer invariant — are *silent*: the page renders, it just shows the wrong
thing. An unscoped portfolio list and an unguarded entitlement route are exactly
that shape.

The playbook already exists: `businessStartCutoff` is a cross-cutting filter
threaded through 19 files with shared helpers and a build gate that fails the
build on an unfiltered money query. Do that.

**The authoritative gate list is in
[`permissions-BUILD.md`](permissions-BUILD.md)**, with each assertion written
out and scheduled against a step. It is kept there rather than here because
it is a build artifact: it changes as code lands, and this document should
not.

> That is why no count or range appears here. An earlier version of this
> sentence named a range ending at the fifteenth gate — in the same breath
> as explaining why the list does not belong in this file — and was still
> saying it once there were twenty-eight.
> `permissions-docs-build-gate` now fails on a gate range in this document.

Summarised, in the order the build file schedules them: one `Scope` type and
fail-closed defaults; capabilities resolved after impersonation, every route
declaring an entitlement, no granting what you lack, a generated matrix,
break-glass independent of the entitlement tables; then portfolio scoping with an
allow-annotation, the worker feed never narrowed, the tree acyclic, retired
portfolios present in reporting, no reparenting; and UI conditions matching their
route guards throughout.

## Known limitations / non-goals

- **No subtraction.** Entitlements only add. "ADMIN but not payroll" is not
  expressible; to restrict someone you drop their base role and rebuild from
  custom roles. The escape hatch, when it is needed, is to make the built-in
  bundles into preset custom roles — then everything is a bundle and omission
  replaces subtraction.
- **Global beats scoped**, always. A globally-granted entitlement cannot be
  narrowed by a portfolio assignment. Provenance in the UI is the mitigation.
- **Reorganising the tree splits a portfolio across two parents** in any report
  spanning the change. Correct, but needs explaining in the UI.
- **No time-based access.** By choice; see *Suspension, not expiry*.
- **Projects are not modelled.** Oversight is territorial: portfolios contain
  properties, properties have jobs. A large piece of work is a job at a
  property inside someone's portfolio. Raised in review and confirmed as a
  non-goal — there is no cross-portfolio programme-of-work concept.
- **Client contacts are undifferentiated.** A client may have several
  `ClientContact` rows — a homeowner and their property manager, or a business
  where one person schedules and another pays — and the portal treats them
  interchangeably. The client axis has no granularity. Out of scope here, but
  it is the axis we have thought least about.
