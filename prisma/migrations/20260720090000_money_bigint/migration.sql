-- Widen large-aggregate money columns from INT4 to BIGINT so realistic UZS
-- credit limits and deal pipeline values (which exceed ~21.4M UZS) fit.
ALTER TABLE "Customer" ALTER COLUMN "creditLimitMinor" SET DATA TYPE BIGINT;
ALTER TABLE "Deal" ALTER COLUMN "amountMinor" SET DATA TYPE BIGINT;
