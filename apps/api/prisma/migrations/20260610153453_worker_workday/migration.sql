-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'WORKDAY';

-- CreateTable
CREATE TABLE "WorkerWorkday" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workdayDate" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerWorkday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerWorkday_userId_startedAt_idx" ON "WorkerWorkday"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkerWorkday_workdayDate_idx" ON "WorkerWorkday"("workdayDate");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerWorkday_userId_workdayDate_key" ON "WorkerWorkday"("userId", "workdayDate");

-- AddForeignKey
ALTER TABLE "WorkerWorkday" ADD CONSTRAINT "WorkerWorkday_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerWorkday" ADD CONSTRAINT "WorkerWorkday_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
