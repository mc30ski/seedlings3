-- AlterTable
ALTER TABLE "User" ADD COLUMN     "guaranteedPayoutHistory" JSONB NOT NULL DEFAULT '[]';
