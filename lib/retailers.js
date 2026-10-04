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

// Store search links, used when a product was found on a search/category page and has no
// product page URL of its own: the link opens the store's search for that exact product.
const SEARCH_URLS = {
  'amazon.com': 'https://www.amazon.com/s?k=',
  'walmart.com': 'https://www.walmart.com/search?q=',
  'target.com': 'https://www.target.com/s?searchTerm=',
  'bestbuy.com': 'https://www.bestbuy.com/site/searchpage.jsp?st=',
  'ebay.com': 'https://www.ebay.com/sch/i.html?_nkw=',
  'costco.com': 'https://www.costco.com/CatalogSearch?keyword=',
  'samsclub.com': 'https://www.samsclub.com/s/',
  'newegg.com': 'https://www.newegg.com/p/pl?d=',
  'bhphotovideo.com': 'https://www.bhphotovideo.com/c/search?q=',
  'homedepot.com': 'https://www.homedepot.com/s/',
  'lowes.com': 'https://www.lowes.com/search?searchTerm=',
  'kohls.com': 'https://www.kohls.com/search.jsp?search=',
  'gamestop.com': 'https://www.gamestop.com/search/?q=',
  'microcenter.com': 'https://www.microcenter.com/search/search_results.aspx?Ntt=',
};

function storeSearchUrl(pageUrl, name) {
  const host = hostOf(pageUrl);
  const domain = Object.keys(SEARCH_URLS).find((d) => host === d || host.endsWith('.' + d));
  if (!domain || !name) return null;
  const q = String(name).replace(/[|\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return SEARCH_URLS[domain] + encodeURIComponent(q);
}

module.exports = { RETAILERS, RETAILER_DOMAINS: Object.keys(RETAILERS), hostOf, retailerName, storeSearchUrl };
