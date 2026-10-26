/**
 * Asset discovery of check-shipped.mjs, kept pure so it can be tested.
 *
 * Only the entry carries the release SHA (`index-<hash>-<sha>.js`,
 * web-v2 build/releaseEntry.ts); since B-823 every other chunk and stylesheet
 * is `<name>-<content hash>.<ext>`. The live SHA comes from the entry; the
 * walk must accept any asset name (Release14: requiring `-<sha>` on chunks
 * read the entry alone and reported every other needle MISSING).
 */

/** `assets/index-<hash>-<sha>.js` of the served index.html, or null. */
export function liveEntry(indexHtml) {
    const entry = (indexHtml.match(/assets\/index-[A-Za-z0-9_-]+-[0-9a-f]{40}\.js/) ?? [])[0];
    return entry ? { entry, sha: entry.match(/[0-9a-f]{40}(?=\.js$)/)[0] } : null;
}

/** Stylesheets the document links (CSS is not referenced from JS in this build). */
export function linkedStylesheets(indexHtml) {
    return [...new Set(Array.from(indexHtml.matchAll(/assets\/[A-Za-z0-9_-]+\.css/g), (m) => m[0]))];
}

/** Every asset a JS chunk references, for the transitive walk. */
export function referencedAssets(chunkBody) {
    return [...new Set(Array.from(chunkBody.matchAll(/assets\/[A-Za-z0-9_-]+\.(?:js|css)/g), (m) => m[0]))];
}
