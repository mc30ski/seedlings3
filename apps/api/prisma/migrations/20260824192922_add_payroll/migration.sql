-- CreateEnum
CREATE TYPE "PayrollSourceKind" AS ENUM ('EMPLOYEE_PAYROLL', 'CONTRACTOR_PAYMENTS');

-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'PAYROLL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'PAYROLL_UPLOADED';
ALTER TYPE "AuditVerb" ADD VALUE 'PAYROLL_REPLACED';
ALTER TYPE "AuditVerb" ADD VALUE 'PAYROLL_ARCHIVED';
ALTER TYPE "AuditVerb" ADD VALUE 'PAYROLL_IDENTITY_LINKED';
ALTER TYPE "AuditVerb" ADD VALUE 'PAYROLL_IDENTITY_UNLINKED';

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "sourceKind" "PayrollSourceKind" NOT NULL DEFAULT 'EMPLOYEE_PAYROLL',
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "payDay" TEXT NOT NULL,
    "label" TEXT,
    "sourceR2Key" TEXT NOT NULL,
    "totals" JSONB NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEntry" (
    "id" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "userId" TEXT,
    "rawLastName" TEXT NOT NULL,
    "rawFirstName" TEXT NOT NULL,
    "employeeType" TEXT,
    "paymentMethod" TEXT,
    "workAddress" TEXT,
    "regularHours" DOUBLE PRECISION,
    "regularRate" DOUBLE PRECISION,
    "regularAmount" DOUBLE PRECISION,
    "additionalEarnings" DOUBLE PRECISION,
    "grossEarnings" DOUBLE PRECISION,
    "employeeTaxes" DOUBLE PRECISION,
    "federalIncomeTax" DOUBLE PRECISION,
    "socialSecurityEmployee" DOUBLE PRECISION,
    "medicareEmployee" DOUBLE PRECISION,
    "additionalMedicareEmployee" DOUBLE PRECISION,
    "stateTaxEmployee" DOUBLE PRECISION,
    "employerTaxes" DOUBLE PRECISION,
    "socialSecurityEmployer" DOUBLE PRECISION,
    "medicareEmployer" DOUBLE PRECISION,
    "futaEmployer" DOUBLE PRECISION,
    "stateUnemploymentEmployer" DOUBLE PRECISION,
    "netPay" DOUBLE PRECISION,
    "reimbursements" DOUBLE PRECISION,
    "donations" DOUBLE PRECISION,
    "checkAmount" DOUBLE PRECISION,
    "employerCost" DOUBLE PRECISION,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollIdentity" (
    "id" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollPeriod_payDay_idx" ON "PayrollPeriod"("payDay");

-- CreateIndex
CREATE INDEX "PayrollPeriod_archivedAt_idx" ON "PayrollPeriod"("archivedAt");

-- CreateIndex
CREATE INDEX "PayrollPeriod_uploadedById_idx" ON "PayrollPeriod"("uploadedById");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "PayrollEntry_payrollPeriodId_idx" ON "PayrollEntry"("payrollPeriodId");

-- CreateIndex
CREATE INDEX "PayrollEntry_userId_idx" ON "PayrollEntry"("userId");

-- CreateIndex
CREATE INDEX "PayrollEntry_rawLastName_rawFirstName_idx" ON "PayrollEntry"("rawLastName", "rawFirstName");

-- CreateIndex
CREATE INDEX "PayrollIdentity_userId_idx" ON "PayrollIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollIdentity_lastName_firstName_key" ON "PayrollIdentity"("lastName", "firstName");

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEntry" ADD CONSTRAINT "PayrollEntry_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEntry" ADD CONSTRAINT "PayrollEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollIdentity" ADD CONSTRAINT "PayrollIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollIdentity" ADD CONSTRAINT "PayrollIdentity_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
