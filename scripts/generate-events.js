const fs = require('fs');
const https = require('https');
const path = require('path');
const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';
const OUTPUT_DIR = './explore';
const MAX_EVENTS = 6;
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
  
  // SEO IMPROVEMENT: Refined title and description
  const pageTitle = `Accommodation near ${longName} | Hotels, Weather & Course Map`;
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
        description = `<p>${description.replace(/</g, '<').replace(/>/g, '>')}</p>`;
      }
    } catch (e) {
      console.warn(`Failed to fetch Wikipedia description: ${e.message}`);
      description = `<p>${description.replace(/</g, '<').replace(/>/g, '>')}</p>`;
    }
  }

  const currentSlug = slugify(name);
  const nearby = allEventsInfo
    .filter(e => e.slug !== currentSlug && e.country === countryCode)
    .map(e => ({ ...e, dist: calculateDistance(latitude, longitude, e.lat, e.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);

  const nearbyKeywords = nearby.map(n => n.longName.toLowerCase()).join(', ');
  const stay22BaseUrl = `https://www.stay22.com/embed/gm?aid=parkrunnertourist&lat=${latitude}&lng=${longitude}&checkin=${checkinDate}&maincolor=7dd856&venue=${encodedName}`;
  const isJunior = longName.toLowerCase().includes('junior');
  const parkrunType = isJunior ? 'Junior' : '5k';
  const mainIframeUrl = `https://parkrunnertourist.com/main?${parkrunType}&lat=${latitude}&lon=${longitude}&zoom=13`;
  const weatherIframeUrl = `https://parkrunnertourist.com/weather?lat=${latitude}&lon=${longitude}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <meta name="description" content="Planning a visit to ${longName}? Find the best hotels, check live weather forecasts, view the course map, and see event status updates." />
  <meta name="keywords" content="accommodation near ${longName}, hotels near ${name.toLowerCase()}, parkrun tourist, ${nearbyKeywords}" />
  <link rel="canonical" href="https://www.parkrunnertourist.com/${relativePath}" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
  <link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
  
  <style>
    body { font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; margin: 0; }
    header { background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%); color: white; padding: 1.25rem 2rem; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    header a { color: white; text-decoration: none; font-weight: 700; font-size: 1.5rem; }
    
    main { max-width: 1300px; margin: 0 auto; padding: 2rem 1rem; }

    /* MEGA BOLD H1 STYLING */
    h1 { 
      font-size: clamp(2.5rem, 6vw, 4.5rem); 
      font-weight: 900; 
      text-align: center; 
      letter-spacing: -0.05em; 
      line-height: 1.1; 
      margin: 2rem 0;
      background: linear-gradient(135deg, #1b5e20, #4caf50);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .parkrun-actions { display: flex; gap: 0.75rem; justify-content: center; margin-bottom: 3rem; flex-wrap: wrap; }
    .action-btn { background: #2e7d32; color: white; padding: 0.8rem 1.6rem; border-radius: 0.75rem; font-weight: 700; text-decoration: none; transition: 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .action-btn:hover { background: #1b5e20; transform: translateY(-2px); }

    .content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
    .iframe-container { background: white; border-radius: 1.25rem; padding: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
    
    .section-title { font-size: 1.4rem; font-weight: 800; margin-bottom: 1.25rem; color: #0f172a; border-left: 5px solid #4caf50; padding-left: 12px; }
    
    iframe { width: 100%; border-radius: 0.75rem; border: none; }
    .weather-iframe { height: 320px; }
    .map-iframe { height: 450px; }
    .accommodation-iframe { height: 650px; }

    /* MOBILE REORDERING LOGIC */
    @media (max-width: 1024px) {
      .content-grid { display: flex; flex-direction: column; }
      #weather-section { order: 1; }
      #location-section { order: 2; }
      #hotels-section { order: 3; }
      #nearby-section { order: 4; }
      #cancel-tile { order: 5; }
      #further-tile { order: 6; }
    }

    .nearby-item { background: #f1f5f9; padding: 1rem; border-radius: 0.75rem; margin-bottom: 0.75rem; display: flex; justify-content: space-between; font-weight: 600; }
    .nearby-item a { color: #2e7d32; text-decoration: none; }

    /* Modals */
    .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); }
    .modal-content { background: white; margin: 2% auto; width: 90%; max-width: 1000px; height: 85%; border-radius: 1rem; overflow: hidden; position: relative; }
    .modal-header { background: #2e7d32; color: white; padding: 1.5rem; display: flex; justify-content: space-between; align-items: center; }
    .close { font-size: 2rem; cursor: pointer; font-weight: bold; }
  </style>
</head>
<body>

<header><a href="https://www.parkrunnertourist.com">parkrunner tourist</a></header>

<main>
  <h1>Accommodation near ${longName}</h1>

  <div class="parkrun-actions">
    <a href="#" class="action-btn" onclick="openModal('courseModal')">Course Map</a>
    <a href="#" class="action-btn" onclick="openModal('volunteerModal')">Volunteer Roster</a>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}" target="_blank" class="action-btn">Directions</a>
  </div>

  ${hasDescription ? `<div class="iframe-container" style="margin-bottom: 2.5rem;">${description}</div>` : ''}

  <div class="content-grid">
    <div id="weather-section" class="iframe-container">
      <h2 class="section-title">Weather This Week</h2>
      <iframe class="weather-iframe" data-src="${weatherIframeUrl}"></iframe>
    </div>

    <div id="location-section" class="iframe-container">
      <h2 class="section-title">parkrun Location</h2>
      <iframe class="map-iframe" data-src="${mainIframeUrl}"></iframe>
    </div>

    <div id="hotels-section" class="iframe-container">
      <h2 class="section-title">Hotel Prices</h2>
      <iframe id="stay22Frame" class="accommodation-iframe" scrolling="no" src="${stay22BaseUrl}&viewmode=listview"></iframe>
    </div>

    <div id="nearby-section" class="iframe-container">
      <h2 class="section-title">Nearby parkruns</h2>
      <div class="nearby-list">
        ${nearby.map(n => `
          <div class="nearby-item">
            <a href="${BASE_URL}/${slugToSubfolder[n.slug]}/${n.slug}">${n.longName}</a>
            <span style="color: #64748b;">${n.dist.toFixed(1)} km</span>
          </div>`).join('')}
      </div>
    </div>

    <div id="cancel-tile" class="iframe-container">
      <h2 class="section-title">Event Status</h2>
      <p id="status-msg">Fetching live data...</p>
    </div>

    <div id="further-tile" class="iframe-container">
      <h2 class="section-title">Future Cancellations</h2>
      <p>None currently listed.</p>
    </div>
  </div>
</main>

<div id="courseModal" class="modal">
  <div class="modal-content">
    <div class="modal-header"><h2>Course Map</h2><span class="close" onclick="closeModal('courseModal')">×</span></div>
    <iframe id="courseIframe" style="height: 100%;"></iframe>
  </div>
</div>

<div id="volunteerModal" class="modal">
  <div class="modal-content">
    <div class="modal-header"><h2>Volunteer Roster</h2><span class="close" onclick="closeModal('volunteerModal')">×</span></div>
    <iframe id="volunteerIframe" style="height: 100%;"></iframe>
  </div>
</div>

<script>
  function openModal(id) {
    const slug = "${currentSlug}";
    const domain = "${parkrunDomain}";
    const frame = id === 'courseModal' ? 'courseIframe' : 'volunteerIframe';
    const path = id === 'courseModal' ? 'course' : 'futureroster';
    document.getElementById(frame).src = \`https://\${domain}/\${slug}/\${path}/\`;
    document.getElementById(id).style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    document.getElementById(id).style.display = 'none';
    document.body.style.overflow = 'auto';
  }

  // Lazy load map and weather
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.target.dataset.src) {
        entry.target.src = entry.target.dataset.src;
        observer.unobserve(entry.target);
      }
    });
  });
  document.querySelectorAll('iframe[data-src]').forEach(el => observer.observe(el));
</script>
</body>
</html>`;
}

// Sitemap XML generator with subfolder support (no .html in URLs)
function generateSitemap(eventPaths) {
  const today = new Date().toISOString().slice(0, 10);
  const urlset = eventPaths
    .map(eventPath => {
      // Remove .html and ensure no trailing slash
      const cleanPath = eventPath.replace(/\.html$/, '').replace(/\/$/, '');
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
      const { code: country } = getParkrunInfo(lat, lon);
      allEventsInfo.push({ slug, lat, lon, longName, country });
      const relativePath = `${actualSubfolder}/${slug}`;
      eventPaths.push(relativePath);
    }
    // Second pass: generate and write HTML files
    for (const event of selectedEvents) {
      const slug = slugify(event.properties.eventname);
      const actualSubfolder = slugToSubfolder[slug];
      const subfolderPath = path.join(OUTPUT_DIR, actualSubfolder);
      ensureDirectoryExists(subfolderPath);
      const filename = path.join(subfolderPath, `${slug}.html`);
      const relativePath = `${actualSubfolder}/${slug}`;
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
