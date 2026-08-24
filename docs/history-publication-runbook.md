# Git history publication runbook

> Status: mandatory Owner action before changing repository visibility. Do not
> run this against the shared repository while development is active.

The committed `HEAD` snapshot was exported with `git archive` and scanned with
Gitleaks 8.30.1 on 2026-08-25: **0 findings**. The complete Git history is not
safe to publish: the same redacted scan found 45 findings across 2,862 commits.
The highest-confidence incident is a 3.2 MB real Claude session dump containing
PII, environment material, JWT-shaped values, and API-key-shaped values. Old
Firebase/Google service configuration also contains GCP API keys.

This is a publication blocker even though none of these files exists in the
current product tree. Deleting a file in a later commit does not remove its old
blob from a public clone.

## Confirmed purge set

Remove these paths from every ref in the publication copy:

```text
expo-app/google-services.json
google-services.json
android/app/google-services.json
cli/explore-claude-cli/v1-real-sessions-by-kirill-from-handy-cli/example-sessions/400429ba-c1e1-4ef5-a7ec-fe40608df53b.jsonl
sources/sync/__testdata__/log_0.json
expo-app/ios/Podfile.lock
ios/Podfile.lock
cli/src/utils/deriveKey.appspec.ts
sources/encryption/deriveKey.appspec.ts
cli/src/utils/expandEnvVars.test.ts
cli/src/commands/connect/authenticateGemini.ts
cli/notes/message-type-drift.md
docs/configuration.md
```

`docs/configuration.md` is clean and present at current `HEAD`; preserve a copy
before filtering and restore that clean copy as a new commit afterward. The
other listed paths are absent from current `HEAD`. Removing the lower-confidence
fixture/code paths as well keeps the publication gate unambiguous instead of
shipping scanner exceptions that future maintainers cannot independently
verify.

## Owner-only irreversible sequence

1. Keep the repository private. Freeze merges, tags, releases, and daemon/Web
   deployments. Ask every collaborator to push or archive unshared work.
2. Inventory the providers represented in the real session dump. Revoke or
   rotate every API token, refresh token, session token, webhook secret, and JWT
   signing/session credential that could have been captured. Treat expired JWTs
   as compromised evidence, not as proof that adjacent refresh credentials are
   safe. In Google Cloud/Firebase, rotate where supported and apply explicit API,
   app, referrer/package, and quota restrictions to replacement client keys.
3. Export a repository backup and current clean documentation outside the
   rewrite clone:

   ```sh
   git clone --mirror git@github.com:OWNER/very-happy.git very-happy-before-public.git
   git -C very-happy-before-public.git bundle create ../very-happy-before-public.bundle --all
   git show main:docs/configuration.md > ../configuration.clean.md
   ```

4. Make a second, disposable mirror and run `git filter-repo` there. Review the
   purge list before executing; this intentionally changes every affected
   commit SHA:

   ```sh
   git clone --mirror git@github.com:OWNER/very-happy.git very-happy-publication.git
   cd very-happy-publication.git
   git filter-repo --force --invert-paths \
     --path expo-app/google-services.json \
     --path google-services.json \
     --path android/app/google-services.json \
     --path cli/explore-claude-cli/v1-real-sessions-by-kirill-from-handy-cli/example-sessions/400429ba-c1e1-4ef5-a7ec-fe40608df53b.jsonl \
     --path sources/sync/__testdata__/log_0.json \
     --path expo-app/ios/Podfile.lock \
     --path ios/Podfile.lock \
     --path cli/src/utils/deriveKey.appspec.ts \
     --path sources/encryption/deriveKey.appspec.ts \
     --path cli/src/utils/expandEnvVars.test.ts \
     --path cli/src/commands/connect/authenticateGemini.ts \
     --path cli/notes/message-type-drift.md \
     --path docs/configuration.md
   ```

5. Clone the rewritten mirror into a normal worktree, restore only the reviewed
   clean configuration document, and commit it. Do not copy any other file from
   the pre-rewrite backup.
6. Run both gates from the rewritten normal clone:

   ```sh
   bash scripts/ci/scan-secrets.sh --history
   publication_snapshot="$(mktemp -d)"
   git archive HEAD | tar -x -C "$publication_snapshot"
   gitleaks dir "$publication_snapshot" --redact=100 --no-banner --no-color
   ```

   The full-history scan must report zero unreviewed findings. Also search the
   rewritten object database for the UUID-named session path, all three
   `google-services.json` paths, personal email addresses, `/Users/` home paths,
   and known provider token prefixes. Never paste matching secret text into an
   issue, CI log, or readiness report.
7. From a clean clone of the rewritten refs, run the complete Wire, Server, Web,
   CLI, container, browser, and isolated-HOME gates recorded in
   `OPEN_SOURCE_READINESS.md`. Compare the rewritten tree hash with the approved
   pre-rewrite `HEAD` plus the single restored documentation commit.
8. Schedule a collaborator cutover. Force-push rewritten branches and tags only
   after Owner confirmation, invalidate old clones, close/recreate open PRs,
   and require every collaborator to re-clone. This repository's agents are not
   authorized to perform that force-push.
9. Re-run the full-history scan from a fresh GitHub clone, verify GitHub Actions
   uses only hosted runners for fork PRs, then perform the repository visibility
   change as the final action. Visibility change is also Owner-only.

## Abort and recovery

If the rewritten tree differs unexpectedly, any required ref is missing, a
secret scan still finds material, or a replacement credential has not been
verified in production, do not publish and do not push the rewritten mirror.
Delete only the disposable publication clone and restart from the immutable
bundle. The bundle itself contains the sensitive history: encrypt it at rest,
limit access, and retain/delete it according to the Owner's incident policy.
