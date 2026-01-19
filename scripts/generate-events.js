const fs = require('fs');
const https = require('https');
const path = require('path');
const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';
const OUTPUT_DIR = './explore';
const MAX_EVENTS = 999999;
const MAX_FILES_PER_FOLDER = 999;
const BASE_URL = 'https://www.parkrunnertourist.com/explore';
// Country bounds for parkrun URL detection
const COUNTRIES = {
  "0": {
    "url": null,
    "bounds": [-141.002, -47.29, 180, 83.1132]
  },
  "3": {
    "url": "www.parkrun.com.au",
    "bounds": [112.921, -43.6432, 153.639, -10.0591]
  },
  "4": {
    "url": "www.parkrun.co.at",
    "bounds": [9.53095, 46.3727, 17.1621, 49.0212]
  },
  "14": {
    "url": "www.parkrun.ca",
    "bounds": [-141.002, 41.6766, -52.6191, 83.1132]
  },
  "23": {
    "url": "www.parkrun.dk",
    "bounds": [8.07251, 54.5591, 15.157, 57.3282]
  },
  "30": {
    "url": "www.parkrun.fi",
    "bounds": [20.5486, 59.8078, 31.5867, 70.0923]
  },
  "32": {
    "url": "www.parkrun.com.de",
    "bounds": [5.86632, 47.2701, 15.0418, 55.0584]
  },
  "42": {
    "url": "www.parkrun.ie",
    "bounds": [-10.48, 51.4475, -5.99805, 55.3829]
  },
  "44": {
    "url": "www.parkrun.it",
    "bounds": [6.62662, 36.6441, 18.5204, 47.0918]
  },
  "46": {
    "url": "www.parkrun.jp",
    "bounds": [122.934, 24.2552, 145.817, 45.523]
  },
  "54": {
    "url": "www.parkrun.lt",
    "bounds": [20.9415, 53.8968, 26.8355, 56.4504]
  },
  "57": {
    "url": "www.parkrun.my",
    "bounds": [99.6407, 0.855001, 119.27, 7.36334]
  },
  "64": {
    "url": "www.parkrun.co.nl",
    "bounds": [3.35838, 50.7504, 7.2275, 53.5157]
  },
  "65": {
    "url": "www.parkrun.co.nz",
    "bounds": [166.724, -47.29, 180, -34.3928]
  },
  "67": {
    "url": "www.parkrun.no",
    "bounds": [4.64182, 57.9799, 31.0637, 71.1855]
  },
  "74": {
    "url": "www.parkrun.pl",
    "bounds": [14.1229, 49.002, 24.1458, 54.8358]
  },
  "82": {
    "url": "www.parkrun.sg",
    "bounds": [103.606, 1.21065, 104.044, 1.47077]
  },
  "85": {
    "url": "www.parkrun.co.za",
    "bounds": [16.4519, -34.8342, 32.945, -22.125]
  },
  "88": {
    "url": "www.parkrun.se",
    "bounds": [11.1095, 55.3374, 24.1552, 69.06]
  },
  "97": {
    "url": "www.parkrun.org.uk",
    "bounds": [-8.61772, 49.9029, 1.76891, 59.3608]
  },
  "98": {
    "url": "www.parkrun.us",
    "bounds": [-124.733, 24.5439, -66.9492, 49.3845]
  }
};
// Helper: fetch JSON over HTTPS
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => reject(err));
  });
}
// Slugify event name for URLs
function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}
// Get next Friday date ISO string (YYYY-MM-DD)
function getNextFridayDateISO() {
  const today = new Date();
  const day = today.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  today.setDate(today.getDate() + daysUntilFriday);
  return today.toISOString().slice(0, 10);
}
// Determine parkrun domain based on coordinates
function getParkrunDomain(latitude, longitude) {
  for (const country of Object.values(COUNTRIES)) {
    if (country.url && country.bounds) {
      const [minLng, minLat, maxLng, maxLat] = country.bounds;
      if (longitude >= minLng && longitude <= maxLng && latitude >= minLat && latitude <= maxLat) {
        return country.url;
      }
    }
  }
  return "www.parkrun.org.uk"; // Default fallback
}
// Fetch Wikipedia description about the parkrun location.
async function fetchWikipediaDescription(eventName) {
  const query = encodeURIComponent(eventName);
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro&explaintext&titles=${query}`;
  try {
    const data = await fetchJson(url);
    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];
    if (pageId !== '-1') {
      return pages[pageId].extract;
    }
  } catch (e) {
    console.warn(`Wiki fetch error for ${eventName}: ${e}`);
  }
  return null;
}
// Determine subfolder based on first letter of slug
function getSubfolder(slug) {
  const firstChar = slug.charAt(0).toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'z') {
    return firstChar.toUpperCase();
  }
  // For numbers or special characters, use '0-9' folder
  return '0-9';
}
// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
// Generate the HTML content for each event page
async function generateHtml(event, relativePath, allEventsInfo, slugToSubfolder) {
  const name = event.properties.eventname || 'Unknown event';
  const longName = event.properties.EventLongName || name;
  const location = event.properties.EventLocation || '';
  const coords = event.geometry.coordinates || [];
  const latitude = coords[1] || 0;
  const longitude = coords[0] || 0;
  const encodedName = encodeURIComponent(`${longName}`);
  const checkinDate = getNextFridayDateISO();
  const pageTitle = `Accommodation near ${longName} parkrun | parkrunner tourist`;
  const parkrunDomain = getParkrunDomain(latitude, longitude);
  let description = event.properties.EventDescription || '';
  const hasDescription = description && description.trim() !== '' && description.trim() !== 'No description available.';
  let wikiDesc = null;
  if (hasDescription) {
    try {
      wikiDesc = await fetchWikipediaDescription(name);
      if (wikiDesc && wikiDesc.length > 50) {
        description = `<p>${wikiDesc}</p><p><em>Source: <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, '_'))}" target="_blank" rel="noopener noreferrer">Wikipedia</a></em></p>`;
      } else {
        description = `<p>${description.replace(/</g, '&lt;').replace(/>g, '&gt;')}</p>`;
      }
    } catch (e) {
      console.warn(`Failed to fetch Wikipedia description for ${name}: ${e.message}`);
      description = `<p>${description.replace(/</g, '&lt;').replace(/>g, '&gt;')}</p>`;
    }
  }
  // Calculate nearby events
  const currentSlug = slugify(name);
  const nearby = allEventsInfo
    .filter(e => e.slug !== currentSlug)
    .map(e => {
      const dist = calculateDistance(latitude, longitude, e.lat, e.lon);
      return { ...e, dist };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  const nearbyHtml = nearby.length > 0 ? `
    <div class="iframe-container">
      <h2 class="section-title">Nearby parkruns</h2>
      <ul class="nearby-list">
        ${nearby.map(n => `<li><a href="${BASE_URL}/${slugToSubfolder[n.slug]}/${n.slug}/" target="_blank">${n.longName} (${n.dist.toFixed(1)} km)</a></li>`).join('')}
      </ul>
    </div>
  ` : '';
  const nearbyKeywords = nearby.map(n => n.longName.toLowerCase()).join(', ');
  // Stay22 iframe base URL with scroll locking via scrolling="no"
  const stay22BaseUrl = `https://www.stay22.com/embed/gm?aid=parkrunnertourist&lat=${latitude}&lng=${longitude}&checkin=${checkinDate}&maincolor=7dd856&venue=${encodedName}`;
  // Determine if it's a junior parkrun and set the appropriate URL
  const isJunior = longName.toLowerCase().includes('junior');
  const parkrunType = isJunior ? 'Junior' : '5k';
  const mainIframeUrl = `https://parkrunnertourist.com/main?${parkrunType}&lat=${latitude}&lon=${longitude}&zoom=13`;
  // Weather iframe URL
  const weatherIframeUrl = `https://parkrunnertourist.com/weather?lat=${latitude}&lon=${longitude}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${pageTitle}</title>
<meta name="description" content="Find and book hotels, campsites and cafes around ${longName} parkrun. Includes weather forecast, course map, volunteer roster, and nearby parkruns." />
<meta name="keywords" content="parkrun, accommodation, hotels, stay, tourist, ${name.toLowerCase()}, nearby parkruns, ${nearbyKeywords}" />
<meta name="author" content="Jake Lofthouse" />
<meta name="geo.placename" content="${location}" />
<meta name="geo.position" content="${latitude};${longitude}" />
<meta property="og:url" content="https://www.parkrunnertourist.com/${relativePath}" />
<meta property="og:type" content="article" />
<meta name="robots" content="index, follow" />
<meta name="language" content="en" />
<link rel="canonical" href="https://www.parkrunnertourist.com/${relativePath}" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <!-- Apple Smart Banner -->
  <meta name="apple-itunes-app" content="app-id=6743163993, app-argument=https://www.parkrunnertourist.com">
  <!-- Favicon -->
  <link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-REFFZSK4XK"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-REFFZSK4XK');
    </script>
  <style>
    * {
      box-sizing: border-box;
    }
   
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      margin: 0;
      padding: 0;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
      line-height: 1.6;
    }
   
    header {
      background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
      color: white;
      padding: 1.5rem 2rem;
      font-weight: 600;
      font-size: 1.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 20px rgba(46, 125, 50, 0.3);
      position: relative;
      overflow: hidden;
    }
   
    header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="40" r="1.5" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="80" r="1" fill="rgba(255,255,255,0.1)"/></svg>');
      pointer-events: none;
    }
   
    header a {
      color: white;
      text-decoration: none;
      cursor: pointer;
      position: relative;
      z-index: 1;
      transition: transform 0.3s ease;
    }
   
    header a:hover {
      transform: translateY(-2px);
    }
   
    main {
      padding: 3rem 2rem;
      max-width: 1400px;
      margin: 0 auto;
    }
   
    h1 {
      font-size: 3rem;
      font-weight: 800;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #2e7d32, #4caf50);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-align: center;
      position: relative;
      padding: 2rem 0;
      line-height: 1.2;
    }
   
    .subtitle {
      font-size: 1.5rem;
      font-weight: 600;
      color: #4caf50;
      text-align: center;
      margin-bottom: 3rem;
      position: relative;
    }
   
    .subtitle::after {
      content: '';
      position: absolute;
      bottom: -1rem;
      left: 50%;
      transform: translateX(-50%);
      width: 100px;
      height: 4px;
      background: linear-gradient(135deg, #4caf50, #2e7d32);
      border-radius: 2px;
    }
   
    .description {
      background: white;
      padding: 2rem;
      border-radius: 1rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
      margin-bottom: 3rem;
      border: 1px solid rgba(76, 175, 80, 0.2);
    }
   
    .description p {
      margin: 0;
      color: #374151;
      font-size: 1.1rem;
    }
   
    .section-title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #1f2937;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
   
    .section-title::before {
      content: '';
      width: 4px;
      height: 1.5rem;
      background: linear-gradient(135deg, #4caf50, #2e7d32);
      border-radius: 2px;
    }
   
    .toggle-btn {
      padding: 0.75rem 1.5rem;
      border-radius: 0.75rem;
      margin-right: 1rem;
      margin-bottom: 1rem;
      cursor: pointer;
      font-weight: 600;
      border: 2px solid #4caf50;
      transition: all 0.3s ease;
      background-color: white;
      color: #4caf50;
      user-select: none;
      font-size: 1rem;
      box-shadow: 0 2px 10px rgba(76, 175, 80, 0.2);
    }
   
    .toggle-btn:hover:not(.active) {
      background-color: #f1f8e9;
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
    }
   
    .toggle-btn.active {
      background: linear-gradient(135deg, #4caf50, #2e7d32);
      color: white;
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
    }
   
    .content-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
      margin-bottom: 2rem;
    }
   
    .iframe-container {
      background: white;
      border-radius: 1rem;
      padding: 1rem;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
      border: 1px solid rgba(76, 175, 80, 0.2);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      overflow: hidden;
    }
   
    .iframe-container:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
    }
   
    iframe {
      width: 100%;
      border-radius: 0.75rem;
      border: none;
      overflow: hidden;
    }
   
    .weather-iframe {
      height: 300px;
      width: 100%;
    }
   
    /* Loading placeholder for weather iframe */
    .weather-iframe[data-src]:not([src]) {
      background: linear-gradient(45deg, #f0f0f0 25%, transparent 25%),
                  linear-gradient(-45deg, #f0f0f0 25%, transparent 25%),
                  linear-gradient(45deg, transparent 75%, #f0f0f0 75%),
                  linear-gradient(-45deg, transparent 75%, #f0f0f0 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
      animation: loading 1s linear infinite;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #666;
      font-weight: 500;
    }
   
    .weather-iframe[data-src]:not([src])::after {
      content: 'Loading weather...';
    }
   
    /* Loading placeholder for map iframe */
    .map-iframe[data-src]:not([src]) {
      background: linear-gradient(45deg, #e8f5e8 25%, transparent 25%),
                  linear-gradient(-45deg, #e8f5e8 25%, transparent 25%),
                  linear-gradient(45deg, transparent 75%, #e8f5e8 75%),
                  linear-gradient(-45deg, transparent 75%, #e8f5e8 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
      animation: loading 1s linear infinite;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #4caf50;
      font-weight: 500;
    }
   
    .map-iframe[data-src]:not([src])::after {
      content: 'Loading map...';
    }
   
    @keyframes loading {
      0% { background-position: 0 0, 0 10px, 10px -10px, -10px 0px; }
      100% { background-position: 20px 20px, 20px 30px, 30px 10px, 10px 20px; }
    }
   
    .parkrun-actions {
      display: flex;
      gap: 1rem;
      margin-bottom: 3rem;
      flex-wrap: wrap;
      justify-content: center;
    }
   
    .action-btn {
      padding: 0.75rem 1.5rem;
      border-radius: 0.75rem;
      cursor: pointer;
      font-weight: 600;
      border: 2px solid #4caf50;
      transition: all 0.3s ease;
      background: linear-gradient(135deg, #4caf50, #2e7d32);
      color: white;
      text-decoration: none;
      display: inline-block;
      font-size: 1rem;
      box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
    }
   
    .action-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
      background: linear-gradient(135deg, #388e3c, #1b5e20);
    }
   
    /* Modal Styles */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.5);
      backdrop-filter: blur(5px);
    }
   
    .modal-content {
      background-color: white;
      margin: 2% auto;
      padding: 0;
      border-radius: 1rem;
      width: 90%;
      max-width: 1000px;
      height: 90%;
      position: relative;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
   
    .modal-header {
      background: linear-gradient(135deg, #4caf50, #2e7d32);
      color: white;
      padding: 2rem 2rem;
      border-radius: 1rem 1rem 0 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
   
    .modal-header h2 {
      font-size: 2rem;
      font-weight: 700;
      margin: 0;
      color: white;
    }
   
    .close {
      color: white;
      float: right;
      font-size: 2.5rem;
      font-weight: bold;
      cursor: pointer;
      transition: transform 0.3s ease;
    }
   
    .close:hover {
      transform: scale(1.1);
    }
   
    .modal iframe {
      width: 100%;
      height: calc(100% - 100px);
      border: none;
      border-radius: 0 0 1rem 1rem;
    }
   
    .accommodation-iframe {
      height: 600px;
      overflow-x: hidden;
    }
   
    .map-iframe {
      height: 400px;
    }
   
    .hotels-section {
      grid-column: 1;
    }
   
    .right-column {
      grid-column: 2;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }
   
    .nearby-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
   
    .nearby-list li {
      margin-bottom: 0.75rem;
    }
   
    .nearby-list a {
      color: #4caf50;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.3s;
    }
   
    .nearby-list a:hover {
      color: #2e7d32;
    }
   
    /* Download footer */
    .download-footer {
      background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%);
      padding: 3rem 2rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
      color: white;
      font-weight: 700;
      font-size: 1.3rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      position: relative;
      overflow: hidden;
    }
   
    .download-footer::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="25" cy="25" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="75" cy="45" r="1.5" fill="rgba(255,255,255,0.1)"/><circle cx="45" cy="75" r="1" fill="rgba(255,255,255,0.1)"/></svg>');
      pointer-events: none;
    }
   
    .app-badges {
      display: flex;
      gap: 2rem;
      position: relative;
      z-index: 1;
    }
   
    .download-footer img {
      height: 70px;
      width: auto;
      background: none;
      transition: transform 0.3s ease, filter 0.3s ease;
      cursor: pointer;
      border-radius: 0.5rem;
    }
   
    .download-footer img:hover {
      transform: scale(1.1) translateY(-4px);
      filter: brightness(1.1);
    }
   
    footer {
      text-align: center;
      padding: 2rem;
      background: #f8fafc;
      color: #64748b;
      font-weight: 500;
    }
   
    /* Responsive Design */
    @media (max-width: 1024px) {
      .content-grid {
        grid-template-columns: 1fr;
        gap: 1.5rem;
      }
     
      /* Mobile order: parkrun location, hotels, weather */
      .right-column {
        order: 1;
        grid-column: 1;
        flex-direction: column-reverse;
      }
     
      .hotels-section {
        order: 2;
        grid-column: 1;
      }
     
      .weather-iframe {
        height: 250px;
      }
     
      .accommodation-iframe,
      .map-iframe {
        height: 450px;
      }
     
      .app-badges {
        justify-content: center;
      }
    }
   
    @media (max-width: 768px) {
      main {
        padding: 2rem 1rem;
      }
     
      h1 {
        font-size: 2.5rem;
      }
     
      .subtitle {
        font-size: 1.2rem;
      }
     
      header {
        padding: 1rem;
        font-size: 1.5rem;
      }
     
      .toggle-btn {
        margin-bottom: 0.5rem;
        margin-right: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.9rem;
      }
     
      .app-badges {
        flex-direction: column;
        gap: 1rem;
        align-items: center;
      }
     
      .accommodation-iframe,
      .map-iframe {
        height: 400px;
      }
     
      .weather-iframe {
        height: 200px;
      }
     
      .modal-header h2 {
        font-size: 1.5rem;
      }
     
      .close {
        font-size: 2rem;
      }
    }
   
    /* Hide Buy Me a Coffee widget on mobile and tablets */
    @media (max-width: 1024px) {
      [data-name="BMC-Widget"] {
        display: none !important;
      }
    }
  </style>
</head>
<body>
<header>
  <a href="https://www.parkrunnertourist.com" target="_self" title="Go to parkrunner tourist homepage">parkrunner tourist</a>
  <div></div>
</header>
<main>
  <div class="subtitle">Accommodation near ${longName} </div>
 
  <div class="parkrun-actions">
    <a href="#" class="action-btn" onclick="openModal('courseModal', '${name}')">Course Map</a>
    <a href="#" class="action-btn" onclick="openModal('volunteerModal', '${name}')">Volunteer Roster</a>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}" target="_blank" class="action-btn">Directions</a>
  </div>
 
  ${hasDescription ? `<div class="description">
    ${description}
  </div>` : ''}
  <div class="content-grid">
    <div class="hotels-section">
      <div class="iframe-container">
        <h2 class="section-title">Hotel Prices</h2>
        <div>
          <button class="toggle-btn active" onclick="switchView('listview')" id="btn-listview">List View</button>
          <button class="toggle-btn" onclick="switchView('map')" id="btn-map">Map View</button>
        </div>
        <iframe id="stay22Frame" class="accommodation-iframe" scrolling="no"
          src="${stay22BaseUrl}&viewmode=listview&listviewexpand=true"
          title="Stay22 accommodation listing">
        </iframe>
      </div>
    </div>
    <div class="right-column">
      <div class="iframe-container">
        <h2 class="section-title">parkrun Location</h2>
        <iframe class="map-iframe" data-src="${mainIframeUrl}" title="parkrun Map"></iframe>
      </div>
     
      <div class="iframe-container">
        <h2 class="section-title">Weather This Week</h2>
        <iframe class="weather-iframe" data-src="${weatherIframeUrl}" title="Weather forecast for ${name}"></iframe>
      </div>
      ${nearbyHtml}
    </div>
  </div>
</main>
<!-- Course Modal -->
<div id="courseModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Course Map</h2>
      <span class="close" onclick="closeModal('courseModal')">&times;</span>
    </div>
    <iframe id="courseIframe" src="" title="Course Map"></iframe>
  </div>
</div>
<!-- Volunteer Modal -->
<div id="volunteerModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Volunteer Roster</h2>
      <span class="close" onclick="closeModal('volunteerModal')">&times;</span>
    </div>
    <iframe id="volunteerIframe" src="" title="Volunteer Roster"></iframe>
  </div>
</div>
<div class="download-footer">
  Download The App
  <div class="app-badges">
    <a href="https://apps.apple.com/gb/app/parkrunner-tourist/id6743163993" target="_blank" rel="noopener noreferrer">
      <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" />
    </a>
    <a href="https://play.google.com/store/apps/details?id=appinventor.ai_jlofty8.parkrunner_tourist" target="_blank" rel="noopener noreferrer">
      <img src="https://upload.wikimedia.org/wikipedia/commons/7/78/Google_Play_Store_badge_EN.svg" alt="Get it on Google Play" />
    </a>
  </div>
</div>
<footer>
  &copy; ${new Date().getFullYear()} parkrunner tourist
</footer>
<!-- Buy Me a Coffee Widget - Hidden on mobile and tablets -->
<script data-name="BMC-Widget" data-cfasync="false" src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js" data-id="jlofthouse" data-description="Support me on Buy me a coffee!" data-message="Support The App" data-color="#40DCA5" data-position="Right" data-x_margin="18" data-y_margin="18"></script>
<script>
  function switchView(mode) {
    const iframe = document.getElementById('stay22Frame');
    const baseUrl = "${stay22BaseUrl}";
    iframe.src = baseUrl + "&viewmode=" + mode + "&listviewexpand=" + (mode === 'listview');
    document.getElementById('btn-listview').classList.toggle('active', mode === 'listview');
    document.getElementById('btn-map').classList.toggle('active', mode === 'map');
  }
 
  // Modal functions
  function openModal(modalId, eventName) {
    const modal = document.getElementById(modalId);
    const eventSlug = eventName.toLowerCase().replace(/\\s+/g, '');
   
    if (modalId === 'courseModal') {
      const courseIframe = document.getElementById('courseIframe');
      courseIframe.src = \`https://${parkrunDomain}/\${eventSlug}/course/\`;
    } else if (modalId === 'volunteerModal') {
      const volunteerIframe = document.getElementById('volunteerIframe');
      volunteerIframe.src = \`https://${parkrunDomain}/\${eventSlug}/futureroster/\`;
    }
   
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }
 
  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
   
    // Clear iframe src to stop loading
    if (modalId === 'courseModal') {
      document.getElementById('courseIframe').src = '';
    } else if (modalId === 'volunteerModal') {
      document.getElementById('volunteerIframe').src = '';
    }
  }
 
  // Close modal when clicking outside
  window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
      closeModal(event.target.id);
    }
  }
 
  // Load weather and map iframes only for real users (not crawlers/bots)
  document.addEventListener('DOMContentLoaded', function() {
    // Check if this is likely a crawler/bot
    const userAgent = navigator.userAgent.toLowerCase();
    const isBot = /bot|crawler|spider|crawling|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegram|slackbot|discord|googlebot|bingbot|yahoo|duckduckbot|baiduspider|yandexbot|applebot|ia_archiver|curl|wget|python-requests|scrapy|selenium|phantomjs|headless/i.test(userAgent);
   
    if (!isBot && 'IntersectionObserver' in window) {
      // Use Intersection Observer to load iframes when they come into view
      const lazyIframes = document.querySelectorAll('iframe[data-src]');
     
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !entry.target.src) {
            entry.target.src = entry.target.dataset.src;
            observer.unobserve(entry.target);
          }
        });
      }, {
        rootMargin: '50px' // Load when within 50px of viewport
      });
     
      lazyIframes.forEach(iframe => {
        observer.observe(iframe);
      });
    } else if (!isBot) {
      // Fallback for browsers without Intersection Observer
      setTimeout(() => {
        const lazyIframes = document.querySelectorAll('iframe[data-src]');
        lazyIframes.forEach(iframe => {
          if (!iframe.src) {
            iframe.src = iframe.dataset.src;
          }
        });
      }, 1000);
    }
   
    // Add loading states for other iframes
    const iframes = document.querySelectorAll('iframe:not([data-src])');
    iframes.forEach(iframe => {
      const container = iframe.closest('.iframe-container');
      iframe.addEventListener('load', function() {
        if (container) {
          container.style.background = 'white';
        }
      });
    });
  });
</script>
</body>
</html>`;
}
// Sitemap XML generator with subfolder support (no .html in URLs)
function generateSitemap(eventPaths) {
  const today = new Date().toISOString().slice(0, 10);
  const urlset = eventPaths
    .map(eventPath => {
      // Remove .html and ensure it ends with a trailing slash
      const cleanPath = eventPath.replace(/\.html$/, '');
      return `<url>
        <loc>${BASE_URL}/${cleanPath}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
      </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlset}
</urlset>`;
}
// Create directory structure recursively
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
// Clean up old files and folders
function cleanupOldStructure() {
  try {
    // Remove old HTML files directly in events folder
    if (fs.existsSync(OUTPUT_DIR)) {
      const items = fs.readdirSync(OUTPUT_DIR);
      for (const item of items) {
        const itemPath = path.join(OUTPUT_DIR, item);
        const stat = fs.statSync(itemPath);
        if (stat.isFile() && item.endsWith('.html')) {
          fs.unlinkSync(itemPath);
          console.log(`Removed old file: ${itemPath}`);
        }
      }
    }
  } catch (error) {
    console.warn('Warning: Could not clean up old structure:', error.message);
  }
}
function cleanupRemovedEvents(validSlugs) {
  const subfolders = fs.readdirSync(OUTPUT_DIR);
  for (const folder of subfolders) {
    const folderPath = path.join(OUTPUT_DIR, folder);
    const stats = fs.statSync(folderPath);
    if (stats.isDirectory()) {
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        if (file.endsWith('.html')) {
          const slug = path.basename(file, '.html');
          if (!validSlugs.has(slug)) {
            const fullPath = path.join(folderPath, file);
            fs.unlinkSync(fullPath);
            console.log(`Deleted old HTML: ${fullPath}`);
          }
        }
      }
    }
  }
}
async function main() {
  try {
    console.log('Fetching events JSON...');
    const data = await fetchJson(EVENTS_URL);
    let events;
    if (Array.isArray(data)) {
      events = data;
    } else if (Array.isArray(data.features)) {
      events = data.features;
    } else if (data.events && Array.isArray(data.events.features)) {
      events = data.events.features;
    } else {
      throw new Error('Unexpected JSON structure');
    }
    const selectedEvents = events.slice(0, MAX_EVENTS);
    const eventPaths = [];
    const folderCounts = {};
    // Ensure main output directory exists
    ensureDirectoryExists(OUTPUT_DIR);
    // Clean up old structure
    cleanupOldStructure();
    // Sort events by name to ensure consistent folder distribution
    selectedEvents.sort((a, b) => {
      const nameA = (a.properties.eventname || '').toLowerCase();
      const nameB = (b.properties.eventname || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    // Create a set of valid slugs
    const validSlugs = new Set(
      selectedEvents.map(e => slugify(e.properties.eventname))
    );
    // Remove any HTMLs from disk that don't match
    cleanupRemovedEvents(validSlugs);
    // First pass: assign subfolders and build maps
    const slugToSubfolder = {};
    const allEventsInfo = [];
    for (const event of selectedEvents) {
      const slug = slugify(event.properties.eventname);
      const subfolder = getSubfolder(slug);
      let actualSubfolder = subfolder;
      if (!folderCounts[subfolder]) {
        folderCounts[subfolder] = 0;
      }
      if (folderCounts[subfolder] >= MAX_FILES_PER_FOLDER) {
        let suffix = 2;
        while (true) {
          const cand = `${subfolder}${suffix}`;
          if (!folderCounts[cand]) {
            folderCounts[cand] = 0;
          }
          if (folderCounts[cand] < MAX_FILES_PER_FOLDER) {
            actualSubfolder = cand;
            break;
          }
          suffix++;
        }
      }
      folderCounts[actualSubfolder]++;
      slugToSubfolder[slug] = actualSubfolder;
      const lat = event.geometry.coordinates[1] || 0;
      const lon = event.geometry.coordinates[0] || 0;
      const longName = event.properties.EventLongName || event.properties.eventname;
      allEventsInfo.push({ slug, lat, lon, longName });
      const relativePath = `${actualSubfolder}/${slug}/`;
      eventPaths.push(relativePath);
    }
    // Second pass: generate and write HTML files
    for (const event of selectedEvents) {
      const slug = slugify(event.properties.eventname);
      const actualSubfolder = slugToSubfolder[slug];
      const subfolderPath = path.join(OUTPUT_DIR, actualSubfolder);
      ensureDirectoryExists(subfolderPath);
      const filename = path.join(subfolderPath, `${slug}.html`);
      const relativePath = `${actualSubfolder}/${slug}/`;
      const htmlContent = await generateHtml(event, relativePath, allEventsInfo, slugToSubfolder);
      fs.writeFileSync(filename, htmlContent, 'utf-8');
      console.log(
        `Generated: ${filename} (${folderCounts[actualSubfolder]}/${MAX_FILES_PER_FOLDER} in ${actualSubfolder})`
      );
    }
    // Save sitemap.xml in root directory
    const sitemapContent = generateSitemap(eventPaths);
    fs.writeFileSync('./sitemap.events.xml', sitemapContent, 'utf-8');
    console.log('Generated sitemap.xml in root folder.');
    // Log folder distribution
    console.log('\nFolder distribution:');
    Object.entries(folderCounts).forEach(([folder, count]) => {
      console.log(` ${folder}: ${count} files`);
    });
    console.log(
      `\nSuccessfully generated ${selectedEvents.length} event HTML files across ${Object.keys(folderCounts).length} folders.`
    );
  } catch (err) {
    console.error('Error:', err);
  }
}
main();
