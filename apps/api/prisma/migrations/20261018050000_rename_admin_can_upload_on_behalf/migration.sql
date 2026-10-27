-- Rename PolicyDocument.adminCanUploadOnBehalf -> allowUploadOnBehalf.
--
-- The column says whether a policy PERMITS a signature to be uploaded on
-- somebody else's behalf. Performing that upload needs `compliance.manage`;
-- the column never named who, only whether. The old name read as though a
-- role owned the decision.
--
-- Hand-written as a RENAME: prisma would emit DROP + ADD and reset every
-- policy's flag to the default.
ALTER TABLE "PolicyDocument" RENAME COLUMN "adminCanUploadOnBehalf" TO "allowUploadOnBehalf";
