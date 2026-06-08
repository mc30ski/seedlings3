-- Add EXPORT scope to AuditEvent for CSV download tracking.
-- Reuses the existing DOWNLOADED verb (also used by DOCUMENT scope).
ALTER TYPE "AuditScope" ADD VALUE 'EXPORT';
