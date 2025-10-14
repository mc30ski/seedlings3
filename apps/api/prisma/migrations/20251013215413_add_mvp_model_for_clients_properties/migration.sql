-- CreateEnum
CREATE TYPE "public"."ClientType" AS ENUM ('INDIVIDUAL', 'HOUSEHOLD', 'ORGANIZATION', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "public"."ClientStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."PropertyKind" AS ENUM ('SINGLE', 'AGGREGATE_SITE');

-- CreateEnum
CREATE TYPE "public"."ContactRole" AS ENUM ('PRIMARY', 'SPOUSE', 'COMMUNITY_MANAGER', 'PROPERTY_MANAGER');

-- CreateTable
CREATE TABLE "public"."Client" (
    "id" TEXT NOT NULL,
    "type" "public"."ClientType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "public"."ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "notesInternal" TEXT,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ClientContact" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "normalizedPhone" VARCHAR(20),
    "role" "public"."ContactRole",
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "contactPriority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Property" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "public"."PropertyKind" NOT NULL DEFAULT 'SINGLE',
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "unitLabel" TEXT,
    "unitCount" INTEGER,
    "siteName" TEXT,
    "siteBoundaryGeo" JSONB,
    "pointOfContactId" TEXT,
    "accessNotes" TEXT,
    "photos" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_status_idx" ON "public"."Client"("status");

-- CreateIndex
CREATE INDEX "Client_displayName_idx" ON "public"."Client"("displayName");

-- CreateIndex
CREATE INDEX "ClientContact_clientId_active_idx" ON "public"."ClientContact"("clientId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ClientContact_email_key" ON "public"."ClientContact"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientContact_normalizedPhone_key" ON "public"."ClientContact"("normalizedPhone");

-- CreateIndex
CREATE INDEX "Property_clientId_idx" ON "public"."Property"("clientId");

-- CreateIndex
CREATE INDEX "Property_kind_idx" ON "public"."Property"("kind");

-- AddForeignKey
ALTER TABLE "public"."ClientContact" ADD CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Property" ADD CONSTRAINT "Property_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Property" ADD CONSTRAINT "Property_pointOfContactId_fkey" FOREIGN KEY ("pointOfContactId") REFERENCES "public"."ClientContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
