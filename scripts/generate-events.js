const fs = require('fs');
const https = require('https');
const path = require('path');

const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = 'https://api.parkrunnertourist.com/course_maps/course_maps_all.json';
const OUTPUT_DIR = './explore';
const MAX_EVENTS = 6;
const MAX_FILES_PER_FOLDER = 999;
const BASE_URL = 'https://www.parkrunnertourist.com/explore';

// Country URLs by code
const COUNTRIES = {
  "0": {"url": null},
  "3": {"url": "www.parkrun.com.au"},
  "4": {"url": "www.parkrun.co.at"},
  "14": {"url": "www.parkrun.ca"},
  "23": {"url": "www.parkrun.dk"},
  "30": {"url": "www.parkrun.fi"},
  "32": {"url": "www.parkrun.com.de"},
  "42": {"url": "www.parkrun.ie"},
  "44": {"url": "www.parkrun.it"},
  "46": {"url": "www.parkrun.jp"},
  "54": {"url": "www.parkrun.lt"},
  "57": {"url": "www.parkrun.my"},
  "64": {"url": "www.parkrun.co.nl"},
  "65": {"url": "www.parkrun.co.nz"},
  "67": {"url": "www.parkrun.no"},
  "74": {"url": "www.parkrun.pl"},
  "82": {"url": "www.parkrun.sg"},
  "85": {"url": "www.parkrun.co.za"},
  "88": {"url": "www.parkrun.se"},
  "97": {"url": "www.parkrun.org.uk"},
  "98": {"url": "www.parkrun.us"}
};

// Helper: fetch JSON over HTTPS
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', (err) => reject(err));
  });
}

// Slugify event name for URLs
function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Get next Friday date ISO string (YYYY-MM-DD)
function getNextFridayDateISO() {
  const today = new Date();
  const day = today.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  today.setDate(today.getDate() + daysUntilFriday);
  return today.toISOString().slice(0, 10);
}

// Determine parkrun domain based on country code
function getParkrunDomain(code) {
  return COUNTRIES[code]?.url || "www.parkrun.org.uk";
}

// Fetch Wikipedia description
async function fetchWikipediaDescription(eventName) {
  const query = encodeURIComponent(eventName);
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro&explaintext&titles=${query}`;
  try {
    const data = await fetchJson(url);
    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];
    if (pageId !== '-1') return pages[pageId].extract;
  } catch (e) {
    console.warn(`Wiki fetch error for ${eventName}: ${e}`);
  }
  return null;
}

// Determine subfolder based on first letter of slug
function getSubfolder(slug) {
  const firstChar = slug.charAt(0).toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'z') return firstChar.toUpperCase();
  return '0-9';
}

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// COORDINATE ENCRYPTION
// Encrypts route coords so they are not easily copy-pasteable
// Uses a per-event seed XOR-style obfuscation on scaled ints
// ============================================================
function encryptCoords(coords, seed) {
  // Scale to integers (6 decimal places = *1e6), then XOR with rolling seed
  const flat = [];
  let rolling = seed & 0xFFFF;
  for (const [lng, lat] of coords) {
    const ilng = Math.round(lng * 1e6);
    const ilat = Math.round(lat * 1e6);
    // XOR each with rolling value, then advance rolling
    rolling = (rolling * 1664525 + 1013904223) & 0xFFFFFFFF;
    flat.push(ilng ^ (rolling & 0xFFFFFF));
    rolling = (rolling * 1664525 + 1013904223) & 0xFFFFFFFF;
    flat.push(ilat ^ (rolling & 0xFFFFFF));
  }
  // Base64-encode the JSON string of the flat array
  return Buffer.from(JSON.stringify(flat)).toString('base64');
}

// Decrypt function (JS string to embed in HTML)
function decryptFnJs(seed) {
  return `function _dc(b,s){
  const f=JSON.parse(atob(b));
  const r=[];
  let v=s>>>0;
  for(let i=0;i<f.length;i+=2){
    v=(Math.imul(v,1664525)+1013904223)>>>0;
    const lng=(f[i]^(v&0xFFFFFF))/1e6;
    v=(Math.imul(v,1664525)+1013904223)>>>0;
    const lat=(f[i+1]^(v&0xFFFFFF))/1e6;
    r.push([lng,lat]);
  }
  return r;
}`;
}

// Generate a per-event seed from its name (deterministic)
function eventSeed(name) {
  let h = 0x12345678;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return Math.abs(h) % 0xFFFFFF;
}

// ============================================================
// GENERATE HTML
// ============================================================
async function generateHtml(event, relativePath, allEventsInfo, slugToSubfolder, courseMaps = {}) {
  const name = event.properties.eventname || 'Unknown event';
  const longName = event.properties.EventLongName || name;
  const isCurrentJunior = longName.toLowerCase().includes('junior');
  const location = event.properties.EventLocation || '';
  const coords = event.geometry.coordinates || [];
  const latitude = coords[1] || 0;
  const longitude = coords[0] || 0;
  const encodedName = encodeURIComponent(`${longName}`);
  const checkinDate = getNextFridayDateISO();
  const countryCode = event.properties.countrycode;
  const parkrunDomain = getParkrunDomain(countryCode);

  let description = event.properties.EventDescription || '';
  const hasDescription = description && description.trim() !== '' && description.trim() !== 'No description available.';
  let wikiDesc = null;
  if (hasDescription) {
    try {
      wikiDesc = await fetchWikipediaDescription(name);
      if (wikiDesc && wikiDesc.length > 50) {
        description = `<p>${wikiDesc}</p><p><em>Source: <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, '_'))}" target="_blank" rel="noopener noreferrer">Wikipedia</a></em></p>`;
      } else {
        description = `<p>${description.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`;
      }
    } catch (e) {
      description = `<p>${description.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`;
    }
  }

  // Nearby events
  const currentSlug = slugify(name);
  const eventsWithDistances = allEventsInfo
    .filter(e => {
      const eIsJunior = e.longName.toLowerCase().includes('junior');
      return e.slug !== currentSlug && e.country === countryCode && eIsJunior === isCurrentJunior;
    })
    .map(e => ({ ...e, dist: calculateDistance(latitude, longitude, e.lat, e.lon) }));
  const nearby = eventsWithDistances.sort((a,b) => a.dist - b.dist).slice(0, 4);

  const nearbyHtml = nearby.length > 0 ? `
<div id="nearby-section" class="iframe-container">
  <h2 class="section-title">Nearby ${isCurrentJunior ? 'Junior Events' : 'Events'}</h2>
  <ul class="nearby-list">
    ${nearby.map(n => `<li class="nearby-item"><a href="${BASE_URL}/${slugToSubfolder[n.slug] || getSubfolder(n.slug)}/${n.slug}" target="_blank">${n.longName}</a> <span class="distance">(${n.dist.toFixed(1)} km)</span></li>`).join('')}
  </ul>
</div>` : '';

  // Stay22 URLs
  const stay22BaseUrl = `https://www.stay22.com/embed/gm?aid=parkrunnertourist&lat=${latitude}&lng=${longitude}&checkin=${checkinDate}&maincolor=${isCurrentJunior ? '40e0d0' : '7dd856'}&venue=${encodedName}`;
  const stay22ExpBaseUrl = `${stay22BaseUrl}&invmode=experience`;

  const siteName = isCurrentJunior ? 'junior parkrunner tourist' : 'parkrunner tourist';
  const pageTitle = `${longName} - Hotels & Visitor Guide`;
  const parkrunType = isCurrentJunior ? 'Junior' : '5k';
  const mainIframeUrl = `https://parkrunnertourist.com/main?${parkrunType}&lat=${latitude}&lon=${longitude}&zoom=13`;
  const weatherIframeUrl = `https://parkrunnertourist.com/weather?lat=${latitude}&lon=${longitude}`;
  const eventSlug = slugify(name);
  const volunteerUrl = `https://${parkrunDomain}/${eventSlug}/futureroster/`;

  // ============================================================
  // COURSE & TERRAIN TILE
  // ============================================================
  // Try multiple key variations to find course data
  const courseKey = Object.keys(courseMaps).find(k =>
    k === name.toLowerCase() ||
    k === eventSlug ||
    k === name ||
    k.replace(/-/g,'') === eventSlug.replace(/-/g,'')
  );
  const courseData = courseKey ? courseMaps[courseKey] : null;
  const hasRoute = courseData && Array.isArray(courseData.route) && courseData.route.length > 1;
  const hasStart  = courseData && Array.isArray(courseData.start)  && courseData.start.length === 2;
  const hasFinish = courseData && Array.isArray(courseData.finish) && courseData.finish.length === 2;

  // Course video URL — uses parkrun's own course page embedded
  const courseVideoUrl = `https://${parkrunDomain}/${eventSlug}/course/`;

  const seed = eventSeed(name);
  const accentColor = isCurrentJunior ? '#40e0d0' : '#4caf50';
  const darkColor   = isCurrentJunior ? '#008080' : '#2e7d32';

  let courseTileHtml = '';
  let courseCanvasScript = '';

  if (hasRoute) {
    // Encrypt all route coords + start/finish
    const encryptedRoute = encryptCoords(courseData.route, seed);
    const encryptedStart  = hasStart  ? encryptCoords([courseData.start],  seed + 1) : 'null';
    const encryptedFinish = hasFinish ? encryptCoords([courseData.finish], seed + 2) : 'null';

    courseTileHtml = `
<div id="course-terrain-section" class="iframe-container">
  <h2 class="section-title">Course &amp; Terrain</h2>
  <div style="position:relative;background:#e8f5e9;border-radius:0.75rem;overflow:hidden;">
    <canvas id="courseCanvas" style="width:100%;display:block;border-radius:0.75rem;cursor:pointer;min-height:260px;" title="Click to expand"></canvas>
    <div id="course-legend" style="position:absolute;bottom:10px;left:12px;display:flex;gap:10px;align-items:center;font-size:0.78rem;font-weight:600;color:#1f2937;">
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:#22c55e;display:inline-block;"></span>Start</span>
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;"></span>Finish</span>
    </div>
    <button onclick="openCourseVideo()" style="position:absolute;top:10px;right:10px;padding:0.35rem 0.9rem;background:rgba(255,255,255,0.92);border:2px solid ${accentColor};border-radius:0.5rem;font-weight:700;font-size:0.82rem;color:${darkColor};cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='${accentColor}';this.style.color='white';" onmouseout="this.style.background='rgba(255,255,255,0.92)';this.style.color='${darkColor}';">&#9654; Course Video</button>
  </div>
</div>`;

    courseCanvasScript = `
// ---- Course & Terrain Canvas ----
(function(){
  ${decryptFnJs(seed)}

  const encR = "${encryptedRoute}";
  const encS = ${encryptedStart !== 'null' ? `"${encryptedStart}"` : 'null'};
  const encF = ${encryptedFinish !== 'null' ? `"${encryptedFinish}"` : 'null'};

  const route  = _dc(encR, ${seed});
  const start  = encS  ? _dc(encS,  ${seed + 1})[0]  : route[0];
  const finish = encF  ? _dc(encF,  ${seed + 2})[0]  : route[route.length-1];

  const canvas = document.getElementById('courseCanvas');
  if (!canvas) return;

  function drawRoute() {
    const DPR = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width  * DPR || 600 * DPR;
    const H = Math.max(rect.height * DPR, 260 * DPR);
    canvas.width  = W;
    canvas.height = H;
    canvas.style.height = (H / DPR) + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    const cW = W / DPR, cH = H / DPR;
    const pad = 28;

    const lngs = route.map(c => c[0]);
    const lats  = route.map(c => c[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat  = Math.min(...lats),  maxLat  = Math.max(...lats);
    const dLng = maxLng - minLng || 0.001;
    const dLat  = maxLat  - minLat  || 0.001;
    const scaleX = (cW - pad*2) / dLng;
    const scaleY = (cH - pad*2) / dLat;
    const scale  = Math.min(scaleX, scaleY);
    const offX = pad + ((cW - pad*2) - dLng * scale) / 2;
    const offY = pad + ((cH - pad*2) - dLat  * scale) / 2;

    const toX = lng => offX + (lng - minLng) * scale;
    const toY = lat  => cH - offY - (lat  - minLat)  * scale;

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, cW, cH);
    bg.addColorStop(0, '${isCurrentJunior ? '#e0f7f7' : '#e8f5e9'}');
    bg.addColorStop(1, '${isCurrentJunior ? '#b2ebf2' : '#c8e6c9'}');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cW, cH);

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    for (let i=0; i<=4; i++) {
      const y = pad + i * (cH - pad*2) / 4;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(cW-pad, y); ctx.stroke();
      const x = pad + i * (cW - pad*2) / 4;
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, cH-pad); ctx.stroke();
    }

    // Shadow / glow under route
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(toX(route[0][0]), toY(route[0][1]));
    for (let i=1; i<route.length; i++) ctx.lineTo(toX(route[i][0]), toY(route[i][1]));
    ctx.strokeStyle = 'rgba(${isCurrentJunior ? '0,128,128' : '46,125,50'},0.15)';
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    ctx.stroke();
    ctx.restore();

    // Colour gradient along route (progress: green→teal/dark)
    for (let i=1; i<route.length; i++) {
      const t = i / route.length;
      ctx.beginPath();
      ctx.moveTo(toX(route[i-1][0]), toY(route[i-1][1]));
      ctx.lineTo(toX(route[i][0]),   toY(route[i][1]));
      // interpolate colour
      const r1=${isCurrentJunior?'64':'76'}, g1=${isCurrentJunior?'224':'175'}, b1=${isCurrentJunior?'208':'80'};
      const r2=${isCurrentJunior?'0':'46'},  g2=${isCurrentJunior?'128':'125'}, b2=${isCurrentJunior?'128':'50'};
      const r=Math.round(r1+(r2-r1)*t), g=Math.round(g1+(g2-g1)*t), b=Math.round(b1+(b2-b1)*t);
      ctx.strokeStyle = \`rgb(\${r},\${g},\${b})\`;
      ctx.lineWidth   = 3;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.stroke();
    }

    // Direction arrows along route
    ctx.fillStyle = '${darkColor}';
    const arrowStep = Math.max(1, Math.floor(route.length / 6));
    for (let i=arrowStep; i<route.length-1; i+=arrowStep) {
      const ax = toX(route[i][0]), ay = toY(route[i][1]);
      const bx = toX(route[i+1][0]), by = toY(route[i+1][1]);
      const angle = Math.atan2(by-ay, bx-ax);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fill();
      ctx.restore();
    }

    // Start dot (green)
    const sx = toX(start[0]), sy = toY(start[1]);
    ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI*2);
    ctx.fillStyle = '#22c55e'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();

    // Finish dot (red)
    const fx = toX(finish[0]), fy = toY(finish[1]);
    ctx.beginPath(); ctx.arc(fx, fy, 8, 0, Math.PI*2);
    ctx.fillStyle = '#ef4444'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();

    // Distance label bottom-right
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('5km', cW - pad - 4, cH - 8);
  }

  drawRoute();
  window.addEventListener('resize', drawRoute);
})();
// ---- End Course Canvas ----
`;

  } else {
    // No route — minimal tile with expand button only
    courseTileHtml = `
<div id="course-terrain-section" class="iframe-container" style="text-align:center;padding:2rem 1.5rem;">
  <h2 class="section-title">Course &amp; Terrain</h2>
  <p style="color:#64748b;margin-bottom:1.25rem;font-size:0.95rem;">Course map data is not yet available for this event.</p>
  <button onclick="openCourseVideo()" class="action-btn" style="font-size:0.95rem;">&#9654; View Course Video</button>
</div>`;
    courseCanvasScript = '';
  }

  // ============================================================
  // FULL HTML TEMPLATE
  // ============================================================
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${pageTitle}</title>
<meta name="description" content="Visiting ${longName}? Compare nearby hotels, explore the course map, check the latest weather forecast and plan your perfect parkrun weekend." />
<meta name="author" content="Jake Lofthouse" />
<meta name="geo.placename" content="${location}" />
<meta name="geo.position" content="${latitude};${longitude}" />
<meta property="og:title" content="${pageTitle}" />
<meta property="og:description" content="Planning a visit to ${longName}? Discover nearby hotels, explore the course map, check the latest weather forecast and find local cafés." />
<meta property="og:url" content="https://www.parkrunnertourist.com/explore/${relativePath}" />
<meta property="og:type" content="article" />
<meta name="robots" content="index, follow" />
<meta name="language" content="en" />
<link rel="canonical" href="https://www.parkrunnertourist.com/explore/${relativePath}" />
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<meta name="apple-itunes-app" content="app-id=6743163993, app-argument=https://www.parkrunnertourist.com">
<link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-REFFZSK4XK"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-REFFZSK4XK');
</script>
<style>
* { box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  margin: 0; padding: 0;
  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  line-height: 1.6;
}
header {
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0 0%, #008080 100%' : '#2e7d32 0%, #1b5e20 100%'});
  color: white; padding: 1.5rem 2rem;
  font-weight: 600; font-size: 1.75rem;
  display: flex; justify-content: space-between; align-items: center;
  box-shadow: 0 4px 20px rgba(${isCurrentJunior ? '0,128,128' : '46,125,50'}, 0.3);
  position: relative; overflow: hidden;
}
header::before {
  content: '';
  position: absolute; top:0;left:0;right:0;bottom:0;
  background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="40" r="1.5" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="80" r="1" fill="rgba(255,255,255,0.1)"/></svg>');
  pointer-events: none;
}
header a { color:white;text-decoration:none;cursor:pointer;position:relative;z-index:1;transition:transform 0.3s ease; }
header a:hover { transform: translateY(-2px); }
.header-map-btn {
  padding: 0.5rem 1.25rem;
  background: rgba(255,255,255,0.2);
  border: 2px solid white; border-radius: 0.5rem;
  color: white; font-weight: 600; font-size: 1rem;
  cursor: pointer; transition: all 0.3s ease;
  position: relative; z-index: 1; text-decoration: none; display: inline-block;
}
.header-map-btn:hover {
  background: white; color: ${isCurrentJunior ? '#008080' : '#2e7d32'}; transform: translateY(-2px);
}
main { padding: 3rem 2rem; max-width: 1400px; margin: 0 auto; }
h1 {
  font-size: 7rem; font-weight: 800; margin-bottom: 0.5rem;
  background: linear-gradient(135deg, ${isCurrentJunior ? '#008080' : '#2e7d32'}, ${isCurrentJunior ? '#40e0d0' : '#4caf50'});
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  text-align: center; position: relative; padding: 2rem 0 1rem 0; line-height: 1.2;
}
.subtitle {
  font-size: 2rem; font-weight: 600; color: ${isCurrentJunior ? '#40e0d0' : '#4caf50'};
  text-align: center; margin-bottom: 3rem; position: relative;
}
.subtitle::after {
  content: ''; position: absolute; bottom: -1rem; left: 50%;
  transform: translateX(-50%); width: 100px; height: 4px;
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'}, ${isCurrentJunior ? '#008080' : '#2e7d32'});
  border-radius: 2px;
}
.description {
  background: white; padding: 2rem; border-radius: 1rem;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin-bottom: 3rem;
  border: 1px solid rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.2);
}
.description p { margin: 0; color: #374151; font-size: 1.1rem; }
.section-title {
  font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem;
  color: #1f2937; display: flex; align-items: center; gap: 0.5rem;
}
.section-title::before {
  content: ''; width: 4px; height: 1.5rem;
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'}, ${isCurrentJunior ? '#008080' : '#2e7d32'});
  border-radius: 2px;
}
.toggle-btn {
  padding: 0.75rem 1.5rem; border-radius: 0.75rem;
  margin-right: 1rem; margin-bottom: 1rem; cursor: pointer; font-weight: 600;
  border: 2px solid ${isCurrentJunior ? '#40e0d0' : '#4caf50'};
  transition: all 0.3s ease; background-color: white;
  color: ${isCurrentJunior ? '#40e0d0' : '#4caf50'};
  user-select: none; font-size: 1rem;
  box-shadow: 0 2px 10px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.2);
}
.toggle-btn:hover:not(.active) { background-color: #f1f8e9; box-shadow: 0 4px 15px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.3); }
.toggle-btn.active {
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'}, ${isCurrentJunior ? '#008080' : '#2e7d32'});
  color: white; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.4);
}
.content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 2rem; }
.iframe-container {
  background: white; border-radius: 1rem; padding: 1rem;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  border: 1px solid rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.2); overflow: hidden;
}
iframe { width: 100%; border-radius: 0.75rem; border: none; overflow: hidden; }
.weather-iframe { height: 300px; width: 100%; }
.accommodation-iframe { height: 600px; overflow-x: hidden; }
.map-iframe { height: 400px; }
.parkrun-actions { display: flex; gap: 1rem; margin-bottom: 3rem; flex-wrap: wrap; justify-content: center; }
.action-btn {
  padding: 0.75rem 1.5rem; border-radius: 0.75rem; cursor: pointer; font-weight: 600;
  border: 2px solid ${isCurrentJunior ? '#40e0d0' : '#4caf50'};
  transition: all 0.3s ease;
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'}, ${isCurrentJunior ? '#008080' : '#2e7d32'});
  color: white; text-decoration: none; display: inline-block; font-size: 1rem;
  box-shadow: 0 4px 15px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.3);
}
.action-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.4);
  background: linear-gradient(135deg, ${isCurrentJunior ? '#30d5c8' : '#388e3c'}, ${isCurrentJunior ? '#006666' : '#1b5e20'});
}
/* Course video modal */
.modal {
  display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%;
  background-color: rgba(0,0,0,0.6); backdrop-filter: blur(6px);
}
.modal-content {
  background-color: white; margin: 2% auto; padding: 0;
  border-radius: 1rem; width: 90%; max-width: 1000px; height: 90%;
  position: relative; box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'}, ${isCurrentJunior ? '#008080' : '#2e7d32'});
  color: white; padding: 1.25rem 2rem; border-radius: 1rem 1rem 0 0;
  display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
}
.modal-header h2 { font-size: 1.5rem; font-weight: 700; margin: 0; color: white; }
.close { color: white; font-size: 2.5rem; font-weight: bold; cursor: pointer; transition: transform 0.3s ease; line-height: 1; }
.close:hover { transform: scale(1.1); }
.modal iframe { width: 100%; flex: 1; border: none; border-radius: 0 0 1rem 1rem; min-height: 0; }
.nearby-list { list-style: none; padding: 0; margin: 0; }
.nearby-item { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 0.5rem; border-radius: 0.5rem; background: #f8fafc; transition: background 0.3s; }
.nearby-item:hover { background: #e2e8f0; }
.nearby-list a { color: ${isCurrentJunior ? '#40e0d0' : '#4caf50'}; text-decoration: none; font-weight: 500; transition: color 0.3s; }
.nearby-list a:hover { color: ${isCurrentJunior ? '#008080' : '#2e7d32'}; }
.distance { font-size: 0.9rem; color: #64748b; }
.cancel-banner { background: #ef4444; color: white; text-align: center; padding: 1rem; font-weight: bold; margin-bottom: 2rem; display: none; }
.status-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; font-size: 16px; margin-right: 8px; }
.green { background: #22c55e; color: white; }
.yellow { background: #eab308; color: white; }
.red { background: #ef4444; color: white; }
.cancel-tile p, .further-tile li { display: flex; align-items: center; }
.further-tile li { margin-bottom: 0.5rem; }
.last-update { font-size: 0.8rem; color: #64748b; margin-top: 0.5rem; }
.left-column { grid-column: 1; display: flex; flex-direction: column; gap: 2rem; }
.right-column { grid-column: 2; display: flex; flex-direction: column; gap: 2rem; }
.download-footer {
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0' : '#4caf50'} 0%, ${isCurrentJunior ? '#008080' : '#2e7d32'} 100%);
  padding: 3rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 1.5rem;
  color: white; font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 1px;
  position: relative; overflow: hidden;
}
.app-badges { display: flex; gap: 2rem; position: relative; z-index: 1; }
.download-footer img { height: 70px; width: auto; transition: transform 0.3s ease, filter 0.3s ease; cursor: pointer; border-radius: 0.5rem; }
.download-footer img:hover { transform: scale(1.1) translateY(-4px); filter: brightness(1.1); }
footer { text-align: center; padding: 2rem; background: #f8fafc; color: #64748b; font-weight: 500; }

@media (max-width: 1024px) {
  .content-grid { display: flex; flex-direction: column; gap: 1.5rem; }
  .left-column, .right-column { display: contents; }
  #cancel-tile { order: 1; } #further-tile { order: 2; }
  #weather-section { order: 3; } #location-section { order: 4; }
  #hotels-section { order: 5; } #experiences-section { order: 6; }
  #course-terrain-section { order: 7; } #nearby-section { order: 8; }
  .weather-iframe { height: 250px; }
  .accommodation-iframe, .map-iframe { height: 450px; }
  .app-badges { justify-content: center; }
  [data-name="BMC-Widget"] { display: none !important; }
}
@media (max-width: 768px) {
  main { padding: 2rem 1rem; }
  h1 { font-size: 5rem; }
  header { padding: 1rem; font-size: 1.5rem; }
  .toggle-btn { margin-bottom: 0.5rem; margin-right: 0.5rem; padding: 0.5rem 1rem; font-size: 0.9rem; }
  .app-badges { flex-direction: column; gap: 1rem; align-items: center; }
  .accommodation-iframe, .map-iframe { height: 400px; }
  .weather-iframe { height: 200px; }
  .modal-header h2 { font-size: 1.2rem; }
  .close { font-size: 2rem; }
  .header-map-btn { font-size: 0.85rem; padding: 0.4rem 1rem; }
}
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
  {
    "@type": "SportsEvent",
    "name": "${longName}",
    "description": "Visitor guide to ${longName}. Hotels, course map, weather forecast and travel information.",
    "sport": "Running",
    "eventAttendanceMode": "OfflineEventAttendanceMode",
    "location": {
      "@type": "Place",
      "name": "${location}",
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": "${latitude}",
        "longitude": "${longitude}"
      }
    },
    "url": "https://www.parkrunnertourist.com/explore/${relativePath}"
  },
  {
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "What is the weather like at ${longName} this week?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Check the 'Weather This Week' section for the forecast at 9am on the day of the event."
        }
      },
      {
        "@type": "Question",
        "name": "Where is ${longName} held?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "${longName} takes place at ${location}. See the parkrun Location map above for directions."
        }
      },
      {
        "@type": "Question",
        "name": "Where can I find hotels and rentals near ${longName}?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "The 'Hotels & Rentals' section lists nearby accommodations with list and map views for easy planning."
        }
      }
    ]
  }
  ]
}
</script>
</head>
<body>
<header>
  <a href="https://www.parkrunnertourist.com" target="_self" title="Go to ${siteName} homepage">${siteName}</a>
  <a href="https://www.parkrunnertourist.com/webapp" target="_blank" class="header-map-btn">Show Full Map</a>
</header>
<div id="cancel-banner" class="cancel-banner"></div>
<main>
  <h1>${longName} - Hotels &amp; Visitor Guide</h1>
  <div class="parkrun-actions">
    <button onclick="openCourseVideo()" class="action-btn">&#9654; Course Video</button>
    <a href="https://${parkrunDomain}/${eventSlug}/futureroster/" target="_blank" class="action-btn">Volunteer Roster</a>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}" target="_blank" class="action-btn">Directions</a>
  </div>
  ${hasDescription ? `<div class="description">${description}</div>` : ''}
  <div class="content-grid">
    <div class="left-column">
      <div id="hotels-section" class="iframe-container">
        <h2 class="section-title">Hotels &amp; Rentals</h2>
        <div>
          <button class="toggle-btn active" onclick="switchView('hotels','listview')" id="btn-listview-hotels">List View</button>
          <button class="toggle-btn" onclick="switchView('hotels','map')" id="btn-map-hotels">Map View</button>
        </div>
        <iframe id="stay22Frame" class="accommodation-iframe" scrolling="no"
          src="${stay22BaseUrl}&viewmode=listview&listviewexpand=true"
          title="Stay22 accommodation listing"></iframe>
      </div>
      <div id="experiences-section" class="iframe-container">
        <h2 class="section-title">Experiences</h2>
        <div>
          <button class="toggle-btn active" onclick="switchView('experiences','listview')" id="btn-listview-exp">List View</button>
          <button class="toggle-btn" onclick="switchView('experiences','map')" id="btn-map-exp">Map View</button>
        </div>
        <iframe id="stay22ExpFrame" class="accommodation-iframe" scrolling="no"
          src="${stay22ExpBaseUrl}&viewmode=listview&listviewexpand=true"
          title="Stay22 experiences listing"></iframe>
      </div>
    </div>
    <div class="right-column">
      <div id="location-section" class="iframe-container">
        <h2 class="section-title">parkrun Location</h2>
        <iframe class="map-iframe" data-src="${mainIframeUrl}" title="parkrun Map"></iframe>
      </div>
      <div id="weather-section" class="iframe-container">
        <h2 class="section-title">Weather This Week</h2>
        <iframe class="weather-iframe" data-src="${weatherIframeUrl}" title="Weather forecast for ${name}"></iframe>
      </div>
      ${courseTileHtml}
      ${nearbyHtml}
      <div id="cancel-tile" class="iframe-container cancel-tile" style="display:none;">
        <h2 class="section-title">Event Status</h2>
        <p id="cancel-message"></p>
        <div id="cancel-update" class="last-update"></div>
      </div>
      <div id="further-tile" class="iframe-container further-tile" style="display:none;">
        <h2 class="section-title">Future Cancellations</h2>
        <ul id="further-list"></ul>
        <div id="further-update" class="last-update"></div>
      </div>
    </div>
  </div>
</main>

<!-- Course Video Modal -->
<div id="courseVideoModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>&#9654; ${longName} — Course</h2>
      <span class="close" onclick="closeCourseVideo()">&times;</span>
    </div>
    <iframe id="courseVideoFrame" src="" title="Course video for ${longName}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>
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
  <p style="max-width:900px;margin:0 auto 1rem auto;font-size:0.85rem;line-height:1.5;color:#64748b;">
    parkrun is a registered trademark of parkrun Limited.
    This website is independent and is not affiliated with or endorsed by parkrun.
  </p>
  &copy; ${new Date().getFullYear()} ${siteName}
</footer>
<script data-name="BMC-Widget" data-cfasync="false" src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js" data-id="jlofthouse" data-description="Support me on Buy me a coffee!" data-message="Support The App" data-color="#40DCA5" data-position="Right" data-x_margin="18" data-y_margin="18"></script>
<script>
function switchView(type, mode) {
  const frameId = type === 'hotels' ? 'stay22Frame' : 'stay22ExpFrame';
  const baseUrl  = type === 'hotels' ? "${stay22BaseUrl}" : "${stay22ExpBaseUrl}";
  const iframe   = document.getElementById(frameId);
  iframe.src = baseUrl + "&viewmode=" + mode + "&listviewexpand=" + (mode === 'listview');
  document.getElementById('btn-listview-' + (type === 'hotels' ? 'hotels' : 'exp')).classList.toggle('active', mode === 'listview');
  document.getElementById('btn-map-'      + (type === 'hotels' ? 'hotels' : 'exp')).classList.toggle('active', mode === 'map');
}

function openCourseVideo() {
  const modal = document.getElementById('courseVideoModal');
  const frame = document.getElementById('courseVideoFrame');
  frame.src = "${courseVideoUrl}";
  modal.style.display = 'block';
  document.body.style.overflow = 'hidden';
}
function closeCourseVideo() {
  document.getElementById('courseVideoModal').style.display = 'none';
  document.getElementById('courseVideoFrame').src = '';
  document.body.style.overflow = 'auto';
}
window.addEventListener('click', function(e) {
  if (e.target.id === 'courseVideoModal') closeCourseVideo();
});

document.addEventListener('DOMContentLoaded', function() {
  // Lazy-load iframes
  const isBot = /bot|crawler|spider|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegram|slackbot|discord|googlebot|bingbot|yahoo|duckduckbot|baiduspider|yandexbot|applebot|ia_archiver|curl|wget|python-requests|scrapy|selenium|phantomjs|headless/i.test(navigator.userAgent);
  if (!isBot && 'IntersectionObserver' in window) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !entry.target.src) {
          entry.target.src = entry.target.dataset.src;
          obs.unobserve(entry.target);
        }
      });
    }, { rootMargin: '50px' });
    document.querySelectorAll('iframe[data-src]').forEach(f => obs.observe(f));
  } else if (!isBot) {
    setTimeout(() => {
      document.querySelectorAll('iframe[data-src]').forEach(f => { if (!f.src) f.src = f.dataset.src; });
    }, 1000);
  }

  // Cancellations
  async function fetchCancellations() {
    try {
      const [upcoming, further, lastUpdate] = await Promise.all([
        fetch('https://www.parkrunnertourist.com/cancellations/upcoming.json').then(r => r.json()),
        fetch('https://www.parkrunnertourist.com/cancellations/further.json').then(r => r.json()),
        fetch('https://www.parkrunnertourist.com/cancellations/lastupdate.json').then(r => r.json())
      ]);
      const eventName = '${longName}';
      const upcomingCancel = upcoming.find(c => c.name === eventName);
      const furtherCancels = further.filter(c => c.name === eventName);
      const cancelBanner  = document.getElementById('cancel-banner');
      const cancelTile    = document.getElementById('cancel-tile');
      const cancelMessage = document.getElementById('cancel-message');
      const cancelUpdate  = document.getElementById('cancel-update');
      const furtherTile   = document.getElementById('further-tile');
      const furtherList   = document.getElementById('further-list');
      const furtherUpdate = document.getElementById('further-update');
      const updateTime = lastUpdate.updated_utc ? new Date(lastUpdate.updated_utc).toLocaleString() : 'Unknown';
      cancelTile.style.display = 'block';
      cancelUpdate.textContent = 'Last updated: ' + updateTime;
      if (upcomingCancel) {
        cancelBanner.textContent = 'This event is cancelled on ' + upcomingCancel.date + ': ' + upcomingCancel.reason;
        cancelBanner.style.display = 'block';
        cancelMessage.innerHTML = '<span class="status-icon red">!</span> Cancelled: ' + upcomingCancel.reason + ' on ' + upcomingCancel.date;
      } else {
        cancelMessage.innerHTML = '<span class="status-icon green">✓</span> Event is running as scheduled';
      }
      if (furtherCancels.length > 0) {
        furtherTile.style.display = 'block';
        furtherUpdate.textContent = 'Last updated: ' + updateTime;
        furtherList.innerHTML = furtherCancels.map(c => '<li><span class="status-icon yellow">!</span> ' + c.reason + ' on ' + c.date + '</li>').join('');
      } else {
        furtherTile.style.display = 'none';
      }
    } catch (err) { console.error('Cancellations error:', err); }
  }
  fetchCancellations();

${courseCanvasScript}
});
</script>
</body>
</html>`;
}

// ============================================================
// SITEMAP
// ============================================================
function generateSitemap(eventPaths) {
  const today = new Date().toISOString().slice(0, 10);
  const urlset = eventPaths.map(p => {
    const clean = p.replace(/\.html$/, '').replace(/\/$/, '');
    return `<url>
  <loc>${BASE_URL}/${clean}</loc>
  <lastmod>${today}</lastmod>
  <changefreq>monthly</changefreq>
  <priority>0.8</priority>
</url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlset}
</urlset>`;
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function cleanupOldStructure() {
  try {
    if (fs.existsSync(OUTPUT_DIR)) {
      for (const item of fs.readdirSync(OUTPUT_DIR)) {
        const itemPath = path.join(OUTPUT_DIR, item);
        if (fs.statSync(itemPath).isFile() && item.endsWith('.html')) {
          fs.unlinkSync(itemPath);
          console.log(`Removed old file: ${itemPath}`);
        }
      }
    }
  } catch (e) { console.warn('Warning: cleanup failed:', e.message); }
}

function cleanupRemovedEvents(validSlugs) {
  for (const folder of fs.readdirSync(OUTPUT_DIR)) {
    const folderPath = path.join(OUTPUT_DIR, folder);
    if (fs.statSync(folderPath).isDirectory()) {
      for (const file of fs.readdirSync(folderPath)) {
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

// ============================================================
// MAIN
// ============================================================
async function main() {
  try {
    console.log('Fetching events JSON...');
    const data = await fetchJson(EVENTS_URL);

    let events;
    if (Array.isArray(data)) events = data;
    else if (Array.isArray(data.features)) events = data.features;
    else if (data.events && Array.isArray(data.events.features)) events = data.events.features;
    else throw new Error('Unexpected JSON structure');

    console.log('Fetching course maps...');
    let courseMaps = {};
    try {
      courseMaps = await fetchJson(COURSE_MAPS_URL);
      console.log(`Loaded ${Object.keys(courseMaps).length} course map entries.`);
    } catch (e) {
      console.warn('Could not load course maps:', e.message);
    }

    // Load folder mapping
    let folderMapping = {};
    try {
      folderMapping = JSON.parse(fs.readFileSync('./folder-mapping.json', 'utf-8'));
      console.log('Loaded folder mapping.');
    } catch (e) {
      console.warn('No folder mapping found, using dynamic folders.');
    }

    // Build complete events info
    const allEventsInfoComplete = events.map(event => ({
      slug:     slugify(event.properties.eventname),
      lat:      event.geometry.coordinates[1] || 0,
      lon:      event.geometry.coordinates[0] || 0,
      longName: event.properties.EventLongName || event.properties.eventname,
      country:  event.properties.countrycode
    }));

    const selectedEvents = events.slice(0, MAX_EVENTS);
    const eventPaths = [];
    const folderCounts = {};

    ensureDirectoryExists(OUTPUT_DIR);
    cleanupOldStructure();

    selectedEvents.sort((a, b) =>
      (a.properties.eventname || '').toLowerCase().localeCompare((b.properties.eventname || '').toLowerCase())
    );

    const validSlugs = new Set(selectedEvents.map(e => slugify(e.properties.eventname)));
    cleanupRemovedEvents(validSlugs);

    const slugToSubfolder = {};
    const allEventsInfo = [];

    for (const event of selectedEvents) {
      const slug = slugify(event.properties.eventname);
      let actualSubfolder = folderMapping[slug] || getSubfolder(slug);

      if (!folderCounts[actualSubfolder]) folderCounts[actualSubfolder] = 0;
      if (folderCounts[actualSubfolder] >= MAX_FILES_PER_FOLDER) {
        let suffix = 2;
        while (true) {
          const cand = `${actualSubfolder}${suffix}`;
          if (!folderCounts[cand]) folderCounts[cand] = 0;
          if (folderCounts[cand] < MAX_FILES_PER_FOLDER) { actualSubfolder = cand; break; }
          suffix++;
        }
      }

      folderCounts[actualSubfolder]++;
      slugToSubfolder[slug] = actualSubfolder;
      allEventsInfo.push({
        slug,
        lat:      event.geometry.coordinates[1] || 0,
        lon:      event.geometry.coordinates[0] || 0,
        longName: event.properties.EventLongName || event.properties.eventname,
        country:  event.properties.countrycode
      });
      eventPaths.push(`${actualSubfolder}/${slug}`);
    }

    // Complete slug→subfolder for nearby links
    const completeSlugToSubfolder = {};
    for (const event of events) {
      const slug = slugify(event.properties.eventname);
      completeSlugToSubfolder[slug] = folderMapping[slug] || getSubfolder(slug);
    }

    // Generate HTML for each event
    for (const event of selectedEvents) {
      const slug = slugify(event.properties.eventname);
      const actualSubfolder = slugToSubfolder[slug];
      const subfolderPath = path.join(OUTPUT_DIR, actualSubfolder);
      ensureDirectoryExists(subfolderPath);

      const filename     = path.join(subfolderPath, `${slug}.html`);
      const relativePath = `${actualSubfolder}/${slug}`;
      const htmlContent  = await generateHtml(event, relativePath, allEventsInfoComplete, completeSlugToSubfolder, courseMaps);
      fs.writeFileSync(filename, htmlContent, 'utf-8');
      console.log(`Generated: ${filename} (${folderCounts[actualSubfolder]}/${MAX_FILES_PER_FOLDER} in ${actualSubfolder})`);
    }

    // Write sitemap
    const sitemapContent = generateSitemap(eventPaths);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'sitemap.xml'), sitemapContent, 'utf-8');
    console.log('Sitemap written.');

    console.log('\nFolder distribution:');
    Object.entries(folderCounts).forEach(([f, c]) => console.log(`  ${f}: ${c} files`));
    console.log(`\nSuccessfully generated ${selectedEvents.length} event HTML files across ${Object.keys(folderCounts).length} folders.`);

  } catch (err) {
    console.error('Error:', err);
  }
}

main();
