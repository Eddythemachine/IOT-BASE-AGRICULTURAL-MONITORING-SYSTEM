/************************************************************
 * FarmSense — Google Apps Script backend
 * IoT-Based Agricultural Monitoring System (FUPRE, 2025)
 *
 * DEPLOY (one-time):
 *   1. Create a Google Sheet → Extensions → Apps Script
 *   2. Paste this file, save
 *   3. Deploy → New deployment → Web app
 *      Execute as: Me | Access: Anyone
 *   4. Copy the /exec URL into the dashboard and the ESP32 firmware
 *
 * ENDPOINTS:
 *   POST (ESP32) : doPost logs a sensor reading row
 *   GET ?action=data&limit=N   : dashboard fetches latest N rows as JSON
 *   GET ?action=cmd&pump=1|0  : dashboard queues a manual pump command
 *   GET ?action=getcmd        : ESP32 polls this; returns pending command
 ************************************************************/

const SHEET_NAME = 'SensorData';

/* ---------- ESP32 POSTs sensor readings here ---------- */
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Air Temp (C)', 'Humidity (%)',
                   'Soil Temp (C)', 'Soil Raw', 'Pump State']);
  }
  const d = JSON.parse(e.postData.contents);
  sheet.appendRow([
    new Date(),
    d.dht_temp,
    d.dht_humidity,
    d.ds18b20_temp,
    d.soil_raw,
    d.pump_state
  ]);
  return json({ result: 'success' });
}

/* ---------- Dashboard / ESP32 GET requests ---------- */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'data';

  // Dashboard: queue a manual pump override
  if (action === 'cmd') {
    const pump = e.parameter.pump === '1' ? '1' : '0';
    PropertiesService.getScriptProperties().setProperty('PUMP_COMMAND', pump);
    PropertiesService.getScriptProperties().setProperty('PUMP_COMMAND_AT', Date.now());
    return json({ result: 'ok', pump: pump });
  }

  // ESP32: poll for a pending manual command (see note at bottom)
  if (action === 'getcmd') {
    const cmd = PropertiesService.getScriptProperties().getProperty('PUMP_COMMAND') || '';
    return json({ pump: cmd });
  }

  // Dashboard: latest N readings
  const limit = parseInt(e.parameter.limit || '100', 10);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const values = sheet ? sheet.getDataRange().getValues() : [];
  const data = values.slice(1)               // drop header
                      .slice(-limit)         // keep most recent N
                      .map(r => ({
                        timestamp:    r[0],
                        dht_temp:     r[1],
                        dht_humidity: r[2],
                        ds18b20_temp: r[3],
                        soil_raw:     r[4],
                        pump_state:   r[5]
                      }));
  return json({ data: data });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

/************************************************************
 * NOTE — manual pump override:
 * The web dashboard queues commands via ?action=cmd. For the
 * ESP32 to act on them, add this inside loop() in the firmware
 * (upload interval only, not every 2 s pass):
 *
 *   if (millis() - lastCmdPoll > 30000) {
 *     lastCmdPoll = millis();
 *     HTTPClient http;
 *     http.begin(String(scriptUrl) + "?action=getcmd");
 *     int code = http.GET();
 *     if (code == 200) {
 *       String body = http.getString();          // {"pump":"1"} or {"pump":"0"} or ""
 *       if (body.indexOf("\"1\"") > 0)      setPump(true);
 *       else if (body.indexOf("\"0\"") > 0) setPump(false);
 *     }
 *     http.end();
 *   }
 *
 * with `unsigned long lastCmdPoll = 0;` declared at the top.
 ************************************************************/
