-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "parcelBoundary" JSONB,
ADD COLUMN     "parcelData" JSONB,
ADD COLUMN     "parcelFetchedAt" TIMESTAMP(3),
ADD COLUMN     "parcelImageAt" TIMESTAMP(3),
ADD COLUMN     "parcelImageKey" TEXT,
ADD COLUMN     "parcelLookupError" TEXT;
