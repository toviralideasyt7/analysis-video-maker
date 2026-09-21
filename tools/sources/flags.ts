/**
 * Circular flag / logo assets.
 *
 * data-races.com renders every country flag from the public hatscripts
 * circle-flags set, so the highest-quality matching flag for our own videos is
 * the same source, fetched directly:
 *
 *   https://hatscripts.github.io/circle-flags/flags/<iso2>.svg
 *
 * Verified live 2026-09-21: SVG 200 for us / in / gb.
 *
 * Sources of a country key:
 *   - OWID grapher CSV  -> ISO3 in the `Code` column (e.g. IND)
 *   - World Bank API    -> ISO3 in `id` (e.g. IND)
 *   - data-races.com    -> lowercase ISO3 in the country path (e.g. /countries/ind/)
 * The static ISO3 -> ISO2 table below is generated from the World Bank country
 * API (https://api.worldbank.org/v2/country?format=json&per_page=400) with
 * aggregates removed, so no AI round-trip is needed to get a flag.
 */

import { fetchText, toDataUrl } from './http';

export const CIRCLE_FLAGS_BASE = 'https://hatscripts.github.io/circle-flags/flags';

/** Non-country keys accepted by the flag set. */
const SPECIAL: Record<string, string> = {
  world: 'un', un: 'un', eu: 'eu', eur: 'eu', oecd: 'xx', owid_wrl: 'un',
};

/** ISO3 -> ISO2, generated from the World Bank country API (aggregates removed). */
const ISO3_TO_ISO2: Record<string, string> = Object.fromEntries(
  'ABW:AW,AFG:AF,AGO:AO,ALB:AL,AND:AD,ARE:AE,ARG:AR,ARM:AM,ASM:AS,ATG:AG,AUS:AU,AUT:AT,AZE:AZ,BDI:BI,BEL:BE,BEN:BJ,BFA:BF,BGD:BD,BGR:BG,BHR:BH,BHS:BS,BIH:BA,BLR:BY,BLZ:BZ,BMU:BM,BOL:BO,BRA:BR,BRB:BB,BRN:BN,BTN:BT,BWA:BW,CAF:CF,CAN:CA,CHE:CH,CHI:JG,CHL:CL,CHN:CN,CIV:CI,CMR:CM,COD:CD,COG:CG,COL:CO,COM:KM,CPV:CV,CRI:CR,CUB:CU,CUW:CW,CYM:KY,CYP:CY,CZE:CZ,DEU:DE,DJI:DJ,DMA:DM,DNK:DK,DOM:DO,DZA:DZ,ECU:EC,EGY:EG,ERI:ER,ESP:ES,EST:EE,ETH:ET,FIN:FI,FJI:FJ,FRA:FR,FRO:FO,FSM:FM,GAB:GA,GBR:GB,GEO:GE,GHA:GH,GIB:GI,GIN:GN,GMB:GM,GNB:GW,GNQ:GQ,GRC:GR,GRD:GD,GRL:GL,GTM:GT,GUM:GU,GUY:GY,HKG:HK,HND:HN,HRV:HR,HTI:HT,HUN:HU,IDN:ID,IMN:IM,IND:IN,IRL:IE,IRN:IR,IRQ:IQ,ISL:IS,ISR:IL,ITA:IT,JAM:JM,JOR:JO,JPN:JP,KAZ:KZ,KEN:KE,KGZ:KG,KHM:KH,KIR:KI,KNA:KN,KOR:KR,KWT:KW,LAO:LA,LBN:LB,LBR:LR,LBY:LY,LCA:LC,LIE:LI,LKA:LK,LSO:LS,LTU:LT,LUX:LU,LVA:LV,MAC:MO,MAF:MF,MAR:MA,MCO:MC,MDA:MD,MDG:MG,MDV:MV,MEX:MX,MHL:MH,MKD:MK,MLI:ML,MLT:MT,MMR:MM,MNE:ME,MNG:MN,MNP:MP,MOZ:MZ,MRT:MR,MUS:MU,MWI:MW,MYS:MY,NAM:NA,NCL:NC,NER:NE,NGA:NG,NIC:NI,NLD:NL,NOR:NO,NPL:NP,NRU:NR,NZL:NZ,OMN:OM,PAK:PK,PAN:PA,PER:PE,PHL:PH,PLW:PW,PNG:PG,POL:PL,PRI:PR,PRK:KP,PRT:PT,PRY:PY,PSE:PS,PYF:PF,QAT:QA,ROU:RO,RUS:RU,RWA:RW,SAU:SA,SDN:SD,SEN:SN,SGP:SG,SLB:SB,SLE:SL,SLV:SV,SMR:SM,SOM:SO,SRB:RS,SSD:SS,STP:ST,SUR:SR,SVK:SK,SVN:SI,SWE:SE,SWZ:SZ,SXM:SX,SYC:SC,SYR:SY,TCA:TC,TCD:TD,TGO:TG,THA:TH,TJK:TJ,TKM:TM,TLS:TL,TON:TO,TTO:TT,TUN:TN,TUR:TR,TUV:TV,TZA:TZ,UGA:UG,UKR:UA,URY:UY,USA:US,UZB:UZ,VCT:VC,VEN:VE,VGB:VG,VIR:VI,VNM:VN,VUT:VU,WSM:WS,XKX:XK,YEM:YE,ZAF:ZA,ZMB:ZM,ZWE:ZW'.split(',').map((pair) => {
    const [iso3, iso2] = pair.split(':');
    return [iso3, iso2.toLowerCase()];
  }),
);

/** ISO3 (or anything close) -> ISO2 flag key, or undefined when unknown. */
export function toFlagCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const key = code.trim().toLowerCase();
  if (!key) return undefined;
  if (SPECIAL[key]) return SPECIAL[key];
  if (key.length === 2 && /^[a-z]{2}$/.test(key)) return key;
  const iso2 = ISO3_TO_ISO2[key.toUpperCase()];
  if (iso2) return iso2;
  return undefined;
}

export const circleFlagUrl = (code: string): string | undefined => {
  const iso2 = toFlagCode(code);
  return iso2 ? CIRCLE_FLAGS_BASE + '/' + iso2 + '.svg' : undefined;
};

/** Fetch the flag SVG markup (undefined when the country is unknown or missing). */
export async function fetchCircleFlagSvg(code: string): Promise<string | undefined> {
  const url = circleFlagUrl(code);
  if (!url) return undefined;
  try {
    return await fetchText(url, { tries: 2 });
  } catch {
    return undefined;
  }
}

/** Fetch a flag and inline it as a data URL for the video input. */
export async function circleFlagDataUrl(code: string): Promise<string | undefined> {
  const svg = await fetchCircleFlagSvg(code);
  return svg ? toDataUrl(svg, 'image/svg+xml') : undefined;
}
