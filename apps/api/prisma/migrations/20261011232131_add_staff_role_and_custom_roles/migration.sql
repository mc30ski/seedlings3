-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'ROLE';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'STAFF';

-- CreateTable
CREATE TABLE "CustomRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleEntitlement" (
    "id" TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "entitlement" TEXT NOT NULL,

    CONSTRAINT "RoleEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCustomRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "UserCustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_name_key" ON "CustomRole"("name");

-- CreateIndex
CREATE INDEX "CustomRole_suspendedAt_idx" ON "CustomRole"("suspendedAt");

-- CreateIndex
CREATE INDEX "RoleEntitlement_entitlement_idx" ON "RoleEntitlement"("entitlement");

-- CreateIndex
CREATE UNIQUE INDEX "RoleEntitlement_customRoleId_entitlement_key" ON "RoleEntitlement"("customRoleId", "entitlement");

-- CreateIndex
CREATE INDEX "UserCustomRole_userId_idx" ON "UserCustomRole"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCustomRole_userId_customRoleId_key" ON "UserCustomRole"("userId", "customRoleId");

-- AddForeignKey
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleEntitlement" ADD CONSTRAINT "RoleEntitlement_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCustomRole" ADD CONSTRAINT "UserCustomRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCustomRole" ADD CONSTRAINT "UserCustomRole_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCustomRole" ADD CONSTRAINT "UserCustomRole_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

