/*
  Warnings:

  - Added the required column `displayName` to the `Property` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "displayName" TEXT NOT NULL;
