#!/usr/bin/env node
// Derives two facets per demo into data/facets.json:
//   market   — the country or region the demo is built for
//   industry — a canonical industry, collapsing ~28 near-duplicate labels
//
// Both are inferred from the demo's own business summary, with an explicit
// override table for demos whose market is implied by the brand rather than
// stated in the text. Re-run after adding demos:
//   node scripts/derive-facets.mjs

import { readFile, writeFile } from 'node:fs/promises';

const GLOBAL = 'Global / generic';

// Markets that the business text names outright. Order matters: first hit wins,
// so more specific patterns come first.
const MARKET_PATTERNS = [
  [/\bcosta rica\b/i, 'Costa Rica'],
  [/\bnew zealand\b|\bone nz\b/i, 'New Zealand'],
  [/\bsaudi arabia\b|\bsaudi\b|\bkingdom business\b|\bksa\b/i, 'Saudi Arabia'],
  [/\bsouth africa\b/i, 'South Africa'],
  [/\bunited kingdom\b|\buk\b|\bbritish\b/i, 'United Kingdom'],
  [/\bspain\b|\bspanish\b|\bespa\u00f1a\b/i, 'Spain'],
  [/\bportugal\b|\bportuguese\b/i, 'Portugal'],
  [/\bgermany\b|\bgerman\b/i, 'Germany'],
  [/\bnetherlands\b|\bdutch\b/i, 'Netherlands'],
  [/\bbelgium\b|\bbelgian\b/i, 'Belgium'],
  [/\bswitzerland\b|\bswiss\b/i, 'Switzerland'],
  [/\bdenmark\b|\bdanish\b/i, 'Denmark'],
  [/\bnorway\b|\bnorwegian\b/i, 'Norway'],
  [/\bfrance\b|\bfrench\b/i, 'France'],
  [/\bitaly\b|\bitalian\b/i, 'Italy'],
  [/\bireland\b|\birish\b/i, 'Ireland'],
  [/\bindonesia\b/i, 'Indonesia'],
  [/\baustralia\b|\baustralian\b/i, 'Australia'],
  [/\bbrazil\b|\bbrazilian\b/i, 'Brazil'],
  [/\bperu\b|\bperuvian\b/i, 'Peru'],
  [/\bchile\b|\bchilean\b/i, 'Chile'],
  [/\biberia\b|\biberian\b/i, 'Iberia'],
];

// Brands whose market the text does not spell out. Matched on repo name.
const MARKET_BY_NAME = [
  [/^BT-/, 'United Kingdom'],
  [/^CityFibre|CityFibre/i, 'United Kingdom'],
  [/^Gamma/i, 'United Kingdom'],
  [/^giffgaff/i, 'United Kingdom'],
  [/PXC/i, 'United Kingdom'],
  [/VMO2/i, 'United Kingdom'],
  [/^Cellnex/i, 'Spain'],
  [/^MasOrange/i, 'Spain'],
  [/^PremiumFiber/i, 'Spain'],
  [/^VFES/i, 'Spain'],
  [/^Movistar$|^MovistarES/i, 'Spain'],
  [/^Movistar-Peru|^MiFibra/i, 'Peru'],
  [/^VFPT$/i, 'Portugal'],
  [/^SacoorBrothers|^Cavida$/i, 'Portugal'],
  [/^TeliaNO$/i, 'Norway'],
  [/^Norlys/i, 'Denmark'],
  [/^TDC$/i, 'Denmark'],
  [/^TDF$/i, 'France'],
  [/^Orange-/i, 'France'],
  [/^TIM-/i, 'Italy'],
  [/^EOLO$/i, 'Italy'],
  [/^KPN-|^Ziggo-/i, 'Netherlands'],
  [/^Telenet-/i, 'Belgium'],
  [/^Swisscom-/i, 'Switzerland'],
  [/^DTAG-|^TelefonicaDE$/i, 'Germany'],
  [/^VMIE|VMIE/i, 'Ireland'],
  [/^TPG-/i, 'Australia'],
  [/^XL-AXIATA|^XLSMART/i, 'Indonesia'],
  [/^STC-|^Fusion_dataset$/i, 'Saudi Arabia'],
  [/^MTN-/i, 'South Africa'],
  [/^WOM$/i, 'Chile'],
  [/^EquatorialBR$/i, 'Brazil'],
  [/^ChorusNZ$|^ONENZ/i, 'New Zealand'],
  [/^SutelCR$/i, 'Costa Rica'],
  [/^SnowVolt$/i, 'Iberia'],
  [/^SnowBankES$|^SnowCoverES$|^SnowTelco-C360$/i, 'Spain'],
  [/^SnowBank$|^SnowCover$/i, 'Portugal'],
];

// Canonical industries. Matched against the demo's existing industry label, which
// is already curated — the free-text summary is far too noisy for this ('analytics
// workspace' contains 'space', and almost every summary mentions 'regulatory').
const INDUSTRY_PATTERNS = [
  [/regulat/i, 'Regulation & public sector'],
  [/tower|ftth|wholesale fibre|infrastructure/i, 'Telecom infrastructure'],
  [/wholesale|carrier|mvno/i, 'Wholesale & carrier'],
  [/satellite|\bspace\b/i, 'Satellite & space'],
  [/insurance/i, 'Insurance'],
  [/bank|financial services/i, 'Banking & financial services'],
  [/ev charging|electric power|energy storage|utilit|\benergy\b/i, 'Energy & utilities'],
  [/automotive|connected mobility|connected vehicle/i, 'Automotive & mobility'],
  [/retail/i, 'Retail'],
  [/supply chain|manufactur/i, 'Manufacturing & supply chain'],
  [/developer tooling|cloud platforms|\bplatforms?\b/i, 'Platform & tooling'],
  [/telecom|telco|fiber|fibre|mobile|broadband/i, 'Telecommunications'],
];

// Canonical personas. `stated` matches the demo's declared target audience.
// `implied` is what the demo actually does: each persona needs at least
// IMPLIED_MIN distinct signals, so one generic word like "churn" is not enough to
// tag every telco demo as a marketing demo.
const PERSONAS = [
  {
    name: 'CEO & board',
    stated: /\bceos?\b|\bboard\b|c-suite|chief executive/i,
    implied: [/board-level/i, /shareholder/i, /whole-of-business/i, /executive narrative/i],
  },
  {
    name: 'CFO & finance',
    stated: /\bcfos?\b|finance|financial|treasur/i,
    implied: [/revenue assurance/i, /\barpu\b/i, /margin/i, /billing/i, /monetis|monetiz/i,
              /opex|capex/i, /invoice/i, /solvency/i],
  },
  {
    name: 'CTO & network engineering',
    stated: /\bctos?\b|network (leader|engineer|architect|team)|technology leader/i,
    implied: [/\b5g\b/i, /\bran\b/i, /spectrum/i, /telemetry/i, /yang/i, /ipfix/i,
              /network capacity/i, /topolog/i],
  },
  {
    name: 'CIO & IT',
    stated: /\bcios?\b|\bit (leader|team|director)/i,
    implied: [/migrat/i, /legacy/i, /\bsas\b/i, /replatform/i, /consolidat\w* silos/i],
  },
  {
    name: 'Chief data officer & analytics',
    stated: /\bcdos?\b|chief data|data (leader|officer|analyst)|analytics (leader|analyst)|\banalysts?\b|\bbi\b/i,
    implied: [/semantic (view|model)/i, /self-service analytics/i, /single source of truth/i,
              /natural language quer/i],
  },
  {
    name: 'CMO & marketing',
    stated: /\bcmos?\b|marketing|brand|retention leader|growth/i,
    implied: [/churn/i, /campaign/i, /\bnps\b/i, /upsell|cross-sell/i, /acquisition/i, /loyalty/i],
  },
  {
    name: 'COO & operations',
    stated: /\bcoos?\b|operations (leader|director|executive|team)/i,
    implied: [/field (service|workforce)/i, /dispatch/i, /\bsla\b/i, /operational efficiency/i],
  },
  {
    name: 'Sales & commercial',
    stated: /\bcros?\b|sales|commercial|account (team|manager)|channel/i,
    implied: [/\bb2b\b/i, /pipeline/i, /win rate/i, /go-to-market/i, /\bdeals?\b/i],
  },
  {
    name: 'Customer care & experience',
    stated: /customer (care|service|experience|support)|\bcx\b|contact cent/i,
    implied: [/complaint/i, /sentiment/i, /contact cent/i, /first-call/i, /\btickets?\b/i],
  },
  {
    name: 'Network operations & field',
    stated: /network operations|\bnoc\b|field (engineer|technician|ops)/i,
    implied: [/outage/i, /\bincidents?\b/i, /predictive maintenance/i, /remediat/i, /alarm/i,
              /degradation/i],
  },
  {
    name: 'Data engineering & platform',
    stated: /data engineer|data team|platform (team|engineer|buyer|owner)|architect/i,
    implied: [/snowpark/i, /dynamic table/i, /native app/i, /reference architecture/i, /\betl\b/i,
              /\bdbt\b/i, /ingest/i],
  },
  {
    name: 'Data governance & compliance',
    stated: /governance|steward|compliance|\bdpos?\b|privacy officer/i,
    implied: [/lineage/i, /\bpii\b/i, /masking/i, /access polic/i, /audit trail/i,
              /governed data product/i],
  },
  {
    name: 'Regulatory, risk & ESG',
    stated: /regulator|regulatory|\brisks?\b|\besg\b|sustainab|actuar/i,
    implied: [/universal service/i, /spectrum licen/i, /investor-grade/i, /emission/i,
              /scope [123]/i, /solvency ii/i],
  },
  {
    name: 'Supply chain & procurement',
    stated: /supply chain|procurement|\bcscos?\b|logistics/i,
    implied: [/inventory/i, /supplier/i, /lead time/i, /bill of materials/i],
  },
  {
    name: 'Wholesale & partnerships',
    stated: /wholesale|partner|monetis|monetiz|data buyer/i,
    implied: [/carrier/i, /roaming/i, /interconnect/i, /\bmvno\b/i, /altnet/i, /reseller/i],
  },
  {
    name: 'Product management',
    stated: /product (manager|owner|team|leader)/i,
    implied: [/roadmap/i, /product launch/i, /feature adoption/i],
  },
];

// A single keyword is coincidence; two independent signals is a pattern.
const IMPLIED_MIN = 2;
// Beyond this the "also relevant to" list stops being a shortlist.
const MAX_IMPLIED = 3;

// "Telecom executives" is the single most common audience phrasing. Treating it as
// CEO & board outright would tag most of the catalog, so it is only used when the
// audience names no more specific role.
const GENERIC_EXEC = /\bexecutives?\b|\bc-level\b|\bstakeholders?\b|\bleaders\b/i;

// Internal Snowflake audiences are not customer personas.
const INTERNAL_AUDIENCE = /snowflake (sales|platform|account|field)[^,;]*/gi;

function derivePersonas(business) {
  const audience = (business.target_audience || '').replace(INTERNAL_AUDIENCE, '');
  const activity = [
    business.headline,
    business.solution,
    business.business_problem,
    ...(business.key_capabilities || []),
  ]
    .filter(Boolean)
    .join(' ');

  let stated = PERSONAS.filter((p) => p.stated.test(audience)).map((p) => p.name);
  if (!stated.length && GENERIC_EXEC.test(audience)) {
    stated = ['CEO & board'];
  }

  const scored = PERSONAS.filter((p) => !stated.includes(p.name))
    .map((p) => ({
      name: p.name,
      hits: p.implied.filter((re) => re.test(activity)).length,
    }))
    .filter((p) => p.hits >= IMPLIED_MIN)
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));

  return { stated, implied: scored.slice(0, MAX_IMPLIED).map((p) => p.name) };
}

// What the demo is about, as opposed to who it is for. Multi-value: a C360 portal
// that also predicts churn should surface under both. Same two-signal rule as
// personas, so one passing mention does not tag a demo.
const USE_CASES = [
  {
    name: 'Customer 360',
    strong: /customer 360|\bc360\b|single customer view|unified customer/i,
    weak: [/customer journey/i, /subscriber view/i, /household/i],
  },
  {
    name: 'Churn & retention',
    strong: /churn/i,
    weak: [/retention/i, /win-?back/i, /attrition/i, /save desk/i],
  },
  {
    name: 'Network operations & assurance',
    strong: /network (operations|assurance)|\bnoc\b/i,
    weak: [/outage/i, /alarm/i, /fault/i, /remediat/i, /\bsla\b/i, /degradation/i],
  },
  {
    name: 'Predictive maintenance',
    strong: /predictive maintenance|preventive maintenance/i,
    weak: [/failure prediction/i, /remaining useful life/i, /equipment health/i],
  },
  {
    name: 'Revenue & finance analytics',
    strong: /revenue assurance|finance analytics|financial analytics/i,
    weak: [/\barpu\b/i, /margin/i, /billing/i, /invoice/i, /opex|capex/i, /cost allocation/i],
  },
  {
    name: 'Data monetisation & sharing',
    strong: /monetis|monetiz|data sharing|data product|data exchange/i,
    weak: [/marketplace/i, /listing/i, /secure share/i, /data buyer/i, /mobility data/i,
           /sellable/i, /\biot\b/i],
  },
  {
    name: 'Complaints & sentiment',
    strong: /complaint|sentiment analysis/i,
    weak: [/\bnps\b/i, /voice of (the )?customer/i, /contact cent/i, /ticket/i],
  },
  {
    name: 'ESG & sustainability',
    strong: /\besg\b|sustainab/i,
    weak: [/emission/i, /scope [123]/i, /carbon/i, /energy consumption/i],
  },
  {
    name: 'Supply chain intelligence',
    strong: /supply chain/i,
    weak: [/inventory/i, /supplier/i, /procurement/i, /lead time/i, /logistics/i],
  },
  {
    name: 'Executive KPI reporting',
    strong: /executive (dashboard|portal|intelligence|analytics|console)|kpi (dashboard|reporting)/i,
    weak: [/board-level/i, /single pane/i, /c-suite/i, /cockpit/i],
  },
  {
    name: 'Platform migration',
    strong: /migrat(e|ion|ing) from|\bsas\b|replatform/i,
    weak: [/legacy/i, /excel silo/i, /post-sas/i, /decommission/i],
  },
  {
    name: 'Governance & data products',
    strong: /governed data product|data governance/i,
    weak: [/lineage/i, /\bpii\b/i, /masking/i, /steward/i, /access polic/i, /catalog/i],
  },
  {
    name: 'Regulatory reporting',
    strong: /regulator|regulatory reporting|solvency ii/i,
    weak: [/universal service/i, /spectrum licen/i, /supervis/i, /compliance report/i],
  },
  {
    name: 'Marketing & campaigns',
    strong: /campaign|marketing analytics/i,
    weak: [/segment/i, /acquisition/i, /upsell|cross-sell/i, /loyalty/i, /personalis|personaliz/i],
  },
  {
    name: 'Network capacity & 5G',
    strong: /\b5g\b|capacity planning/i,
    weak: [/\bran\b/i, /spectrum/i, /cell site/i, /coverage/i, /backhaul/i, /fibre rollout|fiber rollout/i],
  },
  {
    name: 'Agentic automation',
    strong: /\bagents?\b/i,
    weak: [/closes the loop|close the loop/i, /autonomous/i, /servicenow/i, /remediat/i,
           /multi-agent/i, /orchestrat/i],
  },
  {
    name: 'Natural-language analytics',
    strong: /natural language|ask (the )?data|conversational analytics|instant (business )?answers|intelligence agent/i,
    weak: [/semantic (view|model)/i, /plain english/i, /text-to-sql|text to sql/i,
           /instant answers/i, /snowflake intelligence/i, /every business question/i],
  },
];

const MAX_USE_CASES = 4;

function deriveUseCases(business) {
  // Where a term appears matters more than how often. "Churn" in the headline is
  // what the demo is about; "churn" in one capability bullet is a feature almost
  // every telco demo happens to have, and scoring those equally tagged half the
  // catalog as a churn demo.
  const headline = business.headline || '';
  const body = [business.solution, business.business_problem].filter(Boolean).join(' ');
  const caps = (business.key_capabilities || []).join(' ');
  const all = [headline, body, caps].join(' ');

  const subjectScore = (strong) =>
    strong.test(headline) ? 3 : strong.test(body) ? 2 : strong.test(caps) ? 2 : 0;

  return USE_CASES.map((u) => ({
    name: u.name,
    // Weak signals are capped so a long capability list cannot accumulate its way in.
    score: subjectScore(u.strong) + Math.min(2, u.weak.filter((re) => re.test(all)).length),
  }))
    .filter((u) => u.score >= 3)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_USE_CASES)
    .map((u) => u.name);
}

function pick(patterns, ...haystacks) {
  for (const [re, value] of patterns) {
    if (haystacks.some((h) => h && re.test(h))) return value;
  }
  return null;
}

async function main() {
  const { repos } = JSON.parse(await readFile('data/repos.json', 'utf8'));
  const out = {};
  let namedMarket = 0;

  for (const repo of repos) {
    let business = {};
    try {
      const detail = JSON.parse(await readFile(`data/repos/${repo.name}.json`, 'utf8'));
      business = detail.business || {};
    } catch {
      /* detail file may be absent for a freshly added repo */
    }

    const text = ['headline', 'solution', 'business_problem', 'target_audience']
      .map((k) => business[k] || '')
      .join(' ');

    // The brand table is more reliable than a loose text match, so try it first.
    const market =
      pick(MARKET_BY_NAME, repo.name) || pick(MARKET_PATTERNS, text) || GLOBAL;
    if (market !== GLOBAL) namedMarket++;

    const industry =
      pick(INDUSTRY_PATTERNS, repo.industry || '') || repo.industry || null;

    const { stated, implied } = derivePersonas(business);

    out[repo.name] = {
      market,
      industry,
      personas: stated,
      alsoFor: implied,
      useCases: deriveUseCases(business),
    };
  }

  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  await writeFile('data/facets.json', JSON.stringify(sorted, null, 2) + '\n');

  const markets = new Set(Object.values(out).map((v) => v.market));
  const industries = new Set(Object.values(out).map((v) => v.industry));
  const withPersona = Object.values(out).filter((v) => v.personas.length).length;
  console.log(`Wrote ${Object.keys(sorted).length} entries to data/facets.json`);
  console.log(`  markets:    ${markets.size} (${namedMarket} demos with a named market)`);
  console.log(`  industries: ${industries.size}`);
  console.log(`  personas:   ${withPersona} demos with a stated persona`);
  const useCases = new Set(Object.values(out).flatMap((v) => v.useCases));
  const withUseCase = Object.values(out).filter((v) => v.useCases.length).length;
  console.log(`  use cases:  ${useCases.size} distinct, ${withUseCase} demos tagged`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
