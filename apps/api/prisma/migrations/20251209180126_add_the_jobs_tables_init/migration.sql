-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('ENTIRE_SITE', 'SINGLE_ADDRESS');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PROPOSED', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "Cadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "JobOccurrenceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "JobOccurrenceSource" AS ENUM ('GENERATED', 'MANUAL');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL DEFAULT 'SINGLE_ADDRESS',
    "status" "JobStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobContact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clientContactId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JobContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobClient" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "share" DOUBLE PRECISION,

    CONSTRAINT "JobClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSchedule" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "cadence" "Cadence",
    "interval" INTEGER,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "preferredStartHour" INTEGER,
    "preferredEndHour" INTEGER,
    "horizonDays" INTEGER NOT NULL DEFAULT 21,
    "nextGenerateAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOccurrence" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "JobOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "source" "JobOccurrenceSource" NOT NULL DEFAULT 'GENERATED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAssigneeDefault" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAssigneeDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOccurrenceAssignee" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,

    CONSTRAINT "JobOccurrenceAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobContact_jobId_idx" ON "JobContact"("jobId");

-- CreateIndex
CREATE INDEX "JobContact_clientContactId_idx" ON "JobContact"("clientContactId");

-- CreateIndex
CREATE INDEX "JobClient_jobId_idx" ON "JobClient"("jobId");

-- CreateIndex
CREATE INDEX "JobClient_clientId_idx" ON "JobClient"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "JobSchedule_jobId_key" ON "JobSchedule"("jobId");

-- CreateIndex
CREATE INDEX "JobOccurrence_jobId_status_idx" ON "JobOccurrence"("jobId", "status");

-- CreateIndex
CREATE INDEX "JobOccurrence_startAt_idx" ON "JobOccurrence"("startAt");

-- CreateIndex
CREATE INDEX "JobOccurrence_kind_idx" ON "JobOccurrence"("kind");

-- CreateIndex
CREATE INDEX "JobAssigneeDefault_jobId_active_idx" ON "JobAssigneeDefault"("jobId", "active");

-- CreateIndex
CREATE INDEX "JobAssigneeDefault_userId_idx" ON "JobAssigneeDefault"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssigneeDefault_jobId_userId_key" ON "JobAssigneeDefault"("jobId", "userId");

-- CreateIndex
CREATE INDEX "JobOccurrenceAssignee_occurrenceId_idx" ON "JobOccurrenceAssignee"("occurrenceId");

-- CreateIndex
CREATE INDEX "JobOccurrenceAssignee_userId_idx" ON "JobOccurrenceAssignee"("userId");

-- CreateIndex
CREATE INDEX "JobOccurrenceAssignee_assignedById_idx" ON "JobOccurrenceAssignee"("assignedById");

-- CreateIndex
CREATE UNIQUE INDEX "JobOccurrenceAssignee_occurrenceId_userId_key" ON "JobOccurrenceAssignee"("occurrenceId", "userId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobContact" ADD CONSTRAINT "JobContact_clientContactId_fkey" FOREIGN KEY ("clientContactId") REFERENCES "ClientContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobClient" ADD CONSTRAINT "JobClient_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobClient" ADD CONSTRAINT "JobClient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrence" ADD CONSTRAINT "JobOccurrence_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssigneeDefault" ADD CONSTRAINT "JobAssigneeDefault_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssigneeDefault" ADD CONSTRAINT "JobAssigneeDefault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrenceAssignee" ADD CONSTRAINT "JobOccurrenceAssignee_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrenceAssignee" ADD CONSTRAINT "JobOccurrenceAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrenceAssignee" ADD CONSTRAINT "JobOccurrenceAssignee_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
