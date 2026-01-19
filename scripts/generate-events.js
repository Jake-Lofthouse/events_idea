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
// Determine parkrun domain and country code based on coordinates
function getParkrunInfo(latitude, longitude) {
  for (const code in COUNTRIES) {
    const country = COUNTRIES[code];
    if (country.bounds) {
      const [minLng, minLat, maxLng, maxLat] = country.bounds;
      if (longitude >= minLng && longitude <= maxLng && latitude >= minLat && latitude <= maxLat) {
        return { url: country.url, code };
      }
    }
  }
  return { url: "www.parkrun.org.uk", code: "97" }; // Default fallback
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
  const pageTitle = `${longName} - Hotels, Accommodation & Tourist Guide`;
  const { url: parkrunDomain, code: countryCode } = getParkrunInfo(latitude, longitude);
  let description = event.properties.EventDescription || '';
  const hasDescription = description && description.trim() !== '' && description.trim() !== 'No description available.';
  let wikiDesc = null;
  if (hasDescription) {
    try {
      wikiDesc = await fetchWikipediaDescription(name);
      if (wikiDesc && wikiDesc.length > 50) {
        description = `<p>${wikiDesc}</p><p><em>Source: <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, '_'))}" target="_blank" rel="noopener noreferrer">Wikipedia</a></em></p>`;
      } else {
        description = `<p>${description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
      }
    } catch (e) {
      console.warn(`Failed to fetch Wikipedia description for ${name}: ${e.message}`);
      description = `<p>${description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    }
  }
  // Calculate nearby events in same country
  const currentSlug = slugify(name);
  const nearby = allEventsInfo
    .filter(e => e.slug !== currentSlug && e.country === countryCode)
    .map(e => {
      const dist = calculateDistance(latitude, longitude, e.lat, e.lon);
      return { ...e, dist };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  const nearbyHtml = nearby.length > 0 ? `
    <div id="nearby-section" class="iframe-container">
      <h2 class="section-title">Nearby parkruns</h2>
      <ul class="nearby-list">
        ${nearby.map(n => `<li class="nearby-item"><a href="${BASE_URL}/${slugToSubfolder[n.slug]}/${n.slug}" target="_blank">${n.longName}</a> <span class="distance">(${n.dist.toFixed(1)} km)</span></li>`).join('')}
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
  
  // Improved meta description
  const metaDescription = `Plan your visit to ${longName} parkrun. Find nearby hotels and accommodation, check the weather forecast, view the course map, volunteer roster, and discover nearby parkrun events for the perfect parkrun tourism experience.`;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${pageTitle}</title>
<meta name="description" content="${metaDescription}" />
<meta name="keywords" content="${longName.toLowerCase()}, parkrun, parkrun accommodation, hotels near ${name.toLowerCase()}, ${location.toLowerCase()}, parkrun tourist, weather forecast, course map, volunteer roster, nearby parkruns, ${nearbyKeywords}" />
<meta name="author" content="Jake Lofthouse" />
<meta name="geo.placename" content="${location}" />
<meta name="geo.position" content="${latitude};${longitude}" />
<meta property="og:title" content="${pageTitle}" />
<meta property="og:description" content="${metaDescription}" />
<meta property="og:url" content="https://www.parkrunnertourist.com/${relativePath}" />
<meta property="og:type" content="website" />
<meta property="og:image" content="https://www.parkrunnertourist.com/og-image.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${pageTitle}" />
<meta name="twitter:description" content="${metaDescription}" />
<meta name="robots" content="index, follow" />
<meta name="language" content="en" />
<link rel="canonical" href="https://www.parkrunnertourist.com/${relativePath}" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
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
      font-size: 3.5rem;
      font-weight: 900;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #2e7d32, #4caf50);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-align: center;
      position: relative;
      padding: 2rem 0;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
   
    /* Mobile order for iframes */
    @media (max-width: 1024px) {
      #weather-section { order: 1; }
      #location-section { order: 2; }
      #hotels-section { order: 3; }
      #nearby-section { order: 4; }
      #cancel-tile { order: 5; }
      #further-tile { order: 6; }
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
      overflow: hidden;
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
   
    .left-column {
      grid-column: 1;
      display: flex;
      flex-direction: column;
      gap: 2rem;
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
   
    .nearby-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding: 0.5rem;
      border-radius: 0.5rem;
      background: #f8fafc;
      transition: background 0.3s;
    }

    .nearby-item:hover {
      background: #e2e8f0;
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

    .distance {
      font-size: 0.9rem;
      color: #64748b;
    }
   
    /* Cancellation styles */
    .cancel-banner {
      background: #ef4444;
      color: white;
      text-align: center;
      padding: 1rem;
      font-weight: bold;
      margin-bottom: 2rem;
      display: none;
    }

    .status-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      font-size: 16px;
      margin-right: 8px;
    }

    .green {
      background: #22c55e;
      color: white;
    }

    .yellow {
      background: #eab308;
      color: white;
    }

    .red {
      background: #ef4444;
      color: white;
    }

    .cancel-tile p {
      display: flex;
      align-items: center;
    }

    .further-tile li {
      display: flex;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .last-update {
      font-size: 0.8rem;
      color: #64748b;
      margin-top: 0.5rem;
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
      background: none
