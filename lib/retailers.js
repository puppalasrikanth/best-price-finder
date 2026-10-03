// Major US retailers searched in "stores" mode, and friendly display names.
const RETAILERS = {
  'amazon.com': 'Amazon',
  'walmart.com': 'Walmart',
  'target.com': 'Target',
  'bestbuy.com': 'Best Buy',
  'ebay.com': 'eBay',
  'costco.com': 'Costco',
  'samsclub.com': "Sam's Club",
  'newegg.com': 'Newegg',
  'bhphotovideo.com': 'B&H Photo',
  'adorama.com': 'Adorama',
  'homedepot.com': 'The Home Depot',
  'lowes.com': "Lowe's",
  'macys.com': "Macy's",
  'kohls.com': "Kohl's",
  'nordstrom.com': 'Nordstrom',
  'wayfair.com': 'Wayfair',
  'staples.com': 'Staples',
  'officedepot.com': 'Office Depot',
  'gamestop.com': 'GameStop',
  'cvs.com': 'CVS',
  'walgreens.com': 'Walgreens',
  'chewy.com': 'Chewy',
  'rei.com': 'REI',
  'dickssportinggoods.com': "Dick's Sporting Goods",
  'zappos.com': 'Zappos',
  'apple.com': 'Apple',
  'microcenter.com': 'Micro Center',
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function retailerName(url) {
  const host = hostOf(url);
  for (const [domain, name] of Object.entries(RETAILERS)) {
    if (host === domain || host.endsWith('.' + domain)) return name;
  }
  // Fallback: "shop.example.co.uk" -> "Example"
  const parts = host.split('.');
  const core = parts.length >= 2 ? parts[parts.length - 2] : host;
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : 'Store';
}

module.exports = { RETAILERS, RETAILER_DOMAINS: Object.keys(RETAILERS), hostOf, retailerName };
