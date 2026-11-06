-- WHO HAS BEEN TOLD ABOUT A SHIPPED CHANGE.
--
-- One row per person per announcement, written the first time they answer
-- the "what's new" bar. Its existence is what stops the bar returning, so
-- the unique index is the feature, not an optimisation: without it a double
-- click or two tabs would write two rows and the bar would keep coming back
-- for one of them.
--
-- `announcementId` is a key from the web app's registry, not a foreign key —
-- the announcements themselves ship in the code with the release they
-- describe. See the model comment in schema.prisma.
CREATE TABLE "FeatureAnnouncementSeen" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureAnnouncementSeen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeatureAnnouncementSeen_userId_announcementId_key"
    ON "FeatureAnnouncementSeen"("userId", "announcementId");

CREATE INDEX "FeatureAnnouncementSeen_announcementId_idx"
    ON "FeatureAnnouncementSeen"("announcementId");

-- Cascade: a deleted account takes its acknowledgements with it. There is
-- nothing to keep — the row is only meaningful next to the person.
ALTER TABLE "FeatureAnnouncementSeen"
    ADD CONSTRAINT "FeatureAnnouncementSeen_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
