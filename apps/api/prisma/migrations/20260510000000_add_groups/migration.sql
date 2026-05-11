-- Groups (crews) — Pass 1 + Pass 2 combined.
-- Group is a saved roster of workers + observers led by a single claimer.
-- Assignment to an occurrence materializes group members into individual
-- JobOccurrenceAssignee rows; mid-flight group edits never propagate
-- (snapshot model). Equipment rented on behalf of a group is split per
-- CheckoutSplit rows at release time.

-- ── Group ───────────────────────────────────────────────────────────────────
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "claimerUserId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Group_claimerUserId_idx" ON "Group"("claimerUserId");
CREATE INDEX "Group_archivedAt_idx" ON "Group"("archivedAt");

ALTER TABLE "Group" ADD CONSTRAINT "Group_claimerUserId_fkey"
    FOREIGN KEY ("claimerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── GroupMember ────────────────────────────────────────────────────────────
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'worker',
    "equipmentCostPercent" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── GroupPreferredEquipment ─────────────────────────────────────────────────
CREATE TABLE "GroupPreferredEquipment" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "equipmentCollectionId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupPreferredEquipment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GroupPreferredEquipment_groupId_sortOrder_idx" ON "GroupPreferredEquipment"("groupId", "sortOrder");
CREATE INDEX "GroupPreferredEquipment_equipmentId_idx" ON "GroupPreferredEquipment"("equipmentId");
CREATE INDEX "GroupPreferredEquipment_equipmentCollectionId_idx" ON "GroupPreferredEquipment"("equipmentCollectionId");

ALTER TABLE "GroupPreferredEquipment" ADD CONSTRAINT "GroupPreferredEquipment_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupPreferredEquipment" ADD CONSTRAINT "GroupPreferredEquipment_equipmentId_fkey"
    FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupPreferredEquipment" ADD CONSTRAINT "GroupPreferredEquipment_equipmentCollectionId_fkey"
    FOREIGN KEY ("equipmentCollectionId") REFERENCES "EquipmentCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of equipmentId / equipmentCollectionId must be set.
ALTER TABLE "GroupPreferredEquipment" ADD CONSTRAINT "GroupPreferredEquipment_xor"
    CHECK (("equipmentId" IS NOT NULL) <> ("equipmentCollectionId" IS NOT NULL));

-- ── JobOccurrence.assignedGroupId ──────────────────────────────────────────
ALTER TABLE "JobOccurrence" ADD COLUMN "assignedGroupId" TEXT;
CREATE INDEX "JobOccurrence_assignedGroupId_idx" ON "JobOccurrence"("assignedGroupId");
ALTER TABLE "JobOccurrence" ADD CONSTRAINT "JobOccurrence_assignedGroupId_fkey"
    FOREIGN KEY ("assignedGroupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Checkout.groupId ───────────────────────────────────────────────────────
ALTER TABLE "Checkout" ADD COLUMN "groupId" TEXT;
CREATE INDEX "Checkout_groupId_idx" ON "Checkout"("groupId");
ALTER TABLE "Checkout" ADD CONSTRAINT "Checkout_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── CheckoutSplit ──────────────────────────────────────────────────────────
CREATE TABLE "CheckoutSplit" (
    "id" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutSplit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CheckoutSplit_checkoutId_userId_key" ON "CheckoutSplit"("checkoutId", "userId");
CREATE INDEX "CheckoutSplit_userId_idx" ON "CheckoutSplit"("userId");

ALTER TABLE "CheckoutSplit" ADD CONSTRAINT "CheckoutSplit_checkoutId_fkey"
    FOREIGN KEY ("checkoutId") REFERENCES "Checkout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CheckoutSplit" ADD CONSTRAINT "CheckoutSplit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
