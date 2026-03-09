#include <WiFi.h>
#include <WebServer.h>
#include <FS.h>
#include <SPIFFS.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <Adafruit_INA219.h>

// ========================
// CONFIGURATION
// ========================
const char* ssid = "PiezoStation";
const char* password = "12345678";
const char* ADMIN_SECURITY_KEY = "PZSTAT001";

WebServer server(80);
Adafruit_INA219 ina219;

// --- SERVO CONFIGURATION (180° SERVOS) ---
Servo servo1, servo2, servo3;
const int servoPins[3] = {14, 27, 26};

// 180° Servo Angles
const int SERVO_LOCKED_ANGLE = 0;      
const int SERVO_UNLOCKED_ANGLE = 90;   // Door OPEN (for placing/retrieving device)
const int SERVO_MOVE_DELAY = 600;      // Time to reach position
const int SERVO_DETACH_DELAY = 100;    // Hold time before detach

// --- NON-BLOCKING SERVO STATE MACHINE ---
enum ServoState { IDLE, MOVING, COOLDOWN };
struct ServoTask {
  ServoState state = IDLE;
  unsigned long startTime = 0;
  int slotIndex = -1;
  int targetAngle = 0;
};
ServoTask currentTask;

// --- SLOT DATA ---
struct Slot {
  bool occupied = false;
  String code = "";
};
Slot slotData[3];

// --- ENERGY MONITORING ---
float voltage = 0.0;
float current = 0.0;
float totalHarvestedEnergy = 0.0;
unsigned long lastSensorRead = 0 ;
bool ina219Available = false;

// ========================
// UTILITIES
// ========================
String getContentType(String filename) {
  if (filename.endsWith(".html")) return "text/html";
  if (filename.endsWith(".css"))  return "text/css";
  if (filename.endsWith(".js"))   return "application/javascript";
  if (filename.endsWith(".jpg"))  return "image/jpeg";
  if (filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png"))  return "image/png";
  return "text/plain";
}

Servo* getServo(int index) {
  if (index == 0) return &servo1;
  if (index == 1) return &servo2;
  if (index == 2) return &servo3;
  return nullptr;
}

// ========================
// NON-BLOCKING SERVO CONTROL
// ========================
void updateServos() {
  if (currentTask.state == IDLE) return;
  
  unsigned long now = millis();
  unsigned long elapsed = now - currentTask.startTime;
  
  if (currentTask.state == MOVING) {
    if (elapsed >= SERVO_MOVE_DELAY) {
      currentTask.state = COOLDOWN;
      currentTask.startTime = now;
      Serial.printf("  ✓ Servo reached %d°\n", currentTask.targetAngle);
    }
  } 
  else if (currentTask.state == COOLDOWN) {
    if (elapsed >= SERVO_DETACH_DELAY) {
      Servo* servo = getServo(currentTask.slotIndex);
      if (servo) {
        servo->detach();
      }
      
      currentTask.state = IDLE;
      Serial.println("  ✓ Servo detached\n");
    }
  }
}

void moveServo(int slot, int targetAngle) {
  if (currentTask.state != IDLE) {
    Serial.println("✗ Servo busy!");
    return;
  }
  
  int index = slot - 1;
  if (index < 0 || index > 2) {
    Serial.println("✗ Invalid slot");
    return;
  }
  
  Servo* servo = getServo(index);
  if (!servo) {
    Serial.println("✗ Servo not found");
    return;
  }
  
  // Log the movement
  Serial.printf("\n→ SERVO MOVEMENT START\n");
  Serial.printf("  Slot: %d\n", slot);
  Serial.printf("  Target: %d° (%s)\n", 
                targetAngle, 
                (targetAngle == SERVO_LOCKED_ANGLE) ? "LOCKED" : "UNLOCKED");
  
  // Attach and move
  servo->attach(servoPins[index]);
  delay(10);
  
  servo->write(targetAngle);
  
  // Set task state
  currentTask.slotIndex = index;
  currentTask.startTime = millis();
  currentTask.state = MOVING;
  currentTask.targetAngle = targetAngle;
}


/// ========================
// SENSOR READING WITH DEBUG
// ========================
void readSensors() {
  static unsigned long lastEnergyCalc = 0;
  unsigned long currentTime = millis();
  
  if (!ina219Available) {
    // Simulated data fallback
    voltage = 3.7 + (random(-50, 50) / 100.0);
    current = 0.05 + (random(0, 50) / 1000.0);
    
    if (lastEnergyCalc > 0) {
      float elapsedSeconds = (currentTime - lastEnergyCalc) / 1000.0;
      float chargeCoulombs = current * elapsedSeconds;
      float energyJoules = chargeCoulombs * voltage;
      totalHarvestedEnergy += energyJoules;
    }
    lastEnergyCalc = currentTime;
    return;
  }
  
  // Read all INA219 values
  float busV = ina219.getBusVoltage_V();           // Voltage at VIN- terminal
  float shuntV_mV = ina219.getShuntVoltage_mV();   // Voltage drop across shunt
  float currentmA = ina219.getCurrent_mA();         // Current through sensor
  float powerW = ina219.getPower_mW() / 1000.0;     // Power in Watts
  
  // LOW-SIDE SENSING FIX: Calculate battery voltage from power and current
  // Since P = V × I, therefore V = P / I
  float batteryVoltage = 0.0;
  
  if (busV < 0.1) {
    // Low-side configuration detected (VIN- near ground)
    if (currentmA > 10) {  // Only calculate if meaningful current
      // Calculate source voltage from P = V × I
      batteryVoltage = powerW / (currentmA / 1000.0);
    } else {
      // No significant current - use nominal 18650 voltage
      batteryVoltage = 3.7;
    }
  } else {
    // High-side configuration (normal)
    batteryVoltage = busV + (shuntV_mV / 1000.0);
  }
  
  // DEBUG OUTPUT - Print every read
  Serial.println("\n╔════════════════════════════════╗");
  Serial.println("║     INA219 DEBUG READINGS      ║");
  Serial.println("╠════════════════════════════════╣");
  Serial.printf("║ Bus Voltage (VIN-):   %6.3f V ║\n", busV);
  Serial.printf("║ Shunt Voltage:        %6.2f mV║\n", shuntV_mV);
  Serial.printf("║ Current:              %6.2f mA║\n", currentmA);
  Serial.printf("║ Power:                %6.3f W ║\n", powerW);
  Serial.printf("║ Battery Voltage:      %6.3f V ║\n", batteryVoltage);
  Serial.println("╠════════════════════════════════╣");
  Serial.printf("║ Config: %s ║\n", (busV < 0.1) ? "LOW-SIDE SENSING  " : "HIGH-SIDE SENSING");
  Serial.println("╚════════════════════════════════╝");
  
  // Use calculated battery voltage
  voltage = batteryVoltage;
  current = currentmA / 1000.0;
  
  // FIXED: Calculate energy stored in 18650 (not instantaneous power)
  // Energy = Charge × Voltage, where Charge = Current × Time
  if (lastEnergyCalc > 0 && current > 0.001) {  // 1mA threshold
    float elapsedSeconds = (currentTime - lastEnergyCalc) / 1000.0;
    
    // For battery/capacitor charging: E = Q × V = (I × t) × V
    float chargeCoulombs = current * elapsedSeconds;  // Coulombs
    float energyJoules = chargeCoulombs * voltage;    // Joules
    
    totalHarvestedEnergy += energyJoules;
    
    Serial.printf("  → Charge added: %.6f C\n", chargeCoulombs);
    Serial.printf("  → Energy added: %.4f J\n", energyJoules);
    Serial.printf("  → Total Energy: %.2f J (%.4f Wh)\n", 
                  totalHarvestedEnergy, 
                  totalHarvestedEnergy / 3600.0);
  }
  
  lastEnergyCalc = currentTime;
}
// ========================
// API ENDPOINTS
// ========================
void handleGetData() {
  String json = "{";
  json += "\"voltage\":" + String(voltage, 2) + ",";
  json += "\"current\":" + String(current, 3) + ",";
  json += "\"harvestedEnergy\":" + String(totalHarvestedEnergy, 2) + ",";
  
  int pct = constrain(map((int)(voltage * 100), 300, 420, 0, 100), 0, 100);
  json += "\"battery\":" + String(pct) + ",";
  json += "\"sensorActive\":" + String(ina219Available ? "true" : "false") + ",";

  json += "\"slots\":{";
  for(int i = 0; i < 3; i++) {
    json += "\"" + String(i+1) + "\":{";
    json += "\"occupied\":" + String(slotData[i].occupied ? "true" : "false");
    json += "}";
    if (i < 2) json += ",";
  }
  json += "}}";
  
  server.send(200, "application/json", json);
}

void handleRequestLock() {
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  /requestLock CALLED         ║");
  Serial.println("╚══════════════════════════════╝");
  
  if (!server.hasArg("slot")) {
    Serial.println("✗ Missing slot parameter");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing slot\"}");
    return;
  }
  
  int slot = server.arg("slot").toInt();
  Serial.printf("  Slot requested: %d\n", slot);
  
  if (slot < 1 || slot > 3) {
    Serial.println("✗ Invalid slot number");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid slot\"}");
    return;
  }
  
  int i = slot - 1;
  
  if (slotData[i].occupied) {
    Serial.println("✗ Slot already occupied");
    server.send(409, "application/json", "{\"success\":false,\"error\":\"Slot occupied\"}");
    return;
  }
  
  if (currentTask.state != IDLE) {
    Serial.println("✗ Servo busy");
    server.send(503, "application/json", "{\"success\":false,\"error\":\"System busy\"}");
    return;
  }
  
  // Generate code
  String code = String(random(1000, 10000));
  slotData[i].code = code;
  slotData[i].occupied = true;
  
  Serial.printf("  ✓ Code generated: %s\n", code.c_str());
  Serial.printf("  ✓ Slot marked as occupied\n");
  Serial.printf("  → Opening door (0° → 90°)...\n");
  
  // OPEN THE DOOR (0° → 90°)
  moveServo(slot, SERVO_UNLOCKED_ANGLE);
  
  String response = "{\"success\":true,\"code\":\"" + code + "\"}";
  server.send(200, "application/json", response);
  
  Serial.println("  ✓ Response sent to client");
}

void handleConfirmLock() {
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  /confirmLock CALLED         ║");
  Serial.println("╚══════════════════════════════╝");
  
  if (!server.hasArg("slot")) {
    Serial.println("✗ Missing slot parameter");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing slot\"}");
    return;
  }
  
  int slot = server.arg("slot").toInt();
  Serial.printf("  Slot: %d\n", slot);
  
  if (slot < 1 || slot > 3) {
    Serial.println("✗ Invalid slot number");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid slot\"}");
    return;
  }
  
  int i = slot - 1;
  
  if (!slotData[i].occupied) {
    Serial.println("✗ Slot not reserved");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Slot not reserved\"}");
    return;
  }
  
  if (currentTask.state != IDLE) {
    Serial.println("✗ Servo busy");
    server.send(503, "application/json", "{\"success\":false,\"error\":\"System busy\"}");
    return;
  }
  
  Serial.printf("  ✓ Slot verified as occupied\n");
  Serial.printf("  → Closing door (90° → 0°)...\n");
  
  // CLOSE THE DOOR (90° → 0°)
  moveServo(slot, SERVO_LOCKED_ANGLE);
  
  server.send(200, "application/json", "{\"success\":true}");
  Serial.println("  ✓ Response sent to client");
}

void handleUnlockSlot() {
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  /unlockSlot CALLED          ║");
  Serial.println("╚══════════════════════════════╝");
  
  if (!server.hasArg("slot") || !server.hasArg("code")) {
    Serial.println("✗ Missing parameters");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing parameters\"}");
    return;
  }
  
  int slot = server.arg("slot").toInt();
  String inputCode = server.arg("code");
  inputCode.trim();
  
  Serial.printf("  Slot: %d\n", slot);
  Serial.printf("  Code entered: %s\n", inputCode.c_str());
  
  if (slot < 1 || slot > 3) {
    Serial.println("✗ Invalid slot");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid slot\"}");
    return;
  }
  
  int i = slot - 1;
  
  if (!slotData[i].occupied) {
    Serial.println("✗ Slot not occupied");
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Slot not in use\"}");
    return;
  }
  
  if (slotData[i].code != inputCode) {
    Serial.printf("✗ Wrong code! Expected: %s\n", slotData[i].code.c_str());
    server.send(401, "application/json", "{\"success\":false,\"error\":\"Invalid code\"}");
    return;
  }
  
  if (currentTask.state != IDLE) {
    Serial.println("✗ Servo busy");
    server.send(503, "application/json", "{\"success\":false,\"error\":\"System busy\"}");
    return;
  }
  
  Serial.println("  ✓ Code correct!");
  
  // Clear slot FIRST
  slotData[i].occupied = false;
  slotData[i].code = "";
  
  Serial.println("  ✓ Slot cleared");
  Serial.printf("  → Opening door (0° → 90°)...\n");
  
  // OPEN THE DOOR (0° → 90°)
  moveServo(slot, SERVO_UNLOCKED_ANGLE);
  
  server.send(200, "application/json", "{\"success\":true}");
  Serial.println("  ✓ Response sent to client");
}

void handleAdminUnlock() {
  if (!server.hasArg("slot") || !server.hasArg("key")) {
    server.send(403, "application/json", "{\"success\":false,\"error\":\"Unauthorized\"}");
    return;
  }
  
  if (server.arg("key") != ADMIN_SECURITY_KEY) {
    server.send(403, "application/json", "{\"success\":false,\"error\":\"Invalid key\"}");
    return;
  }
  
  int slot = server.arg("slot").toInt();
  if (slot < 1 || slot > 3) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid slot\"}");
    return;
  }
  
  if (currentTask.state != IDLE) {
    server.send(503, "application/json", "{\"success\":false,\"error\":\"System busy\"}");
    return;
  }
  
  Serial.printf("\n⚠️  ADMIN: Force unlock slot %d\n", slot);
  
  int i = slot - 1;
  slotData[i].occupied = false;
  slotData[i].code = "";
  
  moveServo(slot, SERVO_UNLOCKED_ANGLE);
  
  server.send(200, "application/json", "{\"success\":true}");
}

void handleAdminReset() {
  if (!server.hasArg("key") || server.arg("key") != ADMIN_SECURITY_KEY) {
    server.send(403, "application/json", "{\"success\":false,\"error\":\"Unauthorized\"}");
    return;
  }
  
  if (currentTask.state != IDLE) {
    server.send(503, "application/json", "{\"success\":false,\"error\":\"System busy\"}");
    return;
  }
  
  Serial.println("\n╔═══════════════════════════════╗");
  Serial.println("║   ADMIN SYSTEM RESET          ║");
  Serial.println("╚═══════════════════════════════╝");
  
  // Clear data
  for (int i = 0; i < 3; i++) {
    slotData[i].occupied = false;
    slotData[i].code = "";
  }
  
  // Open all doors
  Servo* servos[3] = {&servo1, &servo2, &servo3};
  
  for(int i = 0; i < 3; i++) {
    Serial.printf("Opening slot %d...\n", i+1);
    
    servos[i]->attach(servoPins[i]);
    delay(10);
    servos[i]->write(SERVO_UNLOCKED_ANGLE);
    delay(SERVO_MOVE_DELAY);
    servos[i]->detach();
    delay(300);
  }
  
  Serial.println("✓ Reset complete\n");
  server.send(200, "application/json", "{\"success\":true}");
}

void handleFileRequest() {
  String path = server.uri();
  if (path == "/") path = "/index.html";
  
  if (!SPIFFS.exists(path)) {
    server.send(404, "text/plain", "404: " + path);
    return;
  }
  
  File file = SPIFFS.open(path, "r");
  if (!file) {
    server.send(500, "text/plain", "500: Failed to open");
    return;
  }
  
  server.streamFile(file, getContentType(path));
  file.close();
}

// ========================
// SETUP
// ========================
void setup() {
  
  Wire.begin(21,22);
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║   PiezoStation Booting...    ║");
  Serial.println("╚══════════════════════════════╝\n");
  
  Serial.println("[OK] I2C initialized");
  
  if (!SPIFFS.begin(true)) {
    Serial.println("[FAIL] SPIFFS failed");
  } else {
    Serial.println("[OK] SPIFFS mounted");
  }
  
  if (ina219.begin()) {
    ina219Available = true;
    Serial.println("[OK] INA219 detected");
  } else {
    Serial.println("[WARN] INA219 not found - using simulated data");
  }
  
  WiFi.softAP(ssid, password);
  Serial.print("[OK] WiFi AP: ");
  Serial.println(ssid);
  Serial.print("     IP: ");
  Serial.println(WiFi.softAPIP());
  
  // Initialize servos to LOCKED position
  Serial.println("\n[INIT] Locking all slots...");
  Servo* servos[3] = {&servo1, &servo2, &servo3};
  for(int i = 0; i < 3; i++) {
    servos[i]->attach(servoPins[i]);
    delay(10);
    servos[i]->write(SERVO_LOCKED_ANGLE); // Move to 0°
    delay(SERVO_MOVE_DELAY);
    servos[i]->detach();
    Serial.printf("  ✓ Slot %d locked at 0°\n", i+1);
    delay(200);
  }
  
  Serial.println("[OK] All servos initialized\n");
  
  for(int i = 0; i < 3; i++) {
    slotData[i].occupied = false;
    slotData[i].code = "";
  }
  
  server.on("/getData", HTTP_GET, handleGetData);
  server.on("/requestLock", HTTP_GET, handleRequestLock);
  server.on("/confirmLock", HTTP_GET, handleConfirmLock);
  server.on("/unlockSlot", HTTP_GET, handleUnlockSlot);
  server.on("/adminUnlock", HTTP_GET, handleAdminUnlock);
  server.on("/adminReset", HTTP_GET, handleAdminReset);
  server.onNotFound(handleFileRequest);
  
  server.begin();
  Serial.println("[OK] Web server started\n");
  
  Serial.println("╔══════════════════════════════╗");
  Serial.println("║      System Ready ✓          ║");
  Serial.println("╚══════════════════════════════╝\n");
}

// ========================
// MAIN LOOP
// ========================
void loop() {
  server.handleClient();
  updateServos();
  
  if (millis() - lastSensorRead >= 1000) {
    lastSensorRead = millis();
    readSensors();
  }
}
