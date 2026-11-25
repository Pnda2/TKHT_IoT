#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <DHT.h>
#include <Preferences.h>
#include <time.h>
#include <math.h>
#include <esp_timer.h>

// =================== CẤU HÌNH WIFI ===================
const char* ssid     = "TuanTrinh";
const char* password = "mangdanghong";

// =================== CẤU HÌNH TELEGRAM BOT ===================
// LƯU Ý BẢO MẬT: Điền Bot Token và Chat ID của bạn ở đây khi nạp code vào board.
// Không commit mã token thật lên GitHub công khai để tránh bị lộ.
const char* const TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const char* const TELEGRAM_CHAT_ID   = "YOUR_TELEGRAM_CHAT_ID";

// =================== CẤU HÌNH CHÂN (S - V - G) ===================
#define PIN_OLED_SDA      21   // D21 (Cột S)
#define PIN_OLED_SCL      22   // D22 (Cột S)
#define PIN_SOIL_ADC      34   // D34 (Cột S - Cảm biến độ ẩm đất)
#define PIN_WATER_ADC     35   // D35 (Cột S - Cảm biến đo mực nước bình chứa)
#define PIN_RELAY         23   // D23 (Cột S - Relay máy bơm)
#define PIN_TOUCH         4    // D4  (Cột S - Nút cảm ứng TTP223)
#define PIN_DHT           15   // D15 (Cột S - Cảm biến DHT22)

#define DHTTYPE           DHT22

// Relay Active LOW
#define RELAY_ON          LOW
#define RELAY_OFF         HIGH

#define MAX_PUMP_SECONDS  60 
#define WATER_EMPTY_THRESHOLD 15 // Dưới 15% nước là báo động cạn

// =================== KHỞI TẠO ĐỐI TƯỢNG ===================
Adafruit_SH1106G display(128, 64, &Wire, -1);
DHT dht(PIN_DHT, DHTTYPE);
WebServer server(80);
Preferences prefs;

// =================== BIẾN TOÀN CỤC ===================
bool isAutoMode = true;
bool isPumpOn = false;
bool oledFound = false;
bool isWaterAvailable = false;
bool isPumpTimeoutAlert = false;
bool preferencesReady = false;
bool cutoffReady = false;
portMUX_TYPE relayLock = portMUX_INITIALIZER_UNLOCKED;
esp_timer_handle_t pumpWatchdog = nullptr;
bool relayArmed = false;
bool cutoffPending = false;
int64_t relayDeadlineUs = 0;
bool flowAnomaly = false;
bool flowConfirmed = false;
bool dhtValid = false;
int aiDryMinutes = -1;
int flowStartSoil = 0;
int flowStartWater = 100;
unsigned long flowWindowStart = 0;
const unsigned long FLOW_CHECK_INTERVAL = 12000;
const int FLOW_DELTA_PERCENT = 2; // Loai nhieu ADC nho, can hieu chuan thuc te.

int soilDryThreshold = 40;
int soilWetThreshold = 65;

float airTemp = 0.0;
float airHumidity = 0.0;
int soilPercent = 0;
int soilRaw = 0;

int waterPercent = 100;
int waterRaw = 0;

bool touchState = LOW;
unsigned long pumpStartTime = 0;
unsigned long pumpDurationSeconds = 0;

unsigned long lastSensorRead = 0;
unsigned long lastWaterRead = 0;
unsigned long lastOledUpdate = 0;
const unsigned long SENSOR_INTERVAL = 2000; // DHT22 yeu cau chu ky doc toi thieu 2 giay
const unsigned long OLED_INTERVAL   = 300;
const unsigned long WATER_INTERVAL  = 200;

bool lastTouchState = LOW;
bool rawTouchState = LOW;
unsigned long touchChangedAt = 0;
bool staOnline = false;
bool fallbackAp = false;
unsigned long staDisconnectedAt = 0;
unsigned long lastWifiRetry = 0;

// Timer task owns only the physical cutoff; loop owns the application state.
void pumpWatchdogTick(void*) {
  portENTER_CRITICAL(&relayLock);
  if (relayArmed && esp_timer_get_time() >= relayDeadlineUs) {
    gpio_set_level(static_cast<gpio_num_t>(PIN_RELAY), RELAY_OFF);
    relayArmed = false;
    cutoffPending = true;
  }
  portEXIT_CRITICAL(&relayLock);
}

// =================== GỬI THÔNG BÁO TELEGRAM (ASYNC) ===================
volatile bool telegramTaskRunning = false;

struct TelegramMessage {
  char text[384];
};

void sendTelegramTask(void* parameter) {
  TelegramMessage* msg = static_cast<TelegramMessage*>(parameter);
  if (WiFi.status() == WL_CONNECTED && msg != nullptr) {
    WiFiClientSecure client;
    client.setInsecure(); // Bo qua xac thuc chung chi SSL de toi uu RAM
    client.setTimeout(6); // 6 giay timeout

    HTTPClient https;
    String url = "https://api.telegram.org/bot";
    url += TELEGRAM_BOT_TOKEN;
    url += "/sendMessage";

    if (https.begin(client, url)) {
      https.addHeader("Content-Type", "application/json");

      String payload = "{\"chat_id\":\"";
      payload += TELEGRAM_CHAT_ID;
      payload += "\",\"text\":\"";
      
      const char* p = msg->text;
      while (*p) {
        if (*p == '"') payload += "\\\"";
        else if (*p == '\\') payload += "\\\\";
        else if (*p == '\n') payload += "\\n";
        else if (*p == '\r') { /* bo qua */ }
        else if (*p == '\t') payload += "\\t";
        else payload += *p;
        p++;
      }
      payload += "\",\"parse_mode\":\"HTML\"}";

      int httpResponseCode = https.POST(payload);
      if (httpResponseCode > 0) {
        Serial.printf("[TELEGRAM] Da gui tin nhan, HTTP: %d\n", httpResponseCode);
      } else {
        Serial.printf("[TELEGRAM] Loi gui tin nhan: %d\n", httpResponseCode);
      }
      https.end();
    }
    client.stop();
  }
  if (msg) delete msg;
  telegramTaskRunning = false;
  vTaskDelete(NULL);
}

void notifyTelegram(const char* message) {
  if (WiFi.status() != WL_CONNECTED || telegramTaskRunning) return;
  if (strcmp(TELEGRAM_BOT_TOKEN, "YOUR_TELEGRAM_BOT_TOKEN") == 0) return;

  TelegramMessage* msg = new TelegramMessage();
  if (!msg) return;
  strncpy(msg->text, message, sizeof(msg->text) - 1);
  msg->text[sizeof(msg->text) - 1] = '\0';

  telegramTaskRunning = true;
  BaseType_t res = xTaskCreatePinnedToCore(
    sendTelegramTask,
    "teleTask",
    8192,
    msg,
    1,
    NULL,
    0 // Chay tren Core 0 khong lam cham loop chinh tren Core 1
  );
  if (res != pdPASS) {
    telegramTaskRunning = false;
    delete msg;
  }
}

void syncPumpCutoff() {
  portENTER_CRITICAL(&relayLock);
  const bool cut = cutoffPending;
  cutoffPending = false;
  portEXIT_CRITICAL(&relayLock);
  if (cut) {
    isPumpOn = false;
    pumpDurationSeconds = 0;
    isPumpTimeoutAlert = true;
    char timeoutMsg[256];
    snprintf(timeoutMsg, sizeof(timeoutMsg),
      "🚨 <b>CẢNH BÁO: BƠM TỰ NGẮT SAU 60 GIÂY!</b>\n"
      "Hệ thống đã cưỡng chế tắt bơm để bảo vệ máy.\n"
      "🪴 Độ ẩm đất: %d%% | 🚰 Nước: %d%%\n"
      "👉 Vui lòng kiểm tra lại bồn cây trước khi bật lại.",
      soilPercent, waterPercent);
    notifyTelegram(timeoutMsg);
  }
}

int readMedianAdc(int pin) {
  int samples[5];
  for (int i = 0; i < 5; ++i) {
    const int value = analogRead(pin);
    int j = i;
    for (; j > 0 && samples[j - 1] > value; --j) samples[j] = samples[j - 1];
    samples[j] = value;
  }
  return samples[2];
}

bool validThresholds(int dry, int wet) {
  return dry >= 10 && dry <= 60 && wet >= 50 && wet <= 95 && dry < wet;
}

// Hoi quy toc do mat am (%/phut), suy luan offline, khong goi Cloud.
// He so khoi tao theo kinh nghiem; can hieu chuan bang du lieu vuon thuc te.
// -1 = DHT khong hop le; 0 = dat da cham nguong kho 40%.
int predictMinutesToDry(float temp, float hum, int soil) {
  if (soil <= 40) return 0;
  if (!isfinite(temp) || !isfinite(hum) || temp < -40 || temp > 80 || hum < 0 || hum > 100) return -1;
  float lossRate = 0.12f + 0.008f * (temp - 25.0f) - 0.0012f * (hum - 60.0f);
  lossRate = constrain(lossRate, 0.02f, 0.8f);
  return constrain((int)ceilf((soil - 40) / lossRate), 1, 4320);
}

// So sanh bien thien tich luy trong tung cua so, khong so tung mau de tranh nhieu.
void checkFlowAnomaly() {
  if (!isPumpOn) return;
  bool progress = soilPercent - flowStartSoil >= FLOW_DELTA_PERCENT ||
                  flowStartWater - waterPercent >= FLOW_DELTA_PERCENT;
  if (progress) {
    flowConfirmed = true;
    flowStartSoil = soilPercent;
    flowStartWater = waterPercent;
    flowWindowStart = millis();
  } else if (millis() - flowWindowStart > FLOW_CHECK_INTERVAL) {
    if (!flowAnomaly) {
      char anomalyMsg[256];
      snprintf(anomalyMsg, sizeof(anomalyMsg),
        "⚠️ <b>CẢNH BÁO DÒNG NƯỚC BẤT THƯỜNG!</b>\n"
        "Bơm đã bật hơn 12s nhưng độ ẩm đất không tăng và nước bình không giảm.\n"
        "👉 Kiểm tra ngay: tuột ống dẫn, kẹt cánh quạt hoặc cảm biến rơi!");
      notifyTelegram(anomalyMsg);
    }
    flowAnomaly = true; // Giu canh bao den lan bat bom tiep theo.
    flowConfirmed = false;
  }
}

// =================== BẬT / TẮT BƠM AN TOÀN ===================
void setPump(bool state) {
  if (state && (!isWaterAvailable || !cutoffReady)) return;
  portENTER_CRITICAL(&relayLock);
  // A cutoff racing with a command must be processed before any restart.
  if (cutoffPending || state == isPumpOn) {
    portEXIT_CRITICAL(&relayLock);
    syncPumpCutoff();
    return;
  }
  relayArmed = state;
  if (state) relayDeadlineUs = esp_timer_get_time() + MAX_PUMP_SECONDS * 1000000LL;
  gpio_set_level(static_cast<gpio_num_t>(PIN_RELAY), state ? RELAY_ON : RELAY_OFF);
  portEXIT_CRITICAL(&relayLock);
  const bool previousPumpState = isPumpOn;
  isPumpOn = state;

  if (isPumpOn) {
    pumpStartTime = millis();
    isPumpTimeoutAlert = false;
    flowAnomaly = false;
    flowConfirmed = false;
    flowStartSoil = soilPercent;
    flowStartWater = waterPercent;
    flowWindowStart = pumpStartTime;

    char pumpOnMsg[256];
    snprintf(pumpOnMsg, sizeof(pumpOnMsg),
      "💧 <b>Bắt đầu bơm nước!</b>\n"
      "🕹 Chế độ: %s\n"
      "🪴 Độ ẩm đất: %d%% (Ngưỡng bật: %d%%)\n"
      "🚰 Nước bình: %d%%",
      isAutoMode ? "TỰ ĐỘNG" : "THỦ CÔNG",
      soilPercent, soilDryThreshold, waterPercent);
    notifyTelegram(pumpOnMsg);
  } else {
    unsigned long duration = previousPumpState ? (millis() - pumpStartTime) / 1000 : pumpDurationSeconds;
    pumpDurationSeconds = 0;
    if (previousPumpState && !isPumpTimeoutAlert) {
      char pumpOffMsg[256];
      snprintf(pumpOffMsg, sizeof(pumpOffMsg),
        "✅ <b>Đã ngắt máy bơm!</b>\n"
        "🪴 Độ ẩm đất hiện tại: %d%%\n"
        "⏱ Thời gian bơm: %lu giây\n"
        "🚰 Nước bình: %d%%",
        soilPercent, duration, waterPercent);
      notifyTelegram(pumpOffMsg);
    }
  }

  Serial.print(F("[RELAY] Trang thai bom: "));
  Serial.println(isPumpOn ? F("DANG BAT") : F("DANG TAT"));
}

// =================== LẤY THỜI GIAN NTP ===================
void formatCurrentTime(char* timeStr, size_t size) {
  const time_t now = time(nullptr);
  struct tm timeinfo;
  if (!localtime_r(&now, &timeinfo) || timeinfo.tm_year <= 116) {
    snprintf(timeStr, size, "--:--:--");
    return;
  }
  strftime(timeStr, size, "%H:%M:%S", &timeinfo);
}

// =================== ĐỌC CẢM BIẾN & ĐO MỰC NƯỚC ===================
void readWaterLevel() {
  lastWaterRead = millis();
  waterRaw = readMedianAdc(PIN_WATER_ADC);
  // Hiệu chuẩn: khô ngoài không khí ~ 200, nhúng ngập vạch ~ 2600
  waterPercent = map(waterRaw, 200, 2600, 0, 100);
  waterPercent = constrain(waterPercent, 0, 100);

  // Điều kiện cạn nước: Mực nước < 15%
  isWaterAvailable = (waterPercent >= WATER_EMPTY_THRESHOLD);

  // Khóa bơm lập tức nếu cạn nước
  if (isPumpOn && !isWaterAvailable) {
    setPump(false);
    Serial.println(F("[AN TOAN] Ngat bom khan cap: Binh chua het nuoc!"));
  }

  static bool emptyWaterAlertSent = false;
  if (!isWaterAvailable) {
    if (!emptyWaterAlertSent) {
      emptyWaterAlertSent = true;
      char alertMsg[256];
      snprintf(alertMsg, sizeof(alertMsg),
        "🚨 <b>CẢNH BÁO KHẨN CẤP: BÌNH CHỨA HẾT NƯỚC!</b>\n"
        "🚰 Mực nước hiện tại: %d%% (< 15%%)\n"
        "🔒 Hệ thống đã KHÓA máy bơm để chống cháy động cơ.",
        waterPercent);
      notifyTelegram(alertMsg);
    }
  } else if (waterPercent >= 25) {
    emptyWaterAlertSent = false;
  }
}

void readSensors() {
  readWaterLevel();
  // 2. Doc DHT22; khong dung gia tri cu de du doan khi cam bien loi.
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  dhtValid = isfinite(h) && isfinite(t) && h >= 0 && h <= 100 && t >= -40 && t <= 80;
  if (dhtValid) {
    airHumidity = h;
    airTemp = t;
  }

  // 3. Đọc độ ẩm đất (GPIO 34)
  soilRaw = readMedianAdc(PIN_SOIL_ADC);
  const int DRY_RAW = 3500;
  const int WET_RAW = 1400;
  soilPercent = map(soilRaw, DRY_RAW, WET_RAW, 0, 100);
  soilPercent = constrain(soilPercent, 0, 100);
  aiDryMinutes = dhtValid ? predictMinutesToDry(airTemp, airHumidity, soilPercent) : -1;
  checkFlowAnomaly();

  Serial.print(F("[DATA] Dat: ")); Serial.print(soilPercent);
  Serial.print(F("% | Nuoc: ")); Serial.print(waterPercent);
  Serial.print(F("% | Nhiet: ")); Serial.print(airTemp);
  Serial.println(F("C"));
}

// =================== HIỂN THỊ OLED ===================
void updateOLED() {
  if (!oledFound) return;

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);

  // Dòng 1: Tiêu đề & Giờ
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(isAutoMode ? F("AUTO") : F("MANU"));
  display.setCursor(40, 0);
  display.print(F("GARDEN"));
  display.setCursor(80, 0);
  char timeStr[9];
  formatCurrentTime(timeStr, sizeof(timeStr));
  display.print(timeStr);
  display.drawLine(0, 9, 127, 9, SH110X_WHITE);

  // Cảnh báo cạn nước ưu tiên
  if (!isWaterAvailable) {
    display.fillRect(0, 12, 127, 12, SH110X_WHITE);
    display.setTextColor(SH110X_BLACK, SH110X_WHITE);
    display.setCursor(6, 14);
    display.print(F("CANH BAO: HET NUOC!"));
    display.setTextColor(SH110X_WHITE);
  } else {
    // Dòng 2: Mực nước bình chứa (%)
    display.setCursor(0, 13);
    display.print(F("Binh nuoc: "));
    display.print(waterPercent);
    display.print(F("% ["));
    display.print(waterPercent > 50 ? F("DAY") : F("TB"));
    display.print(F("]"));
  }

  // Dòng 3: Độ ẩm đất
  display.setCursor(0, 27);
  display.print(F("Do am dat: "));
  display.setTextSize(2);
  display.setCursor(68, 25);
  display.print(soilPercent);
  display.print(F("%"));

  // Dòng 4: Khí hậu & Máy bơm
  display.setTextSize(1);
  display.setCursor(0, 43);
  display.print((int)airTemp);
  display.print(F("C|"));
  display.print((int)airHumidity);
  display.print(F("% "));

  if (isPumpOn) {
    display.fillRect(64, 41, 36, 12, SH110X_WHITE);
    display.setTextColor(SH110X_BLACK, SH110X_WHITE);
    display.setCursor(68, 43);
    display.print(F("ON"));
    display.setTextColor(SH110X_WHITE);
    display.setCursor(102, 43);
    display.print(pumpDurationSeconds);
    display.print(F("s"));
  } else {
    display.setCursor(64, 43);
    display.print(isPumpTimeoutAlert ? F("NGAT(60s)") : F("DANG TAT"));
  }

  display.setCursor(0, 56);
  if (flowAnomaly) display.print(F("LOI: KIEM TRA BOM/ONG"));
  else if (aiDryMinutes < 0) display.print(F("AI: Cho DHT22"));
  else {
    display.print(F("Kho ~")); display.print(aiDryMinutes); display.print(F("p nua | AI:ON"));
  }
  display.display();
}

// =================== REST API CHO WEB ===================
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "ESP32 Water Monitoring Ready");
}

void sendDataSnapshot() {
  syncPumpCutoff();
  server.sendHeader("Cache-Control", "no-store");

  char json[512], timeStr[9];
  formatCurrentTime(timeStr, sizeof(timeStr));
  const auto boolean = [](bool value) { return value ? "true" : "false"; };
  const int len = snprintf(json, sizeof(json),
    "{\"temp\":%.1f,\"hum\":%.1f,\"dht_valid\":%s,\"ai_dry_min\":%d,"
    "\"flow_anomaly\":%s,\"flow_confirmed\":%s,\"soil\":%d,\"raw\":%d,"
    "\"water_pct\":%d,\"water_raw\":%d,\"touch\":%s,\"pump\":%s,\"mode\":\"%s\","
    "\"water\":%s,\"timeout_alert\":%s,\"pump_time\":%lu,\"dry_th\":%d,"
    "\"wet_th\":%d,\"time\":\"%s\"}",
    airTemp, airHumidity, boolean(dhtValid), aiDryMinutes, boolean(flowAnomaly),
    boolean(isPumpOn && flowConfirmed && !flowAnomaly), soilPercent, soilRaw,
    waterPercent, waterRaw, boolean(touchState), boolean(isPumpOn),
    isAutoMode ? "AUTO" : "MANU", boolean(isWaterAvailable), boolean(isPumpTimeoutAlert),
    pumpDurationSeconds, soilDryThreshold, soilWetThreshold, timeStr);
  if (len < 0 || static_cast<size_t>(len) >= sizeof(json)) {
    server.send(500, "application/json", "{\"error\":\"Snapshot unavailable\"}");
    return;
  }
  server.send(200, "application/json", json);
}

void handleData() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  sendDataSnapshot();
}

void handleTogglePump() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");

  // Lenh state tuy chon la idempotent; giu tuong thich endpoint toggle cu.
  if (server.hasArg("state") && server.arg("state") != "0" && server.arg("state") != "1") {
    server.send(400, "application/json", "{\"error\":\"Trang thai bom khong hop le\"}");
    return;
  }
  syncPumpCutoff();
  bool target = server.hasArg("state") ? server.arg("state") == "1" : !isPumpOn;
  if (target) readWaterLevel();
  if (target && !isWaterAvailable) {
    server.send(409, "application/json", "{\"error\":\"Binh chua can nuoc, bom bi khoa\"}");
    return;
  }
  if (target && !cutoffReady) {
    server.send(503, "application/json", "{\"error\":\"Pump watchdog unavailable\"}");
    return;
  }
  isAutoMode = false;
  setPump(target);
  syncPumpCutoff();
  if (target && !isPumpOn) {
    server.send(503, "application/json", "{\"error\":\"Pump cutoff occurred\"}");
    return;
  }
  sendDataSnapshot();
}

void handleSetMode() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");

  if (server.hasArg("mode")) {
    String m = server.arg("mode");
    if (m != "auto" && m != "manual") {
      server.send(400, "application/json", "{\"error\":\"Che do khong hop le\"}");
      return;
    }
    isAutoMode = (m == "auto");
  } else {
    isAutoMode = !isAutoMode;
  }
  sendDataSnapshot();
}

void handleSetThresholds() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");

  if (server.hasArg("dry") && server.hasArg("wet")) {
    String dryArg = server.arg("dry"), wetArg = server.arg("wet");
    int dry = dryArg.toInt(), wet = wetArg.toInt();
    if (String(dry) != dryArg || String(wet) != wetArg || !validThresholds(dry, wet)) {
      server.send(400, "application/json", "{\"error\":\"Nguong tuoi khong hop le\"}");
      return;
    }
    // One NVS key commits both values together. Skip repeated writes.
    if (!preferencesReady) {
      server.send(500, "application/json", "{\"error\":\"NVS unavailable\"}");
      return;
    }
    if (dry != soilDryThreshold || wet != soilWetThreshold) {
      const uint16_t pair = (dry << 8) | wet;
      if (prefs.putUShort("thresholds", pair) != sizeof(pair)) {
        server.send(500, "application/json", "{\"error\":\"NVS write failed\"}");
        return;
      }
      soilDryThreshold = dry;
      soilWetThreshold = wet;
    }
  } else {
    server.send(400, "application/json", "{\"error\":\"Thieu nguong dry/wet\"}");
    return;
  }

  sendDataSnapshot();
}

// =================== SETUP ===================
void updateWifi(unsigned long now) {
  const bool online = WiFi.status() == WL_CONNECTED;
  if (online != staOnline) {
    staOnline = online;
    if (online) {
      Serial.println(WiFi.localIP());
      static bool mdnsStarted = false;
      if (!mdnsStarted) mdnsStarted = MDNS.begin("smartgarden");
      configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");

      static bool bootTelegramSent = false;
      if (!bootTelegramSent) {
        bootTelegramSent = true;
        char bootMsg[256];
        snprintf(bootMsg, sizeof(bootMsg),
          "🌱 <b>Hệ thống tưới tự động đã kết nối!</b>\n"
          "📍 IP: %s\n"
          "🪴 Độ ẩm đất: %d%% | 🚰 Nước bình: %d%%\n"
          "⏱ Trạng thái: Sẵn sàng giám sát",
          WiFi.localIP().toString().c_str(), soilPercent, waterPercent);
        notifyTelegram(bootMsg);
      }
    } else {
      staDisconnectedAt = now;
      lastWifiRetry = now;
    }
  }
  if (online) return;

  // Keep the fallback AP available after STA recovers so AP clients stay connected.
  if (!fallbackAp && now - staDisconnectedAt >= 5000 &&
      now - lastWifiRetry >= 5000) {
    lastWifiRetry = now;
    if (WiFi.mode(WIFI_AP_STA)) {
      fallbackAp = WiFi.softAP("ESP32_SmartGarden", "12345678");
      if (fallbackAp) Serial.println(WiFi.softAPIP());
    }
    WiFi.reconnect();
  } else if (fallbackAp && now - lastWifiRetry >= 15000) {
    lastWifiRetry = now;
    WiFi.reconnect();
  }
}

void setup() {
  // Preload HIGH before enabling the output driver.
  gpio_set_level(static_cast<gpio_num_t>(PIN_RELAY), RELAY_OFF);
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, RELAY_OFF);
  esp_timer_create_args_t timerArgs = {};
  timerArgs.callback = pumpWatchdogTick;
  timerArgs.name = "pump-cutoff";
  cutoffReady = esp_timer_create(&timerArgs, &pumpWatchdog) == ESP_OK &&
                esp_timer_start_periodic(pumpWatchdog, 20000) == ESP_OK;
  Serial.begin(115200);
  Serial.println(F("\n=========================================="));
  Serial.println(F("   HE THONG TUOI & GIAM SAT MUC NUOC PRO  "));
  Serial.println(F("=========================================="));

  // 1. Đọc cấu hình Flash
  preferencesReady = prefs.begin("garden", false);
  if (preferencesReady) {
    const uint16_t pair = prefs.getUShort("thresholds", 0);
    soilDryThreshold = pair ? pair >> 8 : prefs.getInt("dry", 40);
    soilWetThreshold = pair ? pair & 0xff : prefs.getInt("wet", 65);
  }
  if (!validThresholds(soilDryThreshold, soilWetThreshold)) {
    soilDryThreshold = 40;
    soilWetThreshold = 65;
  }

  // 2. Chân phần cứng
  pinMode(PIN_TOUCH, INPUT_PULLDOWN);
  touchState = rawTouchState = lastTouchState = digitalRead(PIN_TOUCH);
  pinMode(PIN_SOIL_ADC, INPUT);
  pinMode(PIN_WATER_ADC, INPUT);

  // 3. Khởi động cảm biến & OLED
  dht.begin();
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  Wire.setTimeOut(50);

  if (display.begin(0x3C, true) || display.begin(0x3D, true)) {
    oledFound = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);
    display.setCursor(15, 20);
    display.println(F("SMART GARDEN"));
    display.setCursor(20, 36);
    display.println(F("GIAM SAT NUOC"));
    display.display();
  }

  // 4. Kết nối WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  staDisconnectedAt = lastWifiRetry = millis();

  // 5. REST API
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/data", HTTP_GET, handleData);
  server.on("/api/toggle", HTTP_GET, handleTogglePump);
  server.on("/api/toggle", HTTP_POST, handleTogglePump);
  server.on("/api/mode", HTTP_GET, handleSetMode);
  server.on("/api/mode", HTTP_POST, handleSetMode);
  server.on("/api/settings", HTTP_GET, handleSetThresholds);
  server.on("/api/settings", HTTP_POST, handleSetThresholds);
  server.onNotFound([]() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    if (server.method() == HTTP_OPTIONS) server.send(204, "text/plain", "");
    else server.send(404, "application/json", "{}");
  });
  server.begin();

  readSensors();
  lastSensorRead = millis();
}

// =================== LOOP ===================
void loop() {
  syncPumpCutoff();
  unsigned long currentMillis = millis();
  if (currentMillis - lastWaterRead >= WATER_INTERVAL) readWaterLevel();

  // 1. Nút chạm TTP223
  bool touch = digitalRead(PIN_TOUCH);
  if (touch != rawTouchState) {
    rawTouchState = touch;
    touchChangedAt = currentMillis;
  }
  if (touch != lastTouchState && currentMillis - touchChangedAt >= 50) {
    lastTouchState = touchState = touch;
    if (touch) {
      if (!isPumpOn) readWaterLevel();
      if (isPumpOn || (isWaterAvailable && cutoffReady)) {
        isAutoMode = false;
        setPump(!isPumpOn);
      }
    }
  }

  // 2. Đo cảm biến định kỳ
  if (currentMillis - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = currentMillis;
    readSensors();

    if (isAutoMode && isWaterAvailable) {
      if (soilPercent < soilDryThreshold && !isPumpOn && !isPumpTimeoutAlert) {
        setPump(true);
      } else if (soilPercent >= soilWetThreshold && isPumpOn) {
        setPump(false);
      }
    }
  }

  syncPumpCutoff();
  if (isPumpOn) pumpDurationSeconds = (millis() - pumpStartTime) / 1000;

  // 3. Cập nhật OLED
  if (currentMillis - lastOledUpdate >= OLED_INTERVAL) {
    lastOledUpdate = currentMillis;
    updateOLED();
  }
  updateWifi(currentMillis);
  server.handleClient();
}
