const store = require('./store');
const MAX = 60;

function tierFor(skins) {
  if (skins >= 300) return { tier: 'Legendary', tierVar: '--legendary' };
  if (skins >= 160) return { tier: 'Epic', tierVar: '--epic' };
  if (skins >= 60) return { tier: 'Rare', tierVar: '--rare' };
  return { tier: 'Common', tierVar: '--common' };
}

function make(name, skins, price, desc, chips) {
  const t = tierFor(skins);
  return {
    name,
    skins,
    price: Math.min(MAX, price),
    tier: t.tier,
    tierVar: t.tierVar,
    warranty: skins >= 160 ? '48h warranty' : '24h warranty',
    desc: desc || `Fortnite account with ${skins}+ skins. Full specs shared in your Discord ticket after purchase.`,
    chips: chips || [
      { label: `${skins} skins`, gold: skins >= 160 },
      { label: skins >= 160 ? '48-hour warranty' : '24-hour warranty' }
    ]
  };
}

const ACCOUNTS = [
  make('Hook hoodie 115+ skins', 115, 30, '115+ skins with exclusive emotes, PS+ Celebration Pack items, and Season 2–era Battle Pass rewards no longer earnable.', [
    { label: '115+ skins (27 excl.)', gold: true },
    { label: '129 dances (29 excl.)', gold: true },
    { label: '174 backpacks (14 excl.)' },
    { label: '136 pickaxes (16 excl.)' },
    { label: '34 competitive/FNCS items' },
    { label: '20 true exclusives', gold: true }
  ]),
  make('fortnite account 205 skins leviathan axe candy axe', 205, 40, 'Fortnite account with 205 skins featuring Leviathan outfit with the Leviathan axe and the Candy axe. Stacked and ready.', [
    { label: '205 skins', gold: true },
    { label: 'Leviathan Outfit', gold: true },
    { label: 'Leviathan Axe', gold: true },
    { label: 'Candy Axe', gold: true }
  ]),
  make('220 skin stacked', 220, 35, 'Stacked Chapter 1 veteran. 220 skins, rare pickaxes, high wins, full access.', [
    { label: '220 skins', gold: true },
    { label: 'Chapter 1 Veteran', gold: true },
    { label: 'Rare Pickaxes' },
    { label: 'Full Access' }
  ]),
  make('Travis Scott 140+ skins', 140, 40, 'Massive locker with 140+ skins including Travis Scott, Leviathan, and rare emotes.', [
    { label: '140+ skins', gold: true },
    { label: 'Travis Scott included', gold: true },
    { label: 'Leviathan Outfit', gold: true },
    { label: 'Full Access' }
  ]),
  make('270+ skins loader', 270, 45, '270+ skins across full Chapter 2 era, clean competitive locker.', [
    { label: '270+ skins', gold: true },
    { label: 'Clean Competitive Locker' },
    { label: 'Instant Delivery' }
  ]),
  make('Dev/dev-locker 2972 skins', 2972, 10, 'Premium locker with 2,972 skins, iconic collabs, and maxed Battle Passes.', [
    { label: '2,972 skins', gold: true },
    { label: 'Maxed Battle Passes', gold: true },
    { label: 'Exclusive Gliders' }
  ]),
  make('Tryhard 118 skins', 118, 25, '118 skins packed with rare styles and tryhard cosmetics.', [
    { label: '118 skins', gold: true },
    { label: 'Tryhard Cosmetics' },
    { label: 'Safe & Secure' }
  ]),
  make('OG 155 skins', 155, 30, 'Ultra-stacked with 155+ skins, OG emotes, and full backup codes.', [
    { label: '155+ skins', gold: true },
    { label: 'OG Emotes', gold: true },
    { label: 'Full Backup Codes' }
  ]),
  make('Entry 110 skins', 110, 22, 'Great entry-level stacked account with 110 skins and clean wraps.', [
    { label: '110 skins' },
    { label: 'Clean Wraps' },
    { label: 'Platform Unlinked Ready' }
  ]),
  make('Bundle-heavy 125 skins', 125, 26, '125 skins with multiple rare bundle items and high-tier harvesting tools.', [
    { label: '125 skins', gold: true },
    { label: 'Rare Harvesting Tools' },
    { label: 'Verified Safe' }
  ]),
  make('Ice-themed 95 skins', 95, 20, '95 skins, snow-themed set, clean world of wraps.', [
    { label: '95 skins' },
    { label: 'Snow/Frost Set' }
  ]),
  make('Daily 78 skins', 78, 15, '78 skins, good variety across seasons.', [
    { label: '78 skins' }
  ]),
  make('Mega 320 skins', 320, 55, '320 skins mega locker, multiple legacy names, full passes.', [
    { label: '320 skins', gold: true },
    { label: 'Legacy Battle Passes', gold: true },
    { label: 'Full Access' }
  ]),
  make('Budget 61 skins', 61, 12, '61 skins — most affordable way into a stacked locker.', [
    { label: '61 skins' }
  ]),
  make('Completist 201 skins', 201, 50, '201 skins, near-complete seasonal sets, rare wraps.', [
    { label: '201 skins', gold: true },
    { label: 'Complete Seasonal Sets', gold: true }
  ]),
  make('Micro 40 skins', 40, 9, '40 skins starter account with clean basic locker.', [
    { label: '40 skins' }
  ]),
  make('Competitive 189 skins', 189, 38, '189 skins, FNCS sets, competitive wraps and pickaxes.', [
    { label: '189 skins', gold: true },
    { label: 'FNCS Sets', gold: true }
  ]),
  make('Starter 44 skins', 44, 14, '44 skins, fresh account with early cosmetics.', [
    { label: '44 skins' }
  ]),
  make('Whale 399 skins', 399, 60, '399 skins — near-max locker, insane collection of everything.', [
    { label: '399 skins', gold: true },
    { label: 'Top-Tier Locker', gold: true },
    { label: 'Rare Gliders & Emotes' }
  ]),
  make('Balanced 140 skins', 140, 32, '140 skins balanced locker, mix of OG and modern.', [
    { label: '140 skins', gold: true },
    { label: 'Mix OG + Modern' }
  ]),
  make('Drip 92 skins', 92, 24, '92 skins focused on drip-y iconic outfits.', [
    { label: '92 skins' },
    { label: 'Drip Focus' }
  ]),
  make('Tiny 35 skins', 35, 8, '35 skins budget locker — cheapest entry.', [
    { label: '35 skins' }
  ]),
  make('Legacy 230 skins', 230, 48, '230 skins, strong Chapter 1 identity.', [
    { label: '230 skins', gold: true },
    { label: 'Chapter 1 Identity', gold: true }
  ]),
  make('Practical 66 skins', 66, 16, '66 skins, clean practical locker.', [
    { label: '66 skins' }
  ]),
  make('Ultimate 504 skins', 504, 60, '504 skins ultimate locker — the whole catalogue hobbyist dream.', [
    { label: '504 skins', gold: true },
    { label: 'Ultimate Collection', gold: true },
    { label: 'All Passes Maxed' }
  ])
];

if (store.listAccounts(true).length === 0) {
  ACCOUNTS[0].gallery = [
    { url: 'first-account-gallery/backpacks.jpg', label: '174 backpacks' },
    { url: 'first-account-gallery/pickaxes.jpg', label: '136 pickaxes' },
    { url: 'first-account-gallery/dances.jpg', label: '129 Animations' },
    { url: 'first-account-gallery/competitives.jpg', label: '34 competitive items' },
    { url: 'first-account-gallery/exclusives.jpg', label: '20 exclusives' }
  ];
  ACCOUNTS[1].stock = 1;
  ACCOUNTS[1].credentials = { email: 'hvrulquhtx@rambler.ru', password: 'zsabounii22@F' };
  ACCOUNTS[1].gallery = [
    { url: 'leviathan-account/1.jpg', label: 'Locker overview' },
    { url: 'leviathan-account/2.jpg', label: 'Leviathan set' },
    { url: 'leviathan-account/3.jpg', label: 'Axe showcase' },
    { url: 'leviathan-account/4.jpg', label: 'Skins grid' },
    { url: 'leviathan-account/5.jpg', label: 'Extras' }
  ];
  ACCOUNTS.forEach(a => store.addAccount(a));
  console.log(`Seeded ${ACCOUNTS.length} accounts (max price $${MAX}).`);
} else {
  console.log('Database already has accounts — skipping seed.');
}
console.log(`Total accounts in DB: ${store.listAccounts(true).length}`);