// web shim for expo-localization, backed by the browser's navigator languages.
interface Locale {
  languageCode: string | null;
  languageTag: string;
  languageScriptCode: string | null;
  regionCode: string | null;
  textDirection: 'ltr' | 'rtl';
}

// Derive a script code (Hans/Hant) the way expo does, since browsers usually give
// region tags (zh-CN, zh-TW) rather than script tags (zh-Hans).
function scriptFor(tag: string, lang: string, region: string | undefined): string | null {
  if (/Hans/i.test(tag)) return 'Hans';
  if (/Hant/i.test(tag)) return 'Hant';
  if (lang === 'zh') {
    if (region && ['TW', 'HK', 'MO'].includes(region.toUpperCase())) return 'Hant';
    return 'Hans';
  }
  return null;
}

export function getLocales(): Locale[] {
  const tags =
    typeof navigator !== 'undefined'
      ? navigator.languages ?? [navigator.language]
      : ['en-US'];
  return tags.map((tag) => {
    const parts = tag.split('-');
    const lang = parts[0];
    const region = parts.find((p) => /^[A-Z]{2}$/.test(p));
    return {
      languageCode: lang ?? null,
      languageTag: tag,
      languageScriptCode: scriptFor(tag, lang, region),
      regionCode: region ?? null,
      textDirection: 'ltr',
    };
  });
}

export function getCalendars() {
  return [
    {
      calendar: 'gregory',
      timeZone:
        typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
      uses24hourClock: null,
      firstWeekday: null,
    },
  ];
}
