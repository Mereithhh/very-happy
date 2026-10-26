/**
 * Entry file name of a release build.
 *
 * The release pipeline identifies a build by its entry script ending in
 * `-<VH_VERSION>.js` (the commit SHA in production): server
 * releaseCoordinator.releaseWebAsset (candidate readiness),
 * deploy-blue-green-remote.sh wait_ready / verify_direct_asset, and the live
 * SHA read by scripts/changelog/check-release.mjs and check-shipped. B-823
 * moved chunks and assets to a content hash only, so release-stable chunks
 * keep their URLs; the entry changes every release anyway and keeps the
 * version (Release14: an entry without it never became ready).
 */
export function releaseEntryFileNames(version: string): string {
    return `assets/[name]-[hash]-${version.replace(/\W/g, '')}.js`;
}
