-- DropForeignKey
ALTER TABLE "public"."GuaranteedPayoutAdvance" DROP CONSTRAINT "GuaranteedPayoutAdvance_exportedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GuaranteedPayoutAdvance" DROP CONSTRAINT "GuaranteedPayoutAdvance_occurrenceId_fkey";

-- DropForeignKey
ALTER TABLE "public"."GuaranteedPayoutAdvance" DROP CONSTRAINT "GuaranteedPayoutAdvance_userId_fkey";

-- DropIndex
DROP INDEX "public"."PaymentSplit_guaranteedPayoutPaidAt_idx";

-- AlterTable
ALTER TABLE "PaymentSplit" DROP COLUMN "guaranteedPayoutPaidAt";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "guaranteedPayoutHistory",
DROP COLUMN "guaranteedPayoutStartedAt",
DROP COLUMN "guaranteedPayoutUntil";

-- DropTable
DROP TABLE "public"."GuaranteedPayoutAdvance";

