-- B-621: password sign-ups kept their login username on "AccountCredential" only
-- (B-528); the public profile handle ("Account"."username") stayed NULL, so those
-- accounts were invisible to /v1/user/search and to friend / share lookups.
-- Seed the handle from the login username wherever it is still free.
UPDATE "Account" a
SET "username" = c."username"
FROM "AccountCredential" c
WHERE c."accountId" = a."id"
  AND a."username" IS NULL
  AND c."username" ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  AND NOT EXISTS (SELECT 1 FROM "Account" x WHERE lower(x."username") = lower(c."username"));
