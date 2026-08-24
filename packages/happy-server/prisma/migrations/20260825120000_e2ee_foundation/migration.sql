BEGIN;

ALTER TABLE "Account" ALTER COLUMN "publicKey" DROP NOT NULL;
ALTER TABLE "AccountCredential" ALTER COLUMN "secretEnc" DROP NOT NULL;

ALTER TABLE "Account"
    ADD COLUMN "cryptoMode" TEXT NOT NULL DEFAULT 'trusted-v1',
    ADD COLUMN "cryptoEpoch" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cryptoWriteState" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN "e2eeOrigin" TEXT,
    ADD COLUMN "recoveryAuthorityPublicKey" TEXT,
    ADD COLUMN "e2eeContentPublicKey" TEXT,
    ADD COLUMN "e2eeContentKeySignature" TEXT,
    ADD COLUMN "recoveryCiphertext" TEXT;

CREATE UNIQUE INDEX "Account_recoveryAuthorityPublicKey_key"
    ON "Account"("recoveryAuthorityPublicKey");

ALTER TABLE "Account" ADD CONSTRAINT "Account_crypto_mode_check" CHECK (
    ("cryptoMode" = 'trusted-v1'
        AND "cryptoEpoch" = 0
        AND "e2eeOrigin" IS NULL
        AND "recoveryAuthorityPublicKey" IS NULL
        AND "e2eeContentPublicKey" IS NULL
        AND "e2eeContentKeySignature" IS NULL
        AND "recoveryCiphertext" IS NULL)
    OR ("cryptoMode" = 'e2ee-migrating' AND "cryptoEpoch" >= 0)
    OR ("cryptoMode" = 'e2ee-v1'
        AND "cryptoEpoch" >= 1
        AND "publicKey" IS NULL
        AND "e2eeOrigin" IS NOT NULL
        AND "recoveryAuthorityPublicKey" IS NOT NULL
        AND "e2eeContentPublicKey" IS NOT NULL
        AND "e2eeContentKeySignature" IS NOT NULL
        AND "recoveryCiphertext" IS NOT NULL)
);
ALTER TABLE "Account" ADD CONSTRAINT "Account_crypto_write_state_check"
    CHECK ("cryptoWriteState" IN ('active', 'rekey-required'));

CREATE TABLE "CryptoDevice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "encryptionPublicKey" TEXT NOT NULL,
    "signingPublicKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "keyEpoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CryptoDevice_pkey" PRIMARY KEY ("accountId", "id"),
    CONSTRAINT "CryptoDevice_type_check" CHECK ("type" IN ('web', 'daemon', 'cli')),
    CONSTRAINT "CryptoDevice_status_check" CHECK ("status" IN ('pending', 'active', 'revoked')),
    CONSTRAINT "CryptoDevice_epoch_check" CHECK ("keyEpoch" >= 0),
    CONSTRAINT "CryptoDevice_revocation_check" CHECK (
        ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
        OR ("status" <> 'revoked' AND "revokedAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "CryptoDevice_id_key" ON "CryptoDevice"("id");
CREATE INDEX "CryptoDevice_accountId_status_idx" ON "CryptoDevice"("accountId", "status");

CREATE TABLE "ControlDeviceRootEnvelope" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyEpoch" INTEGER NOT NULL,
    "suite" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "authorizerKind" TEXT NOT NULL,
    "authorizerDeviceId" TEXT,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ControlDeviceRootEnvelope_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ControlDeviceRootEnvelope_suite_check" CHECK ("suite" = 'vh-e2ee-1'),
    CONSTRAINT "ControlDeviceRootEnvelope_epoch_check" CHECK ("keyEpoch" >= 1),
    CONSTRAINT "ControlDeviceRootEnvelope_authorizer_check" CHECK (
        ("authorizerKind" = 'recovery' AND "authorizerDeviceId" IS NULL)
        OR ("authorizerKind" = 'device' AND "authorizerDeviceId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ControlDeviceRootEnvelope_accountId_deviceId_keyEpoch_key"
    ON "ControlDeviceRootEnvelope"("accountId", "deviceId", "keyEpoch");
CREATE INDEX "ControlDeviceRootEnvelope_accountId_keyEpoch_idx"
    ON "ControlDeviceRootEnvelope"("accountId", "keyEpoch");

CREATE TABLE "E2eeSignupReservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2eeSignupReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "E2eeSignupReservation_accountId_key"
    ON "E2eeSignupReservation"("accountId");
CREATE UNIQUE INDEX "E2eeSignupReservation_nonceHash_key"
    ON "E2eeSignupReservation"("nonceHash");
CREATE INDEX "E2eeSignupReservation_expiresAt_idx"
    ON "E2eeSignupReservation"("expiresAt");

ALTER TABLE "AccountLoginSession"
    ADD COLUMN "deviceId" TEXT,
    ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "e2eeProtocol" TEXT;

ALTER TABLE "AccountLoginSession" ADD CONSTRAINT "AccountLoginSession_device_protocol_check" CHECK (
    ("deviceId" IS NULL AND cardinality("capabilities") = 0 AND "e2eeProtocol" IS NULL)
    OR ("deviceId" IS NOT NULL AND cardinality("capabilities") > 0 AND "e2eeProtocol" = 'vh-e2ee-1')
);

ALTER TABLE "CryptoDevice" ADD CONSTRAINT "CryptoDevice_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlDeviceRootEnvelope" ADD CONSTRAINT "ControlDeviceRootEnvelope_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlDeviceRootEnvelope" ADD CONSTRAINT "ControlDeviceRootEnvelope_recipient_fkey"
    FOREIGN KEY ("accountId", "deviceId") REFERENCES "CryptoDevice"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlDeviceRootEnvelope" ADD CONSTRAINT "ControlDeviceRootEnvelope_authorizer_fkey"
    FOREIGN KEY ("accountId", "authorizerDeviceId") REFERENCES "CryptoDevice"("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLoginSession" ADD CONSTRAINT "AccountLoginSession_device_fkey"
    FOREIGN KEY ("accountId", "deviceId") REFERENCES "CryptoDevice"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION validate_control_device_root_envelope() RETURNS trigger AS $$
DECLARE
    recipient_type text;
    authorizer_type text;
    authorizer_status text;
BEGIN
    SELECT "type" INTO recipient_type FROM "CryptoDevice"
    WHERE "accountId" = NEW."accountId" AND "id" = NEW."deviceId";
    IF recipient_type IS DISTINCT FROM 'web' THEN
        RAISE EXCEPTION 'control_root_envelope_recipient_must_be_web';
    END IF;
    IF NEW."authorizerKind" = 'device' THEN
        SELECT "type", "status" INTO authorizer_type, authorizer_status FROM "CryptoDevice"
        WHERE "accountId" = NEW."accountId" AND "id" = NEW."authorizerDeviceId";
        IF authorizer_type IS DISTINCT FROM 'web' OR authorizer_status IS DISTINCT FROM 'active' THEN
            RAISE EXCEPTION 'control_root_envelope_authorizer_must_be_active_web';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_control_device_root_envelope_write
BEFORE INSERT OR UPDATE ON "ControlDeviceRootEnvelope"
FOR EACH ROW EXECUTE FUNCTION validate_control_device_root_envelope();

CREATE FUNCTION reject_e2ee_account_escrow() RETURNS trigger AS $$
DECLARE
    account_mode text;
BEGIN
    -- Serialize against Account.cryptoMode activation. Without this row lock,
    -- an escrow INSERT and the mode UPDATE could each validate an old snapshot
    -- and both commit, violating the invariant despite both triggers.
    SELECT "cryptoMode" INTO account_mode FROM "Account"
    WHERE "id" = NEW."accountId" FOR UPDATE;
    IF account_mode = 'e2ee-v1' THEN
        RAISE EXCEPTION 'e2ee_account_escrow_forbidden';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_e2ee_account_secret
BEFORE INSERT OR UPDATE ON "AccountSecret"
FOR EACH ROW EXECUTE FUNCTION reject_e2ee_account_escrow();

CREATE FUNCTION reject_e2ee_credential_secret() RETURNS trigger AS $$
DECLARE
    account_mode text;
BEGIN
    SELECT "cryptoMode" INTO account_mode FROM "Account"
    WHERE "id" = NEW."accountId" FOR UPDATE;
    IF account_mode = 'e2ee-v1' AND NEW."secretEnc" IS NOT NULL THEN
        RAISE EXCEPTION 'e2ee_credential_escrow_forbidden';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_e2ee_credential_escrow
BEFORE INSERT OR UPDATE OF "secretEnc", "accountId" ON "AccountCredential"
FOR EACH ROW EXECUTE FUNCTION reject_e2ee_credential_secret();

-- The table-specific write triggers above stop escrow from being recreated
-- after activation.  This account-side trigger closes the inverse path: an
-- existing trusted account cannot be labelled E2EE while either legacy secret
-- source still exists.  Keeping this invariant in PostgreSQL means a future
-- migration/script cannot accidentally bypass an application-only check.
CREATE FUNCTION reject_e2ee_mode_with_escrow() RETURNS trigger AS $$
BEGIN
    IF NEW."cryptoMode" = 'e2ee-v1' AND OLD."cryptoMode" IS DISTINCT FROM 'e2ee-v1' THEN
        IF EXISTS (
            SELECT 1 FROM "AccountSecret" WHERE "accountId" = NEW."id"
        ) OR EXISTS (
            SELECT 1 FROM "AccountCredential"
            WHERE "accountId" = NEW."id" AND "secretEnc" IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'e2ee_activation_requires_escrow_removal';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_e2ee_mode_activation_with_escrow
BEFORE UPDATE OF "cryptoMode" ON "Account"
FOR EACH ROW EXECUTE FUNCTION reject_e2ee_mode_with_escrow();

COMMIT;
