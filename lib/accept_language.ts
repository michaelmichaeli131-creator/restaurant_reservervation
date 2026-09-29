/** Select a supported browser locale by quality, preserving header order for ties. */
export function preferredLanguage(header: string | null): 'en' | 'he' | 'ka' | undefined {
  let best: 'en' | 'he' | 'ka' | undefined;
  let bestQuality = 0;
  for (const entry of (header || '').split(',')) {
    const [tag, ...params] = entry.trim().toLowerCase().split(';');
    const locale = tag.split('-')[0];
    if (locale !== 'en' && locale !== 'he' && locale !== 'ka') continue;
    const qualityParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
    if (qualityParam !== undefined && !/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qualityParam)) continue;
    const quality = qualityParam === undefined ? 1 : Number(qualityParam.slice(2));
    if (quality > bestQuality) { best = locale; bestQuality = quality; }
  }
  return best;
}
