-- Add PROMOTION_HMAC_ROTATED to the AuditVerb enum for the new
-- Super-only rotate-secret button on the Promotions tab. Metadata on
-- the audit row carries { previousSecretPreviewHash, rotatedAt }.

ALTER TYPE "AuditVerb" ADD VALUE IF NOT EXISTS 'PROMOTION_HMAC_ROTATED';
