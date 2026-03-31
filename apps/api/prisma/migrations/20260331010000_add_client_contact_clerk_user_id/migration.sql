-- AlterTable
ALTER TABLE "ClientContact" ADD COLUMN "clerkUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ClientContact_clerkUserId_key" ON "ClientContact"("clerkUserId");
