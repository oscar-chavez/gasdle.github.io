/* ===========================================================================
   gasdle · pick-daily.js
   ---------------------------------------------------------------------------
   Runs ONCE A DAY on a server (cron job or free GitHub Action). It:
     1. picks a random populated U.S. area,
     2. asks Google Places (New) for nearby gas stations + their fuelOptions,
     3. keeps only stations that actually report a REGULAR_UNLEADED price,
     4. picks one, and writes ./daily.json for the front-end to load.

   Why server-side: every visitor must get the SAME daily puzzle, the answer
   must NOT sit in the browser for anyone to read, and this uses your SECRET
   key (no referrer restriction). Never ship this key to the browser.

   SETUP
     • Node 18+ (uses built-in fetch).
     • Create a Google Cloud project, enable "Places API (New)", make an API key.
     • Put it in an env var:  export GOOGLE_SERVER_KEY="AIza...."
     • Run:  node pick-daily.js   (schedule it daily — see README.md)
   =========================================================================== */

const fs = require("fs");

const API_KEY = process.env.GOOGLE_SERVER_KEY;          // <-- secret, server only
if (!API_KEY) { console.error("Set GOOGLE_SERVER_KEY"); process.exit(1); }

// Seed points = real, populated areas so we don't land in an empty rural ZIP.
// Add/trim freely. Each run shuffles these and walks them until a priced station appears.
const SEED_POINTS = [
  ["San Diego, CA", 32.72, -117.16], ["Los Angeles, CA", 34.05, -118.24],
  ["Sacramento, CA", 38.58, -121.49], ["Seattle, WA", 47.61, -122.33],
  ["Portland, OR", 45.52, -122.68], ["Phoenix, AZ", 33.45, -112.07],
  ["Las Vegas, NV", 36.17, -115.14], ["Denver, CO", 39.74, -104.99],
  ["Salt Lake City, UT", 40.76, -111.89], ["Albuquerque, NM", 35.08, -106.65],
  ["Houston, TX", 29.76, -95.37], ["Dallas, TX", 32.78, -96.80],
  ["San Antonio, TX", 29.42, -98.49], ["Oklahoma City, OK", 35.47, -97.52],
  ["Tulsa, OK", 36.15, -95.99], ["Little Rock, AR", 34.74, -92.29],
  ["New Orleans, LA", 29.95, -90.07], ["Atlanta, GA", 33.75, -84.39],
  ["Miami, FL", 25.76, -80.19], ["Orlando, FL", 28.54, -81.38],
  ["Charlotte, NC", 35.23, -80.84], ["Nashville, TN", 36.16, -86.78],
  ["Chicago, IL", 41.88, -87.63], ["Indianapolis, IN", 39.77, -86.16],
  ["Columbus, OH", 39.96, -83.00], ["Detroit, MI", 42.33, -83.05],
  ["Minneapolis, MN", 44.98, -93.27], ["Des Moines, IA", 41.59, -93.62],
  ["St. Louis, MO", 38.63, -90.20], ["Kansas City, MO", 39.10, -94.58],
  ["Madison, WI", 43.07, -89.40], ["Boston, MA", 42.36, -71.06],
  ["New York, NY", 40.71, -74.01], ["Philadelphia, PA", 39.95, -75.17],
  ["Pittsburgh, PA", 40.44, -79.99], ["Baltimore, MD", 39.29, -76.61]
];

// Approx state gasoline tax (¢/gal) — ILLUSTRATIVE; refresh from a real table at launch.
const STATE_TAX = {AL:29,AK:9,AZ:18,AR:25,CA:60,CO:22,CT:25,DE:23,FL:43,GA:33,HI:50,
  ID:33,IL:67,IN:34,IA:30,KS:24,KY:28,LA:20,ME:30,MD:47,MA:24,MI:47,MN:31,MS:18,MO:27,
  MT:33,NE:29,NV:51,NH:24,NJ:42,NM:19,NY:48,NC:41,ND:23,OH:39,OK:20,OR:40,PA:59,RI:37,
  SC:28,SD:30,TN:26,TX:20,UT:37,VT:32,VA:30,WA:49,WV:36,WI:33,WY:24,DC:29};

const REGION = {
  Northeast:["ME","NH","VT","MA","RI","CT","NY","NJ","PA"],
  Southeast:["DE","MD","DC","VA","WV","NC","SC","GA","FL"],
  Midwest:["OH","IN","IL","MI","WI","MN","IA","MO","ND","SD","NE","KS"],
  "South Central":["TX","OK","AR","LA","MS","AL","TN","KY"],
  "Mountain West":["MT","ID","WY","NV","UT","CO"],
  Southwest:["AZ","NM"], "West Coast":["CA"], "Pacific Northwest":["WA","OR"],
  Noncontiguous:["AK","HI"]
};
function regionOf(st){ for (const r in REGION) if (REGION[r].includes(st)) return r; return "the U.S."; }

const BRANDS = ["ARCO","Shell","Chevron","Costco","Sam's Club","Mobil","Exxon","76",
  "Valero","Texaco","Sinclair","Conoco","Phillips 66","Marathon","BP","Speedway",
  "Circle K","QuikTrip","QT","Wawa","Sheetz","Casey's","Kwik Trip","Maverik","RaceTrac",
  "Murphy","H-E-B","Safeway","Kroger","Sunoco","Citgo","Gulf","Cumberland Farms","Cenex",
  "Pilot","Love's","Flying J","Buc-ee's","Meijer","Get Go"];
function brandOf(name){ const hit = BRANDS.find(b => name.toLowerCase().includes(b.toLowerCase())); return hit || name; }

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]];} return a; }
function moneyToNumber(m){ return m ? Number(m.units||0) + (m.nanos||0)/1e9 : null; }
function compOf(place, type){ const c=(place.addressComponents||[]).find(x=>x.types?.includes(type)); return c ? (c.shortText||c.longText) : null; }

async function nearbyGasStations(lat, lng){
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Goog-Api-Key":API_KEY,
      // fuelOptions is the price field. Keep this mask tight — it sets your billing SKU.
      "X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.fuelOptions"
    },
    body:JSON.stringify({
      includedTypes:["gas_station"],
      maxResultCount:20,
      locationRestriction:{ circle:{ center:{latitude:lat,longitude:lng}, radius:6000 } }
    })
  });
  if(!res.ok){ console.warn("Places error", res.status, await res.text()); return []; }
  return (await res.json()).places || [];
}

function regularPrice(place){
  const fp = place.fuelOptions?.fuelPrices || [];
  const reg = fp.find(p => p.type === "REGULAR_UNLEADED");
  return reg ? { price: moneyToNumber(reg.price), currency: reg.price?.currencyCode || "USD", updateTime: reg.updateTime } : null;
}

(async () => {
  for (const [label, lat, lng] of shuffle([...SEED_POINTS])) {
    const places = await nearbyGasStations(lat, lng);
    const priced = places
      .map(p => ({ p, reg: regularPrice(p) }))
      .filter(x => x.reg && x.reg.price > 0);
    if (!priced.length) { console.log("no priced stations near", label, "— trying next"); continue; }

    const { p, reg } = priced[(Math.random()*priced.length)|0];
    const state = compOf(p, "administrative_area_level_1");
    const city  = compOf(p, "locality") || compOf(p, "sublocality") || "";
    const loc   = p.location;

    const daily = {
      puzzle: Math.floor(Date.now()/86400000),
      date: new Date().toISOString().slice(0,10),
      placeId: p.id,
      name: p.displayName?.text || "Gas station",
      brand: brandOf(p.displayName?.text || ""),
      address: p.formattedAddress || "",
      city, state,
      region: regionOf(state),
      lat: loc.latitude, lng: loc.longitude,
      price: Math.round(reg.price*100)/100,   // <-- the answer (regular)
      currency: reg.currency,
      tax: STATE_TAX[state] ?? null,
      priceUpdated: reg.updateTime
    };

    fs.writeFileSync("daily.json", JSON.stringify(daily, null, 2));
    console.log("Wrote daily.json:", daily.brand, "·", city, state, "· $"+daily.price);
    return;
  }
  console.error("Could not find any station with a regular price today.");
  process.exit(1);
})();
