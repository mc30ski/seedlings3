-- DropIndex
DROP INDEX "public"."ClientContact_clerkUserId_key";

-- DropIndex
DROP INDEX "public"."ClientContact_email_key";

-- DropIndex
DROP INDEX "public"."ClientContact_normalizedPhone_key";

-- AlterTable
ALTER TABLE "ClientContact" ADD COLUMN     "personId" TEXT;

-- CreateIndex
CREATE INDEX "ClientContact_email_idx" ON "ClientContact"("email");

-- CreateIndex
CREATE INDEX "ClientContact_normalizedPhone_idx" ON "ClientContact"("normalizedPhone");

-- CreateIndex
CREATE INDEX "ClientContact_clerkUserId_idx" ON "ClientContact"("clerkUserId");

-- CreateIndex
CREATE INDEX "ClientContact_personId_idx" ON "ClientContact"("personId");
