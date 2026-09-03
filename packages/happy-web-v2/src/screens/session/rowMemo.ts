/**
 * B-311: prop comparison for the transcript's row components.
 *
 * `buildChatRows` runs on every messages change and rebuilds its arrays, so a
 * plain `memo` would never hit on a row that takes a list. The ELEMENTS,
 * however, come from the reducer and are only rebuilt when that message
 * actually changed — so comparing element identity is both cheap and exact.
 */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
