/*
  Warnings:

  - You are about to drop the column `label` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `lat` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `line1` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `line2` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `lng` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `photos` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `siteBoundaryGeo` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `siteName` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `unitCount` on the `Property` table. All the data in the column will be lost.
  - You are about to drop the column `unitLabel` on the `Property` table. All the data in the column will be lost.
  - Added the required column `street1` to the `Property` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Property" DROP COLUMN "label",
DROP COLUMN "lat",
DROP COLUMN "line1",
DROP COLUMN "line2",
DROP COLUMN "lng",
DROP COLUMN "photos",
DROP COLUMN "siteBoundaryGeo",
DROP COLUMN "siteName",
DROP COLUMN "unitCount",
DROP COLUMN "unitLabel",
ADD COLUMN     "street1" TEXT NOT NULL,
ADD COLUMN     "street2" TEXT;
