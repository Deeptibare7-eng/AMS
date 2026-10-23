// Seed utterances for the intent classifier, written for this register. They are in masked form: the
// entity extractor replaces what it recognises with CAT, PLACE, STATUS, MAKER, MODEL, HOLDER, ASSET,
// WARRANTY, AGE, RAM, OS, SORT, NUM, ISSUE, so the classifier learns the shape of a question, not
// particular names. The test set (testset.js) is separate, hand-written and in plain words.
// Bump SEED_VERSION when you change this list: the model is retrained and saved as a new version.
const SEED_VERSION = 1;

const SEED = {
  find: [
    'CAT in PLACE', 'show CAT in PLACE', 'list all CAT at PLACE', 'find CAT with WARRANTY', 'CAT with WARRANTY in PLACE',
    'show me MAKER CAT', 'MODEL in PLACE', 'which CAT are STATUS', 'CAT that are STATUS in PLACE', 'STATUS CAT',
    'show STATUS assets at PLACE', 'assets AGE', 'CAT AGE in PLACE', 'CAT bought AGE', 'list CAT with RAM', 'CAT running OS',
    'CAT with OS', 'SORT CAT', 'NUM SORT CAT in PLACE', 'show the SORT MODEL', 'HOLDER CAT', 'CAT of HOLDER', 'show HOLDER assets',
    'what does HOLDER have', 'which assets does HOLDER have', 'MAKER MODEL STATUS', 'give me a list of CAT in PLACE', 'display CAT whose WARRANTY',
    'get all MAKER assets in PLACE', 'CAT where WARRANTY', 'which assets have WARRANTY', 'assets at PLACE', 'everything in PLACE',
    'PLACE CAT', 'CAT from PLACE', 'MODEL CAT with RAM in PLACE', 'show CAT with RAM running OS', 'list assets STATUS at PLACE AGE',
    'which MAKER CAT are AGE', 'find MODEL', 'show MODEL assets', 'CAT with WARRANTY and RAM', 'all CAT', 'show CAT',
    'i need the list of CAT in PLACE', 'pull up STATUS CAT', 'what CAT do we have in PLACE', 'CAT on OS', 'MAKER CAT AGE',
    'show assets with WARRANTY in PLACE', 'list MODEL at PLACE STATUS', 'CAT for HOLDER', 'what is HOLDER using', 'CAT held by HOLDER'
  ],
  count: [
    'how many CAT in PLACE', 'how many CAT are STATUS', 'how many CAT are there in PLACE', 'number of CAT at PLACE', 'count CAT with WARRANTY',
    'count of STATUS CAT', 'total CAT in PLACE', 'how many assets does HOLDER have', 'how many MAKER CAT do we have', 'how many MODEL are STATUS',
    'what is the number of CAT AGE', 'how many assets have WARRANTY', 'total number of CAT STATUS in PLACE', 'count all CAT',
    'how many CAT running OS', 'how many CAT with RAM', 'count MODEL in PLACE', 'how many are STATUS in PLACE', 'number of assets AGE',
    'how many STATUS CAT at PLACE', 'tell me how many CAT are in PLACE', 'how many do we have in PLACE', 'how many CAT bought AGE',
    'quantity of CAT in PLACE', 'how many assets in PLACE', 'how many CAT have WARRANTY in PLACE', 'what is the count of STATUS CAT',
    'how many CAT do we own', 'how many MODEL do we have', 'count the CAT at PLACE', 'how many CAT with WARRANTY', 'total STATUS assets',
    'how many machines in PLACE', 'number of MAKER assets', 'how many CAT are AGE', 'give me the count of CAT in PLACE', 'how many STATUS'
  ],
  refresh: [
    'which CAT are due for refresh', 'CAT due for refresh in PLACE', 'CAT that need replacing', 'which CAT should we replace', 'CAT at high refresh risk',
    'refresh candidates in PLACE', 'what needs to be refreshed in PLACE', 'CAT likely to be retired soon', 'assets due for replacement', 'high risk CAT',
    'which CAT will be retired next year', 'CAT reaching end of life', 'end of life CAT in PLACE', 'which assets need replacement this year',
    'replacement candidates', 'show CAT at risk of retirement', 'CAT to replace in PLACE', 'ageing CAT that need a refresh', 'refresh due CAT',
    'which MODEL need refresh', 'CAT nearing retirement', 'what should be replaced first', 'high refresh risk assets in PLACE', 'CAT due for upgrade',
    'which CAT are past their lifecycle', 'lifecycle risk for CAT in PLACE', 'at risk CAT', 'CAT expected to retire', 'which machines are due for refresh',
    'refresh list for PLACE', 'what is due for a hardware refresh', 'MAKER CAT due for replacement', 'CAT that will need replacing soon'
  ],
  unusual: [
    'unusual assets', 'show unusual CAT in PLACE', 'anomalies in PLACE', 'odd assets', 'suspicious records', 'which assets look wrong',
    'assets that look unusual', 'outliers', 'strange CAT', 'anything unusual in PLACE', 'flagged anomalies', 'anomalous CAT', 'CAT that look odd',
    'unexpected records in PLACE', 'show anomalies', 'list outliers for MODEL', 'weird assets', 'assets that do not fit their model', 'unusual findings',
    'what is unusual about PLACE', 'irregular assets', 'show the anomaly list', 'suspect records at PLACE', 'assets flagged as unusual', 'any anomalies',
    'odd ones out in PLACE', 'which CAT look suspicious', 'unusual MAKER assets'
  ],
  data_issues: [
    'assets with ISSUE', 'CAT with ISSUE in PLACE', 'which assets have ISSUE', 'show ISSUE', 'list ISSUE in PLACE', 'data quality issues',
    'data problems in PLACE', 'incomplete records', 'records with bad data', 'assets with data issues', 'poor data health', 'data health of PLACE',
    'which records need fixing', 'assets with errors in their data', 'dirty data', 'what data is missing', 'missing information', 'data gaps in PLACE',
    'low data health score CAT', 'records to clean up', 'find assets with ISSUE', 'ISSUE in PLACE', 'CAT that have ISSUE', 'how is the data quality',
    'data issues for MODEL', 'bad records', 'how many assets have ISSUE', 'which CAT have ISSUE'
  ],
  cost: [
    'how much will replacements cost', 'replacement cost next year', 'how much budget do we need', 'cost forecast', 'what will the refresh cost',
    'budget for replacing CAT', 'how much to replace CAT in PLACE', 'expected spend next year', 'how much should we budget for CAT', 'replacement budget',
    'projected cost of refresh', 'forecast spending', 'capex forecast', 'how much will we spend on CAT', 'cost to refresh the fleet',
    'what is the replacement need', 'spend estimate for the next 12 months', 'money needed for replacements', 'plan a refresh budget', 'refresh plan',
    'make a refresh plan', 'what can we replace with our budget', 'budget planning', 'how much did we spend last year', 'spending trend',
    'procurement forecast', 'cost of replacing old CAT', 'how much will CAT replacements cost', 'what is our hardware spend'
  ],
  who: [
    'who has ASSET', 'who is using ASSET', 'who owns ASSET', 'where is ASSET', 'who is ASSET assigned to', 'ASSET assigned to whom', 'find ASSET',
    'show ASSET', 'status of ASSET', 'details of ASSET', 'what is ASSET', 'who holds ASSET', 'is ASSET assigned', 'look up ASSET', 'ASSET',
    'where can i find ASSET', 'tell me about ASSET', 'ASSET location', 'ASSET owner', 'which user has ASSET', 'open ASSET', 'info on ASSET'
  ],
  navigate: [
    'how do i register an asset', 'add a new asset', 'register a CAT', 'how to import assets', 'open the import page', 'go to licences',
    'where are the licences', 'take me to settings', 'open ai approvals', 'show approvals', 'open data health', 'how do i add a new joinee',
    'new joinee allocation', 'open reports', 'where is the dashboard', 'go to hardware', 'how do i print labels', 'scan a barcode', 'open the scanner',
    'how do i check out an asset', 'how to assign a CAT', 'how do i retire an asset', 'where do i change settings', 'help', 'what can you do',
    'how do i export to excel', 'open maintenance', 'log a repair', 'open refresh planning', 'user directory', 'how do i upload the asset register',
    'where do i approve ai recommendations', 'show me the alerts page', 'how to create a report'
  ]
};

function rows() {
  const out = [];
  for (const [intent, list] of Object.entries(SEED)) for (const text of list) out.push({ text, intent });
  return out;
}

module.exports = { SEED, SEED_VERSION, rows };
