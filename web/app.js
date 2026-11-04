/* ============================================================
   FarmSense Dashboard — front-end logic
   IoT-Based Agricultural Monitoring System (FUPRE, 2025)
   Fetches sensor data from the Google Apps Script endpoint
   (?action=data) and sends pump commands (?action=cmd).
   Falls back to built-in demo data when no URL is configured.
   ============================================================ */

'use strict';

// ---------- Configuration ----------
const CONFIG_KEY = 'farmsense_api_url';
let API_URL = localStorage.getItem(CONFIG_KEY) || '';
let chartRefs = {};
let currentData = [];

// Thresholds (must match ESP32 firmware)
const DRY_THRESHOLD = 2200;  // raw > 2200 -> soil dry
const WET_THRESHOLD = 1600;   // raw < 1600 -> soil wet

const REFRESH_MS = 60 * 1000; // auto-refresh every minute

// ---------- Demo dataset (48 h of realistic data) ----------
function demoData() {
  const out = [];
  const now = Date.now();
  const STEP_MIN = 15;
  const POINTS = (48 * 60) / STEP_MIN; // 192 points
  for (let i = POINTS; i >= 0; i--) {
    const t = now - i * STEP_MIN * 60 * 1000;
    const h = new Date(t).getHours();
    // Diurnal air temperature: peak ~18:00, min ~06:00 (thermal lag)
    const airTemp = 31 + 2 * Math.sin(((h - 6) / 24) * 2 * Math.PI);
    const humidity = Math.min(100, Math.max(60, 90 + 5 * Math.sin(((h - 3) / 24) * 2 * Math.PI)));
    // Soil temperature: buffered, lags air
    const soilTemp = 28.7 + 0.8 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
    // Soil moisture: wet/dry cycles crossing the thresholds (lower = wetter)
    const soilRaw = Math.round(2400 + 1400 * Math.sin((t / (24 * 60 * 60 * 1000)) * 2 * Math.PI * 2.2));
    const pump = soilRaw > DRY_THRESHOLD ? 1 : 0;
    out.push({
      timestamp: new Date(t).toISOString(),
      dht_temp: +airTemp.toFixed(1),
      dht_humidity: +humidity.toFixed(1),
      ds18b20_temp: +soilTemp.toFixed(1),
      soil_raw: soilRaw,
      pump_state: pump
    });
  }
  return out;
}

// ---------- Helpers ----------
function moistureStatus(raw) {
  if (raw >= 4090) return { label: 'Open circuit', cls: 'status-dry' };
  if (raw > DRY_THRESHOLD) return { label: 'Dry', cls: 'status-dry' };
  if (raw >= WET_THRESHOLD) return { label: 'Moist', cls: 'status-moist' };
  return { label: 'Wet', cls: 'status-wet' };
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function fmtShort(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------- Data loading ----------
async function fetchData() {
  const limit = document.getElementById('rowLimit').value;
  if (!API_URL) {
    setBadge(false);
    return demoData();
  }
  try {
    const res = await fetch(`${API_URL}?action=data&limit=${limit}`, { redirect: 'follow' });
    const json = await res.json();
    setBadge(true);
    if (!json.data || !json.data.length) {
      console.warn('Endpoint returned no rows.');
      return demoData();
    }
    return json.data;
  } catch (err) {
    console.error('Fetch failed, falling back to demo data:', err);
    setBadge(false);
    return demoData();
  }
}

function setBadge(live) {
  const b = document.getElementById('connBadge');
  b.textContent = live ? '● LIVE' : 'DEMO DATA';
  b.className = 'badge ' + (live ? 'live' : 'demo');
}

// ---------- Rendering ----------
function renderCards(rows) {
  const latest = rows[rows.length - 1];
  document.getElementById('cardAirTemp').textContent = latest.dht_temp ?? '--';
  document.getElementById('cardHumidity').textContent = latest.dht_humidity ?? '--';
  document.getElementById('cardSoilTemp').textContent = latest.ds18b20_temp ?? '--';
  document.getElementById('cardMoisture').textContent = latest.soil_raw ?? '--';
  const st = moistureStatus(latest.soil_raw);
  document.getElementById('moistStatus').textContent = st.label;
  document.getElementById('moistStatus').className = st.cls;

  const pumpOn = Number(latest.pump_state) === 1;
  document.getElementById('cardPump').textContent = pumpOn ? 'ON' : 'OFF';
  document.getElementById('pumpCard').classList.toggle('on', pumpOn);

  document.getElementById('lastUpdate').textContent = 'Last reading: ' + fmtTime(latest.timestamp);
}

const CHART_OPTS = {
  responsive: true, maintainAspectRatio: false,
  animation: false, resizeDelay: 100,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { maxTicksLimit: 10, font: { size: 10 } }, grid: { display: false } },
    y: { ticks: { font: { size: 10 } } }
  }
};

function lineDataset(label, data, color, fill = false) {
  return {
    label, data, borderColor: color, backgroundColor: color + '22',
    borderWidth: 2, pointRadius: 0, tension: 0.3, fill
  };
}

function renderCharts(rows) {
  const labels = rows.map(r => fmtShort(r.timestamp));
  const datasets = {
    tempChart: [
      lineDataset('Air (DHT11)', rows.map(r => r.dht_temp), '#15803d'),
      lineDataset('Soil (DS18B20)', rows.map(r => r.ds18b20_temp), '#b45309')
    ],
    humChart: [lineDataset('Humidity %', rows.map(r => r.dht_humidity), '#0369a1', true)],
    moistChart: [
      lineDataset('Soil raw (lower = wetter)', rows.map(r => r.soil_raw), '#7c3aed'),
      lineDataset('DRY threshold (2200)', rows.map(() => DRY_THRESHOLD), '#dc2626'),
      lineDataset('WET threshold (1600)', rows.map(() => WET_THRESHOLD), '#0369a1')
    ],
    pumpChart: [{
      label: 'Pump (1=ON, 0=OFF)',
      data: rows.map(r => Number(r.pump_state)),
      borderColor: '#0ea5e9', backgroundColor: '#0ea5e955',
      borderWidth: 2, pointRadius: 0, stepped: true, fill: true
    }]
  };
  for (const [id, ds] of Object.entries(datasets)) {
    const canvas = document.getElementById(id);
    if (!canvas || typeof Chart === 'undefined') continue;
    if (chartRefs[id]) { chartRefs[id].destroy(); }
    chartRefs[id] = new Chart(canvas.getContext('2d'), { type: 'line', data: { labels, datasets: ds }, options: CHART_OPTS });
  }
}

function renderTable(rows) {
  const tbody = document.querySelector('#dataTable tbody');
  tbody.innerHTML = '';
  const reversed = [...rows].reverse(); // newest first
  reversed.forEach((r, i) => {
    const st = moistureStatus(r.soil_raw);
    const pumpOn = Number(r.pump_state) === 1;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${reversed.length - i}</td>` +
      `<td>${fmtTime(r.timestamp)}</td>` +
      `<td>${r.dht_temp ?? '--'}</td>` +
      `<td>${r.dht_humidity ?? '--'}</td>` +
      `<td>${r.ds18b20_temp ?? '--'}</td>` +
      `<td>${r.soil_raw ?? '--'}</td>` +
      `<td class="${st.cls}">${st.label}</td>` +
      `<td class="${pumpOn ? 'pump-on' : 'pump-off'}">${pumpOn ? 'ON' : 'OFF'}</td>`;
    tbody.appendChild(tr);
  });
}

async function refresh() {
  currentData = await fetchData();
  if (!currentData.length) return;
  renderCards(currentData);
  renderCharts(currentData);
  renderTable(currentData);
}

// ---------- Pump override ----------
async function sendPumpCommand(on) {
  const msg = document.getElementById('pumpMsg');
  if (!API_URL) {
    msg.textContent = 'Connect your Apps Script URL first (demo mode is read-only).';
    return;
  }
  const val = on ? 1 : 0;
  msg.textContent = 'Sending command…';
  try {
    const res = await fetch(`${API_URL}?action=cmd&pump=${val}`, { redirect: 'follow' });
    const json = await res.json();
    msg.textContent = json.result === 'ok'
      ? `Pump command "${on ? 'ON' : 'OFF'}" queued. The ESP32 will apply it on its next poll.`
      : 'Command rejected by server.';
  } catch (err) {
    msg.textContent = 'Command failed: ' + err.message;
  }
}

// ---------- PDF export (browser print-to-PDF) ----------
function exportPDF() {
  window.print();
}

// ---------- Wiring ----------
document.getElementById('apiUrl').value = API_URL;
document.getElementById('saveConfig').addEventListener('click', () => {
  API_URL = document.getElementById('apiUrl').value.trim();
  if (API_URL) {
    localStorage.setItem(CONFIG_KEY, API_URL);
    document.getElementById('pumpMsg').textContent = '';
    refresh();
  }
});
document.getElementById('useDemo').addEventListener('click', () => {
  API_URL = '';
  localStorage.removeItem(CONFIG_KEY);
  document.getElementById('apiUrl').value = '';
  document.getElementById('pumpMsg').textContent = '';
  refresh();
});
document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('rowLimit').addEventListener('change', refresh);
document.getElementById('pdfBtn').addEventListener('click', exportPDF);
document.getElementById('pumpOn').addEventListener('click', () => sendPumpCommand(true));
document.getElementById('pumpOff').addEventListener('click', () => sendPumpCommand(false));

// ---------- Go ----------
refresh();
setInterval(refresh, REFRESH_MS);
