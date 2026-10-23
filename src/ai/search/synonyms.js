// Domain synonyms for smart search: words people type that the register spells differently.
// Every entry is in analyzer form (lower case, singular). A synonym only counts when the word it
// points to really occurs in the register, and it scores a little below the word itself.
//
// Site codes are the ones confirmed for Machine Name (L&T and TX = Powai, BL = Bangalore,
// MS = Mindspace, QBX = Pune Qubix, HYD = Hyderabad, ...). Unknown codes (PR, MA, ...) are left out
// on purpose: nothing is guessed.

// Each group: every word means every other.
const GROUPS = [
  // what it is
  ['laptop', 'notebook', 'lappy', 'lapi'],
  ['desktop', 'pc'],
  ['thin', 'thinclient', 'tc'],
  ['vm', 'virtual', 'vdi'],
  ['server', 'srv'],
  // state
  ['stock', 'instock', 'itstock', 'spare', 'available', 'unallocated'],
  ['deployed', 'allocated', 'assigned', 'issued', 'inuse'],
  ['retired', 'scrapped', 'scrap', 'disposed', 'ewaste', 'recycled', 'writeoff'],
  ['repair', 'faulty', 'broken', 'damaged', 'defective', 'dead'],
  ['lost', 'stolen', 'missing'],
  ['returned', 'rtc'],
  // where
  ['powai', 'lnt', 'tx'],
  ['bangalore', 'bengaluru', 'blr', 'bl', 'blg', 'blcessna'],
  ['mindspace', 'ms', 'ms1', 'ms3'],
  ['qubix', 'qbx', 'qbix'],
  ['hyderabad', 'hyd', 'hybd'],
  ['usa', 'us', 'princeton', 'sdlc'],
  ['gurugram', 'gurgaon', 'ggn'],
  // who made it / what runs on it
  ['hp', 'hewlett'],
  ['apple', 'macbook', 'mac', 'imac'],
  ['microsoft', 'msft'],
  ['win10', 'w10', 'windows10'],
  ['win11', 'w11', 'windows11'],
  ['win7', 'w7', 'windows7'],
  ['ram', 'memory']
];

// One way only: the left word also finds the right ones, not the reverse.
const ONE_WAY = {
  win: ['window'],
  linux: ['ubuntu', 'centos', 'rhel', 'redhat']
};

const MAP = new Map();
function add(from, to) {
  if (from === to) return;
  if (!MAP.has(from)) MAP.set(from, new Set());
  MAP.get(from).add(to);
}
for (const g of GROUPS) for (const a of g) for (const b of g) add(a, b);
for (const [from, tos] of Object.entries(ONE_WAY)) for (const to of tos) add(from, to);

// Other words that mean `term` (analyzer form), without `term` itself.
function of(term) {
  const s = MAP.get(term);
  return s ? [...s] : [];
}

// How to show a code in messages (the analyzer form "lnt" is how "L&T" is indexed).
const DISPLAY = {
  lnt: 'L&T', tx: 'TX', bl: 'BL', blr: 'BLR', blg: 'BLG', ms: 'MS', ms1: 'MS1', ms3: 'MS3', qbx: 'QBX', qbix: 'Qbix',
  hyd: 'HYD', hybd: 'HYBD', us: 'US', usa: 'USA', ggn: 'GGN', sdlc: 'SDLC', hp: 'HP', vm: 'VM', vdi: 'VDI', tc: 'TC',
  pc: 'PC', rtc: 'RTC', win10: 'Win 10', win11: 'Win 11', win7: 'Win 7', w10: 'W10', w11: 'W11', w7: 'W7', ram: 'RAM'
};

module.exports = { of, GROUPS, ONE_WAY, DISPLAY };
