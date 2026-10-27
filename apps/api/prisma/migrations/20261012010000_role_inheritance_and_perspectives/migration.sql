-- Roles gain a stable key, inheritance, and the perspective flag.
--
-- key            — what a starter script upserts by, so rebuilding the
--                  baseline roles preserves ids and therefore every
--                  assignment pointing at them. `name` is an editable label
--                  and can never serve this purpose.
-- inheritsFromId — roles build on each other. Restrict on delete: removing a
--                  role others build on would silently strip entitlements
--                  from everyone holding them.
-- isPerspective  — this role appears in the top-tab dropdown, letting someone
--                  view the app as a person with less access would.

-- AlterTable
ALTER TABLE "CustomRole" ADD COLUMN     "inheritsFromId" TEXT,
ADD COLUMN     "isPerspective" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "perspectiveOrder" INTEGER;
-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_key_key" ON "CustomRole"("key");
-- CreateIndex
CREATE INDEX "CustomRole_key_idx" ON "CustomRole"("key");
-- CreateIndex
CREATE INDEX "CustomRole_inheritsFromId_idx" ON "CustomRole"("inheritsFromId");
-- CreateIndex
CREATE INDEX "CustomRole_isPerspective_perspectiveOrder_idx" ON "CustomRole"("isPerspective", "perspectiveOrder");
-- AddForeignKey
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_inheritsFromId_fkey" FOREIGN KEY ("inheritsFromId") REFERENCES "CustomRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
