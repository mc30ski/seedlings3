-- AlterTable
ALTER TABLE "Checkout" ADD COLUMN     "rentalCost" DOUBLE PRECISION,
ADD COLUMN     "rentalDays" INTEGER;

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "dailyRate" DOUBLE PRECISION;
