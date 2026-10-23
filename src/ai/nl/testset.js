// Hand-written test questions with what they should be understood as. Not used for training: the seed
// set (seed.js) is in masked form and phrased differently. Holder names and asset tags are made up (no
// person or asset from the register): TEST_HOLDERS adds the two holders to the vocabulary for the test.
//   intent: find | count | refresh | unusual | data_issues | cost | who | navigate | change | unknown
//   expect: slots that must be found (category / maker / model names, place words, status state,
//   holder, asset, issue code, os, sort, warranty / bought kind, ram bounds)
const TESTS = [
  // find
  { q: 'dell laptops in mindspace', intent: 'find', expect: { category: ['Laptop'], maker: ['Dell'], place: ['mindspace'] } },
  { q: 'show me lenovo laptops bought before 2020', intent: 'find', expect: { maker: ['Lenovo'], category: ['Laptop'], bought: 'older' } },
  { q: 'laptops in pune whose warranty ends next month', intent: 'find', expect: { category: ['Laptop'], place: ['pune'], warranty: 'ending' } },
  { q: 'list desktops that are out of warranty in chennai', intent: 'find', expect: { category: ['Desktop'], warranty: 'expired', place: ['chennai'] } },
  { q: 'spare laptops at powai', intent: 'find', expect: { category: ['Laptop'], status: 'stock', place: ['powai'] } },
  { q: 'laptops with 8gb ram', intent: 'find', expect: { category: ['Laptop'], ram: { min: 8, max: 8 } } },
  { q: 'thin clients in bangalore', intent: 'find', expect: { category: ['Thin Client'], place: ['bangalore'] } },
  { q: 'which laptops run windows 7', intent: 'find', expect: { category: ['Laptop'], os: 'windows_legacy' } },
  { q: 'the 20 oldest desktops in hyderabad', intent: 'find', expect: { sort: 'oldest', category: ['Desktop'], place: ['hyderabad'] } },
  { q: 'latitude 5410 machines at mindspace', intent: 'find', expect: { model: ['Latitude 5410'], place: ['mindspace'] } },
  { q: 'apple laptops that are deployed', intent: 'find', expect: { maker: ['Apple'], category: ['Laptop'], status: 'assigned' } },
  { q: 'most expensive laptops bought this year', intent: 'find', expect: { sort: 'cost_high', category: ['Laptop'], bought: 'range' } },
  { q: 'retired desktops in usa', intent: 'find', expect: { status: 'retired', category: ['Desktop'], place: ['usa'] } },
  { q: 'laptops under warranty in gurugram', intent: 'find', expect: { category: ['Laptop'], warranty: 'valid', place: ['gurugram'] } },
  { q: 'VMs running linux', intent: 'find', expect: { category: ['VM'], os: 'linux' } },
  { q: 'laptops with less than 16 gb of ram in pune', intent: 'find', expect: { category: ['Laptop'], ram: { max: 15 }, place: ['pune'] } },
  { q: "ZaraQ9's laptop", intent: 'find', expect: { holder: 'ZaraQ9', category: ['Laptop'] } },
  { q: 'devices held by VikramS', intent: 'find', expect: { holder: 'VikramS' } },
  { q: 'dell optiplex 7010 desktops older than 8 years', intent: 'find', expect: { maker: ['Dell'], model: ['OptiPlex 7010'], category: ['Desktop'], bought: 'older' } },
  { q: 'hp laptops in noida', intent: 'find', expect: { maker: ['HP'], category: ['Laptop'], place: ['noida'] } },
  { q: 'broken laptops', intent: 'find', expect: { status: 'repair', category: ['Laptop'] } },
  { q: 'laptops returned to client', intent: 'find', expect: { status: 'returned', category: ['Laptop'] } },
  { q: 'unassigned laptops in mindspace with windows 11', intent: 'find', expect: { status: 'stock', os: 'windows11', place: ['mindspace'], category: ['Laptop'] } },
  { q: 'desktops purchased in 2019', intent: 'find', expect: { category: ['Desktop'], bought: 'range' } },
  { q: 'cisco assets in bengaluru', intent: 'find', expect: { maker: ['Cisco'], place: ['bengaluru'] } },
  { q: 'lenovo thinkpad laptops', intent: 'find', expect: { maker: ['Lenovo'], category: ['Laptop'] } },
  { q: 'newest laptops at L&T', intent: 'find', expect: { sort: 'newest', category: ['Laptop'], place: ['lnt'] } },
  { q: 'laptops with warranty expiring in december', intent: 'find', expect: { category: ['Laptop'], warranty: 'ending' } },
  { q: 'show laptops which are 4 years old', intent: 'find', expect: { category: ['Laptop'], bought: 'range' } },
  { q: 'all mac os laptops', intent: 'find', expect: { os: 'macos', category: ['Laptop'] } },
  // count
  { q: 'how many laptops do we have in pune', intent: 'count', expect: { category: ['Laptop'], place: ['pune'] } },
  { q: 'how many desktops are in stock at mindspace', intent: 'count', expect: { category: ['Desktop'], status: 'stock', place: ['mindspace'] } },
  { q: 'number of laptops with warranty expiring this quarter', intent: 'count', expect: { category: ['Laptop'], warranty: 'ending' } },
  { q: 'count the retired thin clients', intent: 'count', expect: { status: 'retired', category: ['Thin Client'] } },
  { q: 'how many dell laptops are older than 5 years', intent: 'count', expect: { maker: ['Dell'], category: ['Laptop'], bought: 'older' } },
  { q: 'total vms in usa', intent: 'count', expect: { category: ['VM'], place: ['usa'] } },
  { q: 'how many laptops does ZaraQ9 have', intent: 'count', expect: { category: ['Laptop'], holder: 'ZaraQ9' } },
  { q: 'how many machines run windows 10', intent: 'count', expect: { os: 'windows10' } },
  { q: 'how many assets are out of warranty in powai', intent: 'count', expect: { warranty: 'expired', place: ['powai'] } },
  { q: "what's the number of lenovo laptops in chennai", intent: 'count', expect: { maker: ['Lenovo'], category: ['Laptop'], place: ['chennai'] } },
  { q: 'count laptops bought in 2022', intent: 'count', expect: { category: ['Laptop'], bought: 'range' } },
  { q: 'how many spare laptops are there in hyderabad', intent: 'count', expect: { status: 'stock', category: ['Laptop'], place: ['hyderabad'] } },
  { q: 'how many desktops in total', intent: 'count', expect: { category: ['Desktop'] } },
  { q: 'how many laptops have 32 gb ram', intent: 'count', expect: { category: ['Laptop'], ram: { min: 32, max: 32 } } },
  { q: 'number of thin clients in mindspace', intent: 'count', expect: { category: ['Thin Client'], place: ['mindspace'] } },
  // refresh
  { q: 'which laptops are due for refresh in pune', intent: 'refresh', expect: { category: ['Laptop'], place: ['pune'] } },
  { q: 'laptops that need replacing next year', intent: 'refresh', expect: { category: ['Laptop'] } },
  { q: 'what should we replace first in mindspace', intent: 'refresh', expect: { place: ['mindspace'] } },
  { q: 'high risk laptops at powai', intent: 'refresh', expect: { category: ['Laptop'], place: ['powai'] } },
  { q: 'desktops close to end of life', intent: 'refresh', expect: { category: ['Desktop'] } },
  { q: 'which dell laptops are likely to be retired soon', intent: 'refresh', expect: { maker: ['Dell'], category: ['Laptop'] } },
  { q: 'refresh candidates in chennai', intent: 'refresh', expect: { place: ['chennai'] } },
  { q: 'laptops due for replacement', intent: 'refresh', expect: { category: ['Laptop'] } },
  // unusual
  { q: 'show unusual assets in mindspace', intent: 'unusual', expect: { place: ['mindspace'] } },
  { q: 'any odd laptops in pune', intent: 'unusual', expect: { category: ['Laptop'], place: ['pune'] } },
  { q: 'anomalies at powai', intent: 'unusual', expect: { place: ['powai'] } },
  { q: 'suspicious records', intent: 'unusual', expect: {} },
  { q: 'laptops that look strange', intent: 'unusual', expect: { category: ['Laptop'] } },
  { q: 'outliers in bangalore', intent: 'unusual', expect: { place: ['bangalore'] } },
  // data issues
  { q: 'laptops with no barcode in chennai', intent: 'data_issues', expect: { issue: 'fams_missing', category: ['Laptop'], place: ['chennai'] } },
  { q: 'assets missing a purchase cost', intent: 'data_issues', expect: { issue: 'missing_cost' } },
  { q: 'which records have duplicate barcodes', intent: 'data_issues', expect: { issue: 'fams_duplicate' } },
  { q: 'data quality problems in powai', intent: 'data_issues', expect: { place: ['powai'] } },
  { q: 'assets without a supplier', intent: 'data_issues', expect: { issue: 'missing_supplier' } },
  { q: 'incomplete records', intent: 'data_issues', expect: {} },
  { q: 'laptops with wrong category', intent: 'data_issues', expect: { issue: 'category_mismatch', category: ['Laptop'] } },
  { q: 'what data is missing for desktops', intent: 'data_issues', expect: { category: ['Desktop'] } },
  // cost
  { q: 'how much will we need to spend on replacements next year', intent: 'cost', expect: {} },
  { q: "what's the replacement cost for laptops", intent: 'cost', expect: { category: ['Laptop'] } },
  { q: 'budget needed for refreshing laptops', intent: 'cost', expect: { category: ['Laptop'] } },
  { q: 'cost forecast for the next 12 months', intent: 'cost', expect: {} },
  { q: 'how much do we spend on hardware', intent: 'cost', expect: {} },
  { q: 'plan a refresh within budget', intent: 'cost', expect: {} },
  // who
  { q: 'who has HAMS-900101', intent: 'who', expect: { asset: 'HAMS-900101' } },
  { q: 'who is using 199000101', intent: 'who', expect: { asset: '199000101' } },
  { q: 'where is HAMS-900202', intent: 'who', expect: { asset: 'HAMS-900202' } },
  { q: 'tell me about HAMS-900303', intent: 'who', expect: { asset: 'HAMS-900303' } },
  { q: 'HAMS-900404 owner', intent: 'who', expect: { asset: 'HAMS-900404' } },
  // navigate
  { q: 'how do I add a laptop', intent: 'navigate', expect: {} },
  { q: 'where can I import the asset register', intent: 'navigate', expect: {} },
  { q: 'open the licence page', intent: 'navigate', expect: {} },
  { q: 'take me to ai approvals', intent: 'navigate', expect: {} },
  { q: 'how to print asset labels', intent: 'navigate', expect: {} },
  { q: 'what can you do', intent: 'navigate', expect: {} },
  { q: 'how do I allocate a laptop to a new joinee', intent: 'navigate', expect: {} },
  { q: 'where is data health', intent: 'navigate', expect: {} },
  // changes: refused, with where to do it
  { q: 'retire HAMS-900101', intent: 'change', expect: { asset: 'HAMS-900101' } },
  { q: 'assign HAMS-900202 to ZaraQ9', intent: 'change', expect: { asset: 'HAMS-900202' } },
  { q: 'delete all retired desktops', intent: 'change', expect: {} },
  { q: 'move this laptop to pune', intent: 'change', expect: {} },
  // not about assets: should fall back, not invent filters
  { q: 'what is the weather today', intent: 'unknown', expect: {} },
  { q: 'tell me a joke', intent: 'unknown', expect: {} },
  { q: 'asdfgh qwerty', intent: 'unknown', expect: {} }
];

// Made-up holders the test questions name (CTID -> { id, name }); ids outside any real range.
const TEST_HOLDERS = [['zaraq9', { id: 999999001, name: 'ZaraQ9' }], ['vikrams', { id: 999999002, name: 'VikramS' }]];

module.exports = { TESTS, TEST_HOLDERS };
