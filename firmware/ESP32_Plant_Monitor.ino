//=============================================================
// ESP32 Plant Monitor - Relay version
// IoT-Based Agricultural Monitoring System
// Onayifeke Edison Oghenerunor (COT/6392/2019) & Otome Fortune (COT/6397/2019)
// Dept. of Electrical/Electronic Engineering, FUPRE - 2025
//
// NOTE: Replace WIFI_SSID, WIFI_PASS and scriptUrl with YOUR OWN values.
// Do NOT commit real credentials to a public repository.
//=============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <LiquidCrystal_I2C.h>

//====== CONFIG ======
const char* WIFI_SSID   = "YOUR_WIFI_SSID";        // <- change before flashing
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD";    // <- change before flashing
const char* scriptUrl   = "YOUR_GOOGLE_APPS_SCRIPT_URL"; // <- change before flashing
                                                      // (https://script.google.com/macros/s/.../exec)

// Pins
#define DHTPIN        4    // DHT11 data pin
#define DHTTYPE       DHT11
#define ONE_WIRE_BUS  16   // DS18B20 soil temperature
#define SOIL_PIN      36   // ADC1_CH0 (analog out of soil moisture sensor)
#define RELAY_PIN     26   // IN pin on relay module

// Objects
DHT dht(DHTPIN, DHTTYPE);
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);
LiquidCrystal_I2C lcd(0x27, 16, 2);

// Timing
unsigned long lastSend = 0;
const unsigned long SEND_INTERVAL = 1UL * 60UL * 1000UL;   // send to cloud every 1 minute

unsigned long pumpActivatedAt = 0;

// Pump thresholds and safety
const int DRY_THRESHOLD = 2200;  // soilRaw > DRY -> start pump (dry soil = high resistance)
const int WET_THRESHOLD = 1600;    // soilRaw < WET -> stop pump  (hysteresis)
const unsigned long MAX_PUMP_RUN_MS = 20UL * 1000UL;  // max run per activation (20 seconds)

// Relay active state
const bool RELAY_ACTIVE_LOW = true;

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("===== ESP32 Automatic Plant Watering System =====");

  dht.begin();
  ds18b20.begin();
  lcd.init();
  lcd.backlight();

  pinMode(RELAY_PIN, OUTPUT);
  // Ensure pump is OFF at startup (safety)
  if (RELAY_ACTIVE_LOW) digitalWrite(RELAY_PIN, HIGH);
  else                  digitalWrite(RELAY_PIN, LOW);

  // Wi-Fi connect
  lcd.setCursor(0, 0);
  lcd.print("WiFi Connecting");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! IP address: ");
  Serial.println(WiFi.localIP());
  lcd.clear();
  lcd.print("WiFi Connected");
  delay(900);
}

void loop() {
  // Read sensors
  float airHumidity = dht.readHumidity();
  float airTemp     = dht.readTemperature();
  ds18b20.requestTemperatures();
  float soilTemp    = ds18b20.getTempCByIndex(0);
  int soilRaw       = analogRead(SOIL_PIN);   // 0-4095

  // Detailed serial printout
  Serial.println("------------------------------------------------");
  Serial.println("Sensor Readings:");
  Serial.printf("Air Temp: %.1f C\n", airTemp);
  Serial.printf("Air Humidity: %.1f %%\n", airHumidity);
  Serial.printf("Soil Temp: %.1f C\n", soilTemp);
  Serial.printf("Soil Moisture (raw): %d\n", soilRaw);
  Serial.printf("Pump State: %s\n", isPumpOn() ? "ON" : "OFF");
  Serial.println("------------------------------------------------\n");

  // Pump control with hysteresis & max run timeout
  bool pumpIsOn = isPumpOn();
  if (!pumpIsOn && soilRaw > DRY_THRESHOLD) {
    setPump(true);
    pumpActivatedAt = millis();
    Serial.println("Soil is dry -> Pump turned ON");
  } else if (pumpIsOn && soilRaw < WET_THRESHOLD) {
    setPump(false);
    pumpActivatedAt = 0;
    Serial.println("Soil is wet -> Pump turned OFF");
  }

  // Safety timeout
  if (pumpIsOn && pumpActivatedAt > 0 && millis() - pumpActivatedAt > MAX_PUMP_RUN_MS) {
    Serial.println("Pump max runtime reached. Turning off.");
    setPump(false);
    pumpActivatedAt = 0;
  }

  // LCD update
  lcd.setCursor(0, 0);
  lcd.print("A:");
  if (!isnan(airTemp)) lcd.print(airTemp, 1); else lcd.print("--");
  lcd.print("C ");
  if (!isnan(airHumidity)) lcd.print(airHumidity, 0); else lcd.print("--");
  lcd.print("%");

  lcd.setCursor(0, 1);
  lcd.print("S:");
  if (!isnan(soilTemp)) lcd.print(soilTemp, 1); else lcd.print("--");
  lcd.print("C ");
  lcd.print("M:");
  lcd.print(soilRaw);
  lcd.print(" ");
  lcd.print(isPumpOn() ? "PON" : "OFF");

  // 1-min cloud send
  if (millis() - lastSend >= SEND_INTERVAL) {
    Serial.println("Sending data to Google Sheet...");
    sendToSheet(airTemp, airHumidity, soilTemp, soilRaw, isPumpOn());
    lastSend = millis();
  }

  delay(2000);
}

bool isPumpOn() {
  int out = digitalRead(RELAY_PIN);
  if (RELAY_ACTIVE_LOW) return (out == LOW);
  else                  return (out == HIGH);
}

void setPump(bool on) {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  }
  Serial.printf("Relay setPump(%s)\n", on ? "ON" : "OFF");
}

void sendToSheet(float airT, float airH, float soilT, int soilRaw, bool pump) {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  HTTPClient http;
  http.begin(scriptUrl);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"timestamp\":\"" + String("") + "\",";
  payload += "\"dht_temp\":"     + String(airT)    + ",";
  payload += "\"dht_humidity\":" + String(airH)    + ",";
  payload += "\"ds18b20_temp\":" + String(soilT)   + ",";
  payload += "\"soil_raw\":"     + String(soilRaw) + ",";
  payload += "\"pump_state\":"  + String(pump ? 1 : 0);
  payload += "}";

  int code = http.POST(payload);
  if (code > 0) {
    String resp = http.getString();
    Serial.printf("POST code %d, resp: %s\n", code, resp.c_str());
  } else {
    Serial.printf("POST failed, error: %s\n", http.errorToString(code).c_str());
  }

  http.end();
}