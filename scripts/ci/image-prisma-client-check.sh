# Runs INSIDE a server image (POSIX sh, fed on stdin):
#   docker run --rm -i --entrypoint sh -w /repo/packages/happy-server "$IMAGE" -s < scripts/ci/image-prisma-client-check.sh
# The packaged schema must equal the schema of the Prisma Client the server
# resolves at runtime. Resolve it the way the server does instead of assuming
# a hoisted /repo/node_modules/.prisma: since B-820 the image installs with the
# isolated linker and the client lives under node_modules/.pnpm (the hard-coded
# path failed the Release13 preflight). Works for hoisted (older) images too,
# so rollbacks pass the same check. CI smoke runs this exact file.
set -eu
cd /repo/packages/happy-server
client=$(node -p "require('path').dirname(require.resolve('.prisma/client/default', { paths: [require('path').dirname(require.resolve('@prisma/client/package.json'))] }))")
package_schema=$(sha256sum prisma/schema.prisma | cut -d " " -f 1)
client_schema=$(sha256sum "$client/schema.prisma" | cut -d " " -f 1)
echo "prisma client: $client"
test -n "$package_schema" && test "$package_schema" = "$client_schema"
