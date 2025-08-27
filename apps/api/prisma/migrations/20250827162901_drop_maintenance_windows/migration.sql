/*
  Warnings:

  - You are about to drop the `MaintenanceWindow` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "MaintenanceWindow" DROP CONSTRAINT "MaintenanceWindow_equipmentId_fkey";

-- DropTable
DROP TABLE "MaintenanceWindow";
