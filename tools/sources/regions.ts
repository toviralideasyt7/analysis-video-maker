/**
 * Country lookup: ISO3 -> ISO2 flag key + World Bank region, used to colour and
 * group entities in a race video without any AI round-trip.
 *
 * Generated from the World Bank country API
 * (https://api.worldbank.org/v2/country?format=json&per_page=400) with
 * aggregate rows removed. Row separator is "|" and fields are separated by ":"
 * because some region names contain commas.
 */

export interface CountryInfo {
  iso3: string;
  iso2: string;
  region: string;
}

const TABLE =
  'ABW:aw:Latin America & Caribbean|AFG:af:Middle East, North Africa, Afghanistan & Pakistan|AGO:ao:Sub-Saharan Africa|ALB:al:Europe & Central Asia|AND:ad:Europe & Central Asia|ARE:ae:Middle East, North Africa, Afghanistan & Pakistan|ARG:ar:Latin America & Caribbean|ARM:am:Europe & Central Asia|ASM:as:East Asia & Pacific|ATG:ag:Latin America & Caribbean|AUS:au:East Asia & Pacific|AUT:at:Europe & Central Asia|AZE:az:Europe & Central Asia|BDI:bi:Sub-Saharan Africa|BEL:be:Europe & Central Asia|BEN:bj:Sub-Saharan Africa|BFA:bf:Sub-Saharan Africa|BGD:bd:South Asia|BGR:bg:Europe & Central Asia|BHR:bh:Middle East, North Africa, Afghanistan & Pakistan|BHS:bs:Latin America & Caribbean|BIH:ba:Europe & Central Asia|BLR:by:Europe & Central Asia|BLZ:bz:Latin America & Caribbean|BMU:bm:North America|BOL:bo:Latin America & Caribbean|BRA:br:Latin America & Caribbean|BRB:bb:Latin America & Caribbean|BRN:bn:East Asia & Pacific|BTN:bt:South Asia|BWA:bw:Sub-Saharan Africa|CAF:cf:Sub-Saharan Africa|CAN:ca:North America|CHE:ch:Europe & Central Asia|CHI:jg:Europe & Central Asia|CHL:cl:Latin America & Caribbean|CHN:cn:East Asia & Pacific|CIV:ci:Sub-Saharan Africa|CMR:cm:Sub-Saharan Africa|COD:cd:Sub-Saharan Africa|COG:cg:Sub-Saharan Africa|COL:co:Latin America & Caribbean|COM:km:Sub-Saharan Africa|CPV:cv:Sub-Saharan Africa|CRI:cr:Latin America & Caribbean|CUB:cu:Latin America & Caribbean|CUW:cw:Latin America & Caribbean|CYM:ky:Latin America & Caribbean|CYP:cy:Europe & Central Asia|CZE:cz:Europe & Central Asia|DEU:de:Europe & Central Asia|DJI:dj:Middle East, North Africa, Afghanistan & Pakistan|DMA:dm:Latin America & Caribbean|DNK:dk:Europe & Central Asia|DOM:do:Latin America & Caribbean|DZA:dz:Middle East, North Africa, Afghanistan & Pakistan|ECU:ec:Latin America & Caribbean|EGY:eg:Middle East, North Africa, Afghanistan & Pakistan|ERI:er:Sub-Saharan Africa|ESP:es:Europe & Central Asia|EST:ee:Europe & Central Asia|ETH:et:Sub-Saharan Africa|FIN:fi:Europe & Central Asia|FJI:fj:East Asia & Pacific|FRA:fr:Europe & Central Asia|FRO:fo:Europe & Central Asia|FSM:fm:East Asia & Pacific|GAB:ga:Sub-Saharan Africa|GBR:gb:Europe & Central Asia|GEO:ge:Europe & Central Asia|GHA:gh:Sub-Saharan Africa|GIB:gi:Europe & Central Asia|GIN:gn:Sub-Saharan Africa|GMB:gm:Sub-Saharan Africa|GNB:gw:Sub-Saharan Africa|GNQ:gq:Sub-Saharan Africa|GRC:gr:Europe & Central Asia|GRD:gd:Latin America & Caribbean|GRL:gl:Europe & Central Asia|GTM:gt:Latin America & Caribbean|GUM:gu:East Asia & Pacific|GUY:gy:Latin America & Caribbean|HKG:hk:East Asia & Pacific|HND:hn:Latin America & Caribbean|HRV:hr:Europe & Central Asia|HTI:ht:Latin America & Caribbean|HUN:hu:Europe & Central Asia|IDN:id:East Asia & Pacific|IMN:im:Europe & Central Asia|IND:in:South Asia|IRL:ie:Europe & Central Asia|IRN:ir:Middle East, North Africa, Afghanistan & Pakistan|IRQ:iq:Middle East, North Africa, Afghanistan & Pakistan|ISL:is:Europe & Central Asia|ISR:il:Middle East, North Africa, Afghanistan & Pakistan|ITA:it:Europe & Central Asia|JAM:jm:Latin America & Caribbean|JOR:jo:Middle East, North Africa, Afghanistan & Pakistan|JPN:jp:East Asia & Pacific|KAZ:kz:Europe & Central Asia|KEN:ke:Sub-Saharan Africa|KGZ:kg:Europe & Central Asia|KHM:kh:East Asia & Pacific|KIR:ki:East Asia & Pacific|KNA:kn:Latin America & Caribbean|KOR:kr:East Asia & Pacific|KWT:kw:Middle East, North Africa, Afghanistan & Pakistan|LAO:la:East Asia & Pacific|LBN:lb:Middle East, North Africa, Afghanistan & Pakistan|LBR:lr:Sub-Saharan Africa|LBY:ly:Middle East, North Africa, Afghanistan & Pakistan|LCA:lc:Latin America & Caribbean|LIE:li:Europe & Central Asia|LKA:lk:South Asia|LSO:ls:Sub-Saharan Africa|LTU:lt:Europe & Central Asia|LUX:lu:Europe & Central Asia|LVA:lv:Europe & Central Asia|MAC:mo:East Asia & Pacific|MAF:mf:Latin America & Caribbean|MAR:ma:Middle East, North Africa, Afghanistan & Pakistan|MCO:mc:Europe & Central Asia|MDA:md:Europe & Central Asia|MDG:mg:Sub-Saharan Africa|MDV:mv:South Asia|MEX:mx:Latin America & Caribbean|MHL:mh:East Asia & Pacific|MKD:mk:Europe & Central Asia|MLI:ml:Sub-Saharan Africa|MLT:mt:Middle East, North Africa, Afghanistan & Pakistan|MMR:mm:East Asia & Pacific|MNE:me:Europe & Central Asia|MNG:mn:East Asia & Pacific|MNP:mp:East Asia & Pacific|MOZ:mz:Sub-Saharan Africa|MRT:mr:Sub-Saharan Africa|MUS:mu:Sub-Saharan Africa|MWI:mw:Sub-Saharan Africa|MYS:my:East Asia & Pacific|NAM:na:Sub-Saharan Africa|NCL:nc:East Asia & Pacific|NER:ne:Sub-Saharan Africa|NGA:ng:Sub-Saharan Africa|NIC:ni:Latin America & Caribbean|NLD:nl:Europe & Central Asia|NOR:no:Europe & Central Asia|NPL:np:South Asia|NRU:nr:East Asia & Pacific|NZL:nz:East Asia & Pacific|OMN:om:Middle East, North Africa, Afghanistan & Pakistan|PAK:pk:Middle East, North Africa, Afghanistan & Pakistan|PAN:pa:Latin America & Caribbean|PER:pe:Latin America & Caribbean|PHL:ph:East Asia & Pacific|PLW:pw:East Asia & Pacific|PNG:pg:East Asia & Pacific|POL:pl:Europe & Central Asia|PRI:pr:Latin America & Caribbean|PRK:kp:East Asia & Pacific|PRT:pt:Europe & Central Asia|PRY:py:Latin America & Caribbean|PSE:ps:Middle East, North Africa, Afghanistan & Pakistan|PYF:pf:East Asia & Pacific|QAT:qa:Middle East, North Africa, Afghanistan & Pakistan|ROU:ro:Europe & Central Asia|RUS:ru:Europe & Central Asia|RWA:rw:Sub-Saharan Africa|SAU:sa:Middle East, North Africa, Afghanistan & Pakistan|SDN:sd:Sub-Saharan Africa|SEN:sn:Sub-Saharan Africa|SGP:sg:East Asia & Pacific|SLB:sb:East Asia & Pacific|SLE:sl:Sub-Saharan Africa|SLV:sv:Latin America & Caribbean|SMR:sm:Europe & Central Asia|SOM:so:Sub-Saharan Africa|SRB:rs:Europe & Central Asia|SSD:ss:Sub-Saharan Africa|STP:st:Sub-Saharan Africa|SUR:sr:Latin America & Caribbean|SVK:sk:Europe & Central Asia|SVN:si:Europe & Central Asia|SWE:se:Europe & Central Asia|SWZ:sz:Sub-Saharan Africa|SXM:sx:Latin America & Caribbean|SYC:sc:Sub-Saharan Africa|SYR:sy:Middle East, North Africa, Afghanistan & Pakistan|TCA:tc:Latin America & Caribbean|TCD:td:Sub-Saharan Africa|TGO:tg:Sub-Saharan Africa|THA:th:East Asia & Pacific|TJK:tj:Europe & Central Asia|TKM:tm:Europe & Central Asia|TLS:tl:East Asia & Pacific|TON:to:East Asia & Pacific|TTO:tt:Latin America & Caribbean|TUN:tn:Middle East, North Africa, Afghanistan & Pakistan|TUR:tr:Europe & Central Asia|TUV:tv:East Asia & Pacific|TZA:tz:Sub-Saharan Africa|UGA:ug:Sub-Saharan Africa|UKR:ua:Europe & Central Asia|URY:uy:Latin America & Caribbean|USA:us:North America|UZB:uz:Europe & Central Asia|VCT:vc:Latin America & Caribbean|VEN:ve:Latin America & Caribbean|VGB:vg:Latin America & Caribbean|VIR:vi:Latin America & Caribbean|VNM:vn:East Asia & Pacific|VUT:vu:East Asia & Pacific|WSM:ws:East Asia & Pacific|XKX:xk:Europe & Central Asia|YEM:ye:Middle East, North Africa, Afghanistan & Pakistan|ZAF:za:Sub-Saharan Africa|ZMB:zm:Sub-Saharan Africa|ZWE:zw:Sub-Saharan Africa';

const BY_ISO3 = new Map<string, CountryInfo>();
for (const entry of TABLE.split('|')) {
  const [iso3, iso2, ...rest] = entry.split(':');
  if (!iso3 || !iso2) continue;
  BY_ISO3.set(iso3.toUpperCase(), { iso3: iso3.toUpperCase(), iso2, region: rest.join(':') });
}

/** Look up a country by ISO3 (case-insensitive). */
export function countryInfo(iso3: string | undefined): CountryInfo | undefined {
  if (!iso3) return undefined;
  return BY_ISO3.get(iso3.trim().toUpperCase());
}

/** ISO2 flag key for an ISO3 code, or undefined when unknown (aggregates). */
export function iso2Of(iso3: string | undefined): string | undefined {
  return countryInfo(iso3)?.iso2;
}

/** World Bank region for an ISO3 code, used as the default group. */
export function regionOf(iso3: string | undefined): string | undefined {
  return countryInfo(iso3)?.region;
}

/** True when the code is a real country in the lookup table. */
export function isCountry(iso3: string | undefined): boolean {
  return Boolean(countryInfo(iso3));
}

export function allCountries(): CountryInfo[] {
  return Array.from(BY_ISO3.values());
}