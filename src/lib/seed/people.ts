/**
 * The cast for the seeded dataset.
 *
 * `skill` drives which call archetypes a rep draws and how they perform inside
 * them, so the leaderboard and the per-agent trend lines show real spread
 * instead of noise around a single mean. A dashboard where every rep scores 3.4
 * demonstrates nothing.
 */

export interface SeedAgent {
  name: string;
  email: string;
  team: string;
  dialpadUserId: string;
  /** 0-1. Higher reps ask better questions and commit to dated next steps. */
  skill: number;
  /** Reps early in their tenure carry the compliance slips on purpose. */
  tenureMonths: number;
}

export const SEED_AGENTS: SeedAgent[] = [
  { name: "Dana Whitfield", email: "dana.whitfield@unitedmh.example", team: "New Equipment", dialpadUserId: "5001", skill: 0.55, tenureMonths: 8 },
  { name: "Marcus Oyelaran", email: "marcus.oyelaran@unitedmh.example", team: "Service", dialpadUserId: "5002", skill: 0.78, tenureMonths: 41 },
  { name: "Priya Raghunathan", email: "priya.raghunathan@unitedmh.example", team: "New Equipment", dialpadUserId: "5003", skill: 0.91, tenureMonths: 63 },
  { name: "Tobias Lindqvist", email: "tobias.lindqvist@unitedmh.example", team: "New Equipment", dialpadUserId: "5004", skill: 0.34, tenureMonths: 3 },
  { name: "Renata Alcazar", email: "renata.alcazar@unitedmh.example", team: "Parts", dialpadUserId: "5005", skill: 0.72, tenureMonths: 27 },
  { name: "Desmond Achebe", email: "desmond.achebe@unitedmh.example", team: "Service", dialpadUserId: "5006", skill: 0.63, tenureMonths: 15 },
  { name: "Hollis Vandermeer", email: "hollis.vandermeer@unitedmh.example", team: "Used Equipment", dialpadUserId: "5007", skill: 0.47, tenureMonths: 6 },
  { name: "Ingrid Sokolova", email: "ingrid.sokolova@unitedmh.example", team: "New Equipment", dialpadUserId: "5008", skill: 0.84, tenureMonths: 52 },
  { name: "Callum Brightwater", email: "callum.brightwater@unitedmh.example", team: "Parts", dialpadUserId: "5009", skill: 0.29, tenureMonths: 2 },
  { name: "Yusra Benali", email: "yusra.benali@unitedmh.example", team: "Used Equipment", dialpadUserId: "5010", skill: 0.69, tenureMonths: 19 },
  { name: "Grover Pemberton", email: "grover.pemberton@unitedmh.example", team: "Service", dialpadUserId: "5011", skill: 0.58, tenureMonths: 11 },
  { name: "Anneke Vos", email: "anneke.vos@unitedmh.example", team: "New Equipment", dialpadUserId: "5012", skill: 0.76, tenureMonths: 34 },
];

export interface SeedContact {
  name: string;
  company: string;
  phone: string;
  email: string;
  /** Used by the CRM matching tests in Phase 3. */
  domain: string;
}

export const SEED_CONTACTS: SeedContact[] = [
  { name: "Peter De Haan", company: "Apex Cold Storage", phone: "+15025550142", email: "peter.dehaan@apexcold.example", domain: "apexcold.example" },
  { name: "Sandra Kelleher", company: "Kelleher Distribution", phone: "+15025550188", email: "sandra@kelleherdist.example", domain: "kelleherdist.example" },
  { name: "Doug Nyquist", company: "Nyquist Forest Products", phone: "+15025550233", email: "dnyquist@nyquistfp.example", domain: "nyquistfp.example" },
  { name: "Ellen Vance", company: "Nyquist Forest Products", phone: "+15025550234", email: "evance@nyquistfp.example", domain: "nyquistfp.example" },
  { name: "Rashida Coleman", company: "Bluegrass Beverage", phone: "+15025550310", email: "rcoleman@bgbev.example", domain: "bgbev.example" },
  { name: "Milton Fairweather", company: "Fairweather Millwork", phone: "+15025550377", email: "milton@fwmillwork.example", domain: "fwmillwork.example" },
  { name: "Junko Nakamura", company: "Ohio Valley Plastics", phone: "+15025550401", email: "jnakamura@ovplastics.example", domain: "ovplastics.example" },
  { name: "Terrence Boakye", company: "Boakye Logistics", phone: "+15025550455", email: "terrence@boakyelog.example", domain: "boakyelog.example" },
  { name: "Marisol Quintero", company: "Quintero Produce", phone: "+15025550512", email: "marisol@qproduce.example", domain: "qproduce.example" },
  { name: "Hank Ostrowski", company: "Ostrowski Steel", phone: "+15025550588", email: "hank@ostrowskisteel.example", domain: "ostrowskisteel.example" },
  { name: "Adaeze Nwosu", company: "Riverbend Paper", phone: "+15025550604", email: "anwosu@riverbendpaper.example", domain: "riverbendpaper.example" },
  { name: "Curtis Blackwood", company: "Blackwood Grain", phone: "+15025550671", email: "curtis@blackwoodgrain.example", domain: "blackwoodgrain.example" },
  { name: "Sylvie Marchetti", company: "Marchetti Foods", phone: "+15025550702", email: "sylvie@marchettifoods.example", domain: "marchettifoods.example" },
  { name: "Omar Haddad", company: "Haddad Building Supply", phone: "+15025550744", email: "omar@haddadbuilding.example", domain: "haddadbuilding.example" },
  { name: "Bernice Kowalczyk", company: "Kowalczyk Cold Chain", phone: "+15025550810", email: "bernice@kowalczykcc.example", domain: "kowalczykcc.example" },
];

export const COMPETITORS = [
  "Crown Equipment",
  "Toyota Material Handling",
  "Hyster",
  "Yale",
  "Raymond",
] as const;

export const EQUIPMENT = [
  { name: "reach truck", unitPrice: 42000 },
  { name: "counterbalance forklift", unitPrice: 38500 },
  { name: "order picker", unitPrice: 33750 },
  { name: "pallet jack", unitPrice: 4200 },
  { name: "turret truck", unitPrice: 96000 },
  { name: "tow tractor", unitPrice: 21500 },
] as const;
