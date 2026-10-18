-- B-620: generic OIDC login (authorization code + PKCE).
-- One pending authorization round trip per row; consumed (deleted) on callback.
CREATE TABLE "OidcLoginChallenge" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "codeVerifierEnc" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "inviteCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcLoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OidcLoginChallenge_stateHash_key" ON "OidcLoginChallenge"("stateHash");
CREATE INDEX "OidcLoginChallenge_expiresAt_idx" ON "OidcLoginChallenge"("expiresAt");

-- One-time handoff from the callback redirect to the Web client; the browser
-- only ever sees an opaque code, never the login token or account secret.
CREATE TABLE "OidcLoginHandoff" (
    "codeHash" TEXT NOT NULL,
    "payloadEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcLoginHandoff_pkey" PRIMARY KEY ("codeHash")
);

CREATE INDEX "OidcLoginHandoff_expiresAt_idx" ON "OidcLoginHandoff"("expiresAt");
