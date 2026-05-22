try {
// ─── FTMS UUIDs & Op Codes ─────────────────────────────────────────────────
const UUID = {
  FTMS_SERVICE:    0x1826,
  FTMS_FEATURES:   0x2ACC,   // read to know what the machine supports
  TREADMILL_DATA:  0x2ACD,
  CONTROL_POINT:   0x2AD9,
  FTMS_STATUS:     0x2ADA,
};

const OP = {
  REQUEST_CONTROL: 0x00,
  RESET:           0x01,
  SET_SPEED:       0x02,
  START_RESUME:    0x07,  // FTMS spec §4.8 — was wrongly 0x08
  STOP_PAUSE:      0x08,  // FTMS spec §4.8 — was wrongly 0x09
};

// FTMS Status op codes (notifications from treadmill → us)
// Source: Bluetooth SIG FTMS spec §4.9
const STATUS = {
  0x01: 'Reset',
  0x02: 'Machine Stopped or Paused (user)',   // user pressed stop
  0x03: 'Machine Stopped (safety key)',        // safety key pulled
  0x04: 'Machine Started or Resumed (user)',   // user pressed start ← key one
  0x05: 'Target Speed Changed',
  0x06: 'Target Incline Changed',
  0x08: 'Target Power Changed',
  0xFF: 'Control Permission Lost',
};

const RESULT = {
  0x01: 'Success',
  0x02: 'Op Code Not Supported',
  0x03: 'Invalid Parameter',
  0x04: 'Operation Failed',
  0x05: 'Control Not Permitted',
};

// Feature flags we care about (Fitness Machine Feature characteristic, byte 0–3)
const MACHINE_FEATURES = [
  [0,  'Avg Speed'],
  [2,  'Total Distance'],
  [3,  'Inclination'],
  [9,  'Heart Rate'],
  [10, 'Metabolic Eq'],
  [11, 'Elapsed Time'],
];
// Target setting feature flags (bytes 4–7)
const TARGET_FEATURES = [
  [0,  'Set Speed'],
  [1,  'Set Incline'],
  [6,  'Indoor Bike Sim'],
];

const STEP      = 0.5;
const MIN_SPEED = 1.0;
const MAX_SPEED = 20.0;
const SPEED_MULT  = 100;  // 0.01 km/h per unit — FTMS spec, confirmed correct
const FTMS_UUID   = `00001826-0000-1000-8000-00805f9b34fb`;
const RAMP_STEP   = 0.5;  // km/h per ramp tick
const RAMP_INTERVAL_MS = 800;

// ─── State ─────────────────────────────────────────────────────────────────
let device       = null;
let server       = null;
let ctrlChar     = null;
let dataChar     = null;
let statusChar   = null;
let hasFTMS      = false;
let isRunning    = false;
let targetSpeed  = MIN_SPEED;
let lastCmdTime  = 0;
let rampTimer    = null;   // non-null while stop-ramp is in progress
let isRamping    = false;
let customChars  = [];     // [{uuid, svcUuid, char}] — all writable chars outside FTMS

// ─── DOM ───────────────────────────────────────────────────────────────────
const dot           = document.getElementById('dot');
const statusText    = document.getElementById('statusText');
const controlPanel  = document.getElementById('controlPanel');
const connectPanel  = document.getElementById('connectPanel');
const speedNum      = document.getElementById('speedNum');
const slider        = document.getElementById('slider');
const btnSlower     = document.getElementById('btnSlower');
const btnFaster     = document.getElementById('btnFaster');
const btnStartStop  = document.getElementById('btnStartStop');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnConnect    = document.getElementById('btnConnect');
const btnScanAll    = document.getElementById('btnScanAll');
const btnRetryCtrl  = document.getElementById('btnRetryCtrl');
const btnReset      = document.getElementById('btnReset');
const responseBadge = document.getElementById('responseBadge');
const featuresRow   = document.getElementById('featuresRow');
const logEl         = document.getElementById('log');
const servicesCard  = document.getElementById('servicesCard');
const servicesList  = document.getElementById('servicesList');
const ftmsWarning   = document.getElementById('ftmsWarning');
const browserWarn   = document.getElementById('browserWarning');
const customCard    = document.getElementById('customCard');
const customCharSel = document.getElementById('customCharSel');
const customHex     = document.getElementById('customHex');
const btnSendCustom = document.getElementById('btnSendCustom');
const customRx      = document.getElementById('customRx');

// ─── Logging ───────────────────────────────────────────────────────────────
function log(msg, type = 'default') {
  const ts  = new Date().toLocaleTimeString('en', { hour12: false });
  const div = document.createElement('div');
  div.className = `l-${type}`;
  div.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function hexStr(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
}

// ─── UI helpers ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  dot.className = `dot ${state}`;
  statusText.textContent = text;
}
function showConnectedUI(on) {
  controlPanel.classList.toggle('hidden', !on);
  connectPanel.classList.toggle('hidden', on);
}
function enableControls(on) {
  btnStartStop.disabled = !on;
  btnSlower.disabled    = !on || targetSpeed <= MIN_SPEED;
  btnFaster.disabled    = !on || targetSpeed >= MAX_SPEED;
  slider.disabled       = !on;
  btnRetryCtrl.disabled = !on;
  btnReset.disabled     = !on;
}
function setRunning(on) {
  isRunning = on;
  updateStopBtn();
}
function updateSpeedDisplay(speed) {
  speedNum.textContent = speed.toFixed(1);
  slider.value = speed;
  const pct = ((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;
  slider.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  if (hasFTMS) {
    btnSlower.disabled = speed <= MIN_SPEED;
    btnFaster.disabled = speed >= MAX_SPEED;
  }
}
function setResponseBadge(opName, resultCode) {
  const ok   = resultCode === 0x01;
  const text = RESULT[resultCode] !== undefined ? RESULT[resultCode] : `0x${resultCode.toString(16)}`;
  responseBadge.textContent = `${opName}: ${text}`;
  responseBadge.className   = `badge ${ok ? 'badge-ok' : resultCode === 0x05 ? 'badge-warn' : 'badge-err'}`;
}

// ─── BLE write ─────────────────────────────────────────────────────────────
async function writeCtrl(bytes) {
  if (!ctrlChar) { log('No control point', 'err'); return; }
  const buf = new Uint8Array(bytes);
  log(`TX → ${hexStr(buf)}`, 'tx');
  try {
    await ctrlChar.writeValueWithResponse(buf);
  } catch (e) {
    if (e.name === 'NotSupportedError') {
      log('Falling back to writeWithoutResponse', 'warn');
      await ctrlChar.writeValueWithoutResponse(buf);
    } else { throw e; }
  }
}

// ─── Wait for a specific FTMS indication response ─────────────────────────
// Resolves with the result code, or rejects on timeout.
function waitForIndication(opCode, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ctrlChar.removeEventListener('characteristicvaluechanged', handler);
      reject(new Error(`Timeout waiting for response to op 0x${opCode.toString(16).padStart(2,'0')}`));
    }, timeoutMs);

    function handler(e) {
      const d = new Uint8Array(e.target.value.buffer);
      // FTMS indication: [0x80, requestOpCode, resultCode]
      if (d[0] === 0x80 && d[1] === opCode) {
        clearTimeout(timer);
        ctrlChar.removeEventListener('characteristicvaluechanged', handler);
        resolve(d[2]);
      }
    }
    ctrlChar.addEventListener('characteristicvaluechanged', handler);
  });
}

// ─── FTMS commands ─────────────────────────────────────────────────────────
async function requestControl() {
  log('Requesting control [0x00]…');
  const p = waitForIndication(OP.REQUEST_CONTROL);
  await writeCtrl([OP.REQUEST_CONTROL]);
  const result = await p;
  if (result !== 0x01) throw new Error(`Request Control failed: ${RESULT[result] !== undefined ? RESULT[result] : result}`);
  log('Control granted ✓', 'ok');
}

async function sendSpeed(kmh) {
  lastCmdTime = Date.now();
  const raw = Math.round(kmh * SPEED_MULT);
  const lo  = raw & 0xFF, hi = (raw >> 8) & 0xFF;
  log(`Set speed ${kmh.toFixed(1)} km/h → raw ${raw} [0x02 ${hexStr([lo,hi])}]`);
  const p = waitForIndication(OP.SET_SPEED);
  await writeCtrl([OP.SET_SPEED, lo, hi]);
  const result = await p;
  if (result !== 0x01) log(`Set speed response: ${RESULT[result] !== undefined ? RESULT[result] : result}`, 'warn');
}

// START: request control → start (arms machine into Pre-Workout) → set speed (kicks belt)
// Training status evidence: 0x0E Pre-Workout → 0x0D Manual Mode on physical start
// The speed command is what actually transitions the belt from armed → moving.
async function sendStart() {
  cancelRamp();
  log('─── Start sequence ───', 'info');
  try {
    await requestControl();                       // [80 00 01]

    log('Sending FTMS Start [0x08]…');
    const pStart = waitForIndication(OP.START_RESUME);
    await writeCtrl([OP.START_RESUME]);
    const rStart = await pStart;                  // [80 08 xx]
    log(`Start response: ${RESULT[rStart] !== undefined ? RESULT[rStart] : `0x${rStart.toString(16)}`}`,
        rStart === 0x01 ? 'ok' : 'warn');

    if (rStart === 0x01) {
      // Machine is now armed (Pre-Workout). Send speed to move belt (→ Manual Mode).
      await new Promise(r => setTimeout(r, 250));
      await sendSpeed(targetSpeed);              // [80 02 01]
      setRunning(true);
      log('Belt should be moving ✓', 'ok');
    } else {
      log(`Start not accepted (${RESULT[rStart] !== undefined ? RESULT[rStart] : rStart}) — use physical Start button`, 'err');
    }
  } catch (e) {
    log(`Start error: ${e.message}`, 'err');
    log('Use the physical Start button on the treadmill', 'warn');
  }
}

// STOP: speed-ramp strategy — uses the working SET_SPEED command to gradually
// decelerate the belt. Cheaper treadmills have a physical interlock on the
// FTMS Stop op-code but happily accept speed changes all the way to 0.
function cancelRamp() {
  if (rampTimer) { clearTimeout(rampTimer); rampTimer = null; }
  isRamping = false;
  updateStopBtn();
}

function updateStopBtn() {
  if (!isRunning && !isRamping) {
    btnStartStop.textContent = 'Start';
    btnStartStop.className   = 'btn btn-start';
    speedNum.classList.remove('running');
  } else if (isRamping) {
    btnStartStop.textContent = 'Cancel ramp';
    btnStartStop.className   = 'btn btn-secondary';
  } else {
    btnStartStop.textContent = 'Stop';
    btnStartStop.className   = 'btn btn-stop';
    speedNum.classList.add('running');
  }
}

async function sendStop() {
  if (isRamping) { cancelRamp(); return; }

  log('─── Ramp-down stop ───', 'info');
  log('Slowing belt gradually — step off safely, then press physical STOP', 'warn');
  isRamping = true;
  updateStopBtn();

  // Kick off the first tick immediately
  rampTick();
}

// One ramp tick: write speed, then schedule the next tick only after write completes
// (avoids queuing multiple BLE writes if the treadmill is slow to respond)
async function rampTick() {
  if (!isRamping) return;

  // Treadmill stopped naturally via FTMS Status → cancel
  if (!isRunning) { cancelRamp(); return; }

  targetSpeed = Math.max(0, targetSpeed - RAMP_STEP);
  updateSpeedDisplay(Math.max(MIN_SPEED, targetSpeed));
  lastCmdTime = Date.now();

  if (targetSpeed <= 0) {
    await writeCtrl([OP.SET_SPEED, 0x00, 0x00]).catch(() => {});
    // Send Pause (0x09 0x02) — matches what the physical button sends (STATUS 02 02)
    await writeCtrl([OP.STOP_PAUSE, 0x02]).catch(() => {});
    cancelRamp();
    setRunning(false);
    targetSpeed = MIN_SPEED;
    updateSpeedDisplay(targetSpeed);
    log('Speed reached 0 — press physical STOP if belt is still moving', 'warn');
  } else {
    const raw = Math.round(targetSpeed * SPEED_MULT);
    const lo  = raw & 0xFF, hi = (raw >> 8) & 0xFF;
    log(`Ramp → ${targetSpeed.toFixed(1)} km/h`);
    await writeCtrl([OP.SET_SPEED, lo, hi]).catch(() => {});
    // Schedule next tick only after this write completes
    if (isRamping) rampTimer = setTimeout(rampTick, RAMP_INTERVAL_MS);
  }
}

// ─── Treadmill data notifications (live speed readback) ────────────────────
function parseTreadmillData(dv) {
  const flags = dv.getUint16(0, true);
  // Bit 0 "More Data" = 0 → Instantaneous Speed present at offset 2
  if ((flags & 0x01) === 0 && dv.byteLength >= 4) {
    return dv.getUint16(2, true) / 100;
  }
  return null;
}
function onTreadmillData(e) {
  const speed = parseTreadmillData(e.target.value);
  if (speed === null) return;
  recordSpeed(speed);
  broadcastSpeed(speed, speed > 0.1);
  if (window.runnerApplyKmh) window.runnerApplyKmh(speed, speed > 0.1);
  updateSpeedDisplay(speed);
  if (speed > 0.1 && !isRunning) setRunning(true);
  if (speed < 0.1 &&  isRunning) setRunning(false);
  // Sync targetSpeed to actual only when we're not actively issuing commands
  if (Date.now() - lastCmdTime > 2000) {
    targetSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed > 0.1 ? speed : MIN_SPEED));
    updateSpeedDisplay(targetSpeed);
  }
}

// ─── FTMS Status notifications (machine events → us) ──────────────────────
function onFTMSStatus(e) {
  const d = new Uint8Array(e.target.value.buffer);
  log(`RX ← STATUS ${hexStr(d)}`, 'rx');
  const desc = STATUS[d[0]];
  if (desc) log(`Status: ${desc}`, 'info');

  if (d[0] === 0x04) {                          // Machine started / resumed
    cancelRamp();
    setRunning(true);
  }
  if (d[0] === 0x02 || d[0] === 0x03) {         // Machine stopped (user or safety key)
    cancelRamp();
    setRunning(false);
    targetSpeed = MIN_SPEED;
    updateSpeedDisplay(targetSpeed);
  }
  if (d[0] === 0xFF) {                          // Control permission revoked
    log('Control lost — re-requesting…', 'warn');
    setTimeout(() => requestControl().catch(() => {}), 300);
  }
}

// ─── Control point response handler ───────────────────────────────────────
function onCtrlResponse(e) {
  const d = new Uint8Array(e.target.value.buffer);
  log(`RX ← ${hexStr(d)}`, 'rx');
  if (d[0] !== 0x80 || d.length < 3) return;

  const opCode  = d[1];
  const result  = d[2];
  const opMatch = Object.entries(OP).find(function(e) { return e[1] === opCode; });
  const opName  = opMatch ? opMatch[0] : `0x${opCode.toString(16)}`;
  const resTxt  = RESULT[result] !== undefined ? RESULT[result] : `0x${result.toString(16)}`;
  log(`Response [${opName}]: ${resTxt}`, result === 0x01 ? 'ok' : 'err');
  setResponseBadge(opName, result);

  if (result === 0x05) {
    log('Control not permitted — auto re-requesting…', 'warn');
    setTimeout(() => requestControl().catch(() => {}), 300);
  }
}

// ─── FTMS Features read (shows what the machine supports) ─────────────────
async function readFTMSFeatures(svc) {
  try {
    const c    = await svc.getCharacteristic(UUID.FTMS_FEATURES);
    const dv   = await c.readValue();
    const mf   = dv.getUint32(0, true); // machine feature flags
    const tf   = dv.getUint32(4, true); // target setting flags

    log(`FTMS Machine Features: 0x${mf.toString(16).padStart(8,'0')}`);
    log(`FTMS Target Features:  0x${tf.toString(16).padStart(8,'0')}`);

    featuresRow.innerHTML = '';
    for (const [bit, label] of MACHINE_FEATURES) {
      const on = (mf >> bit) & 1;
      const p  = document.createElement('span');
      p.className = `feat-pill ${on ? 'on' : ''}`;
      p.textContent = label;
      featuresRow.appendChild(p);
    }
    for (const [bit, label] of TARGET_FEATURES) {
      const on = (tf >> bit) & 1;
      const p  = document.createElement('span');
      p.className = `feat-pill ${on ? 'on' : ''}`;
      p.textContent = label;
      featuresRow.appendChild(p);
    }
  } catch (e) {
    log(`Could not read FTMS Features: ${e.message}`, 'warn');
  }
}

// ─── Service discovery & FTMS setup ───────────────────────────────────────
function fullUUID(short) {
  return `0000${short.toString(16).padStart(4,'0')}-0000-1000-8000-00805f9b34fb`;
}

async function discoverAndSetup() {
  const services = await server.getPrimaryServices();
  log(`Found ${services.length} primary service(s)`);

  const uuids = services.map(s => s.uuid);
  hasFTMS = uuids.includes(fullUUID(UUID.FTMS_SERVICE));

  customChars = [];
  customCharSel.innerHTML = '';

  // Build services panel + collect all writable characteristics
  servicesCard.style.display = 'block';
  servicesList.innerHTML = '';
  for (const svc of services) {
    const isFTMS = svc.uuid === fullUUID(UUID.FTMS_SERVICE);
    const el     = document.createElement('div');
    el.className = 'service-item';
    el.innerHTML = `<div class="service-uuid">${svc.uuid}${isFTMS ? ' ← FTMS ✓' : ''}</div>`;

    try {
      const chars = await svc.getCharacteristics();
      for (const c of chars) {
        const props    = Object.entries(c.properties).filter(([,v]) => v).map(([k]) => k);
        const propsStr = props.join(' ');
        const cEl      = document.createElement('div');
        cEl.className  = 'char-row';
        cEl.textContent = `↳ ${c.uuid}  [${propsStr}]`;
        el.appendChild(cEl);

        // Collect every writable characteristic for the custom tester
        const isWritable = props.some(p => p.toLowerCase().includes('write'));
        if (isWritable) {
          customChars.push({ uuid: c.uuid, svcUuid: svc.uuid, char: c });
          const opt   = document.createElement('option');
          opt.value   = customChars.length - 1;
          const short = c.uuid.substring(4, 8).toUpperCase(); // e.g. "FFF2"
          const label = isFTMS ? `[FTMS] ${short}` : `${short} — ${svc.uuid.substring(0,8)}…`;
          opt.textContent = label;
          customCharSel.appendChild(opt);

          // Subscribe to notifications on non-FTMS chars so we can see responses
          if (!isFTMS && props.includes('notify')) {
            try {
              await c.startNotifications();
              c.addEventListener('characteristicvaluechanged', (e) => {
                const d = new Uint8Array(e.target.value.buffer);
                const msg = `RX [${e.target.uuid.substring(4,8).toUpperCase()}] ← ${hexStr(d)}`;
                customRx.textContent = msg;
                log(msg, 'rx');
              });
            } catch { /* some chars throw if not notifiable */ }
          }
        }
      }
    } catch { /* restricted */ }
    servicesList.appendChild(el);
  }

  if (customChars.length > 0) {
    customCard.style.display = 'block';
    log(`Found ${customChars.length} writable characteristic(s) — custom tester ready`, 'info');
  }

  if (hasFTMS) {
    log('FTMS detected — setting up', 'ok');
    await setupFTMS();
  } else {
    log('FTMS (0x1826) not found', 'warn');
    ftmsWarning.textContent = 'Standard FTMS not detected. Check the services above for a custom UUID.';
  }
}

async function setupFTMS() {
  const svc = await server.getPrimaryService(UUID.FTMS_SERVICE);

  // Step 1 — read feature + range characteristics first
  // (FitShow reads these before requesting control — some firmware requires it)
  await readFTMSFeatures(svc);

  try {
    const speedRange = await svc.getCharacteristic(0x2AD4); // Supported Speed Range
    const val = await speedRange.readValue();
    const minSpeed = val.getUint16(0, true) / 100;
    const maxSpeed = val.getUint16(2, true) / 100;
    log(`Speed range: ${minSpeed}–${maxSpeed} km/h`, 'ok');
  } catch { log('Speed range read skipped', 'warn'); }

  // Step 2 — subscribe to all notify/indicate characteristics BEFORE requesting control
  // Subscribe: Training Status (2AD3)
  try {
    const trainChar = await svc.getCharacteristic(0x2AD3);
    await trainChar.startNotifications();
    trainChar.addEventListener('characteristicvaluechanged', (e) => {
      const d = new Uint8Array(e.target.value.buffer);
      log(`Training Status: ${hexStr(d)}`, 'info');
    });
    log('Training Status notifications started');
  } catch { /* optional */ }

  // Subscribe: Treadmill Data (2ACD)
  try {
    dataChar = await svc.getCharacteristic(UUID.TREADMILL_DATA);
    await dataChar.startNotifications();
    dataChar.addEventListener('characteristicvaluechanged', onTreadmillData);
    log('Treadmill data stream started');
  } catch { log('Treadmill data char not available', 'warn'); }

  // Subscribe: Fitness Machine Status (2ADA)
  try {
    statusChar = await svc.getCharacteristic(UUID.FTMS_STATUS);
    await statusChar.startNotifications();
    statusChar.addEventListener('characteristicvaluechanged', onFTMSStatus);
    log('FTMS Status notifications started');
  } catch { log('FTMS Status char not available', 'warn'); }

  // Step 3 — subscribe to Control Point indications LAST
  ctrlChar = await svc.getCharacteristic(UUID.CONTROL_POINT);
  await ctrlChar.startNotifications();
  ctrlChar.addEventListener('characteristicvaluechanged', onCtrlResponse);
  log('Control point ready');

  // Step 4 — short settle delay, then request control
  await new Promise(r => setTimeout(r, 500));
  await requestControl();
}

// ─── All service UUIDs we want access to ──────────────────────────────────
// Web Bluetooth BLOCKS access to any service not listed here — even if the
// device has it. So we declare every common Chinese treadmill / fitness UUID.
const ALL_OPTIONAL_SERVICES = [
  // Standard
  0x1826,                                        // FTMS
  0x180A,                                        // Device Information
  // Common Chinese OEM fitness services (FitShow, iConsole+, Shua, KingSmith…)
  0xFFF0, 0xFFF1, 0xFFF2, 0xFFF3,               // FFF0 vendor service family
  0xFFE0, 0xFFE1, 0xFFE2,                        // FFE0 family
  0xFEE0, 0xFEE1, 0xFEE7,                        // FEE0 family (Xiaomi/Mi)
  0xFD00,
  // Nordic UART Service (NUS)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  // ISSC Transparent UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  // WalkingPad / KingSmith
  'fe000000-0000-0000-0000-000000000000',
  // iConsole / LifeFitness variant
  '0000abcd-0000-1000-8000-00805f9b34fb',
];

// ─── Connect / Disconnect ──────────────────────────────────────────────────
async function connect(scanAll = false) {
  log(`Connect pressed — bluetooth: ${!!navigator.bluetooth}`, 'info');
  if (!navigator.bluetooth) {
    log('navigator.bluetooth is undefined — browser does not support Web Bluetooth', 'err');
    return;
  }
  var avail = await navigator.bluetooth.getAvailability();
  log('BT hardware available: ' + avail, avail ? 'ok' : 'err');
  const opts = { acceptAllDevices: true };

  try {
    setStatus('connecting', 'Scanning…');
    btnConnect.disabled = btnScanAll.disabled = true;
    device = await navigator.bluetooth.requestDevice(opts);
    log(`Found: ${device.name || '(unnamed)'}`, 'ok');
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setStatus('connecting', 'Connecting…');
    server = await device.gatt.connect();
    log('GATT connected', 'ok');

    await discoverAndSetup();

    setStatus('connected', `Connected: ${device.name || 'Tritur'}`);
    showConnectedUI(true);
    enableControls(hasFTMS);
    updateSpeedDisplay(targetSpeed);
    startGraph();
  } catch (err) {
    var name = err && err.name;
    var msg  = err && err.message;
    var code = err && err.code;
    log('Connection failed — name=' + name + ' msg=' + msg + ' code=' + code + ' raw=' + String(err), 'err');
    setStatus('', 'Disconnected');
    btnConnect.disabled = btnScanAll.disabled = false;
  }
}

function onDisconnected() {
  log('Device disconnected', 'warn');
  broadcastSpeed(0, false);
  if (window.runnerApplyKmh) window.runnerApplyKmh(0, false);
  stopGraph();
  cancelRamp();
  setStatus('', 'Disconnected');
  showConnectedUI(false);
  setRunning(false);
  ctrlChar = dataChar = statusChar = device = server = null;
  hasFTMS = false; customChars = [];
  servicesCard.style.display = 'none';
  customCard.style.display   = 'none';
  customCharSel.innerHTML    = '';
  customRx.textContent       = '';
  featuresRow.innerHTML      = '';
  btnConnect.disabled = btnScanAll.disabled = false;
}

async function disconnect() {
  if (device && device.gatt) device.gatt.disconnect();
}

// ─── Button handlers ───────────────────────────────────────────────────────
btnConnect.addEventListener('click',    () => connect(false));
btnScanAll.addEventListener('click',    () => connect(true));
btnDisconnect.addEventListener('click', disconnect);
document.getElementById('clearLog').addEventListener('click', () => logEl.innerHTML = '');

btnRetryCtrl.addEventListener('click', async () => {
  try { await requestControl(); } catch (e) { log(e.message, 'err'); }
});
btnReset.addEventListener('click', async () => {
  try {
    log('Sending Reset [0x01]…');
    await writeCtrl([OP.RESET]);
    await new Promise(r => setTimeout(r, 400));
    await requestControl();
    setRunning(false);
  } catch (e) { log(e.message, 'err'); }
});

btnStartStop.addEventListener('click', async () => {
  try { isRunning ? await sendStop() : await sendStart(); }
  catch (e) { log(e.message, 'err'); }
});

btnSlower.addEventListener('click', async () => {
  targetSpeed = Math.max(MIN_SPEED, targetSpeed - STEP);
  updateSpeedDisplay(targetSpeed);
  try { await sendSpeed(targetSpeed); } catch (e) { log(e.message, 'err'); }
});
btnFaster.addEventListener('click', async () => {
  targetSpeed = Math.min(MAX_SPEED, targetSpeed + STEP);
  updateSpeedDisplay(targetSpeed);
  try { await sendSpeed(targetSpeed); } catch (e) { log(e.message, 'err'); }
});

slider.addEventListener('input', () => {
  targetSpeed = parseFloat(slider.value);
  updateSpeedDisplay(targetSpeed);
});
slider.addEventListener('change', async () => {
  try { await sendSpeed(targetSpeed); } catch (e) { log(e.message, 'err'); }
});

// ─── Custom command tester ─────────────────────────────────────────────────
function parseHex(str) {
  return str.trim().split(/\s+/).map(b => parseInt(b, 16)).filter(b => !isNaN(b));
}

async function sendCustom() {
  const idx  = parseInt(customCharSel.value, 10);
  const entry = customChars[idx];
  if (!entry) { log('No characteristic selected', 'err'); return; }

  const bytes = parseHex(customHex.value);
  if (!bytes.length) { log('Enter hex bytes first (e.g. F7 01 04 04)', 'err'); return; }

  const buf = new Uint8Array(bytes);
  log(`Custom TX [${entry.uuid.substring(4,8).toUpperCase()}] → ${hexStr(buf)}`, 'tx');
  customRx.textContent = '…waiting for response…';

  try {
    const props = Object.entries(entry.char.properties).filter(([,v]) => v).map(([k]) => k);
    if (props.includes('writeWithoutResponse')) {
      await entry.char.writeValueWithoutResponse(buf);
    } else {
      await entry.char.writeValueWithResponse(buf);
    }
    log('Write OK', 'ok');
  } catch (e) {
    log(`Write failed: ${e.message}`, 'err');
    customRx.textContent = `Error: ${e.message}`;
  }
}

btnSendCustom.addEventListener('click', sendCustom);
customHex.addEventListener('keydown', e => { if (e.key === 'Enter') sendCustom(); });

// Preset buttons — fill hex field + auto-send
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    customHex.value = btn.dataset.hex;
    // Flash button green briefly
    btn.classList.add('fired');
    setTimeout(() => btn.classList.remove('fired'), 800);
    await sendCustom();
  });
});

// ─── Pixel Runner (embedded) ───────────────────────────────────────────────
(function initRunner() {
  const heroCanvas  = document.getElementById('rn-hero');
  const slimeCvs    = document.getElementById('rn-slime');
  const scene       = document.getElementById('runnerScene');
  const tilesEl     = document.querySelector('.rn-tiles');
  const grassEl     = document.querySelector('.rn-grass');
  const labelEl     = document.getElementById('rn-label');
  const dustCont    = document.getElementById('rn-dust');
  if (!heroCanvas) return;

  const ctx  = heroCanvas.getContext('2d');
  const sctx = slimeCvs.getContext('2d');

  // Palette
  const _ = null,  SK='#f8c8a0', HR='#c86000', EY='#000000',
        BL='#3860d8', BD='#2040a8', WT='#e8e8e8', YL='#f8d800',
        RD='#d82020', RK='#a01010', BN='#884420', BK='#553010';
  const SL='#1890e8', SD='#0060b0', SW='#ffffff', SE='#000000';

  const FRAMES=[[[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,EY,SK,SK,EY,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,YL,YL,YL,YL,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,RD,BL,BL,BL,BL,BL,BL,BL,BL,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,RD,BD,BL,BL,BL,BL,BL,BD,RD,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,SK,YL,BL,BL,BL,BL,BL,YL,SK,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,RD,SK,BL,BL,BL,BL,BL,BL,BL,SK,RD,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,_,_,YL,BL,BL,BL,BL,BL,YL,_,_,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BL,BL,BL,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BD,BD,BD,BD,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,BN,BN,BL,_,_,_,_,BL,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BN,BL,_,_,_,_,_,_,BL,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BK,_,_,_,_,_,_,_,_,BK,BN,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,BN,BK,_,_,_,_,_,_,_,_,_,_,BK,BN,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,BK,BK,BK,_,_,_,_,_,_,_,_,_,_,_,BK,BK,BK,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_]],[[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,EY,SK,SK,EY,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,YL,YL,YL,YL,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,RD,BL,BL,BL,BL,BL,BL,BL,BL,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,RD,BD,BL,BL,BL,BL,BL,BD,RD,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,SK,YL,BL,BL,BL,BL,BL,YL,SK,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,RD,SK,BL,BL,BL,BL,BL,BL,BL,SK,RD,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,_,_,YL,BL,BL,BL,BL,BL,YL,_,_,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BL,BL,BL,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BD,BD,BD,BD,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BN,BL,_,_,_,_,BL,BN,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BK,BN,_,_,_,_,_,_,_,_,BN,BK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_]],[[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,EY,SK,SK,EY,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,YL,YL,YL,YL,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,RD,BL,BL,BL,BL,BL,BL,BL,BL,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,RD,BD,BL,BL,BL,BL,BL,BD,RD,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,SK,YL,BL,BL,BL,BL,BL,YL,SK,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,RD,SK,BL,BL,BL,BL,BL,BL,BL,SK,RD,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,_,_,YL,BL,BL,BL,BL,BL,YL,_,_,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BL,BL,BL,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BD,BD,BD,BD,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,BN,BL,_,_,_,_,BL,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,BN,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,BN,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BK,BN,_,_,_,_,_,_,_,BN,BK,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,BK,BK,BK,_,_,_,_,_,_,_,_,_,_,BK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_]],[[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,HR,HR,HR,HR,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,EY,SK,SK,EY,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,HR,SK,SK,SK,SK,SK,SK,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,HR,YL,YL,YL,YL,HR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,RD,BL,BL,BL,BL,BL,BL,BL,BL,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,RD,BD,BL,BL,BL,BL,BL,BD,RD,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,RD,SK,YL,BL,BL,BL,BL,BL,YL,SK,RD,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,RD,SK,BL,BL,BL,BL,BL,BL,BL,SK,RD,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,RK,_,_,YL,BL,BL,BL,BL,BL,YL,_,_,RK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BL,BL,BL,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BL,BL,BD,BD,BD,BD,BL,BL,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,BN,BL,_,_,_,_,BL,BN,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,BN,BN,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,BK,BN,_,_,_,_,_,_,_,_,BN,BK,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_,_,_,BK,BK,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_]]];

  const SLIME_FRAMES=[[[_,_,SL,SL,SL,SL,_,_],[_,SL,SL,SL,SL,SL,SL,_],[SL,SL,SW,SE,SL,SW,SE,SL],[SL,SL,SL,SL,SL,SL,SL,SL],[SD,SD,SD,SD,SD,SD,SD,SD]],[[_,SL,SL,SL,SL,SL,SL,_],[_,SL,SL,SL,SL,SL,SL,_],[SL,SL,SW,SE,SL,SW,SE,SL],[SL,SL,SL,SL,SL,SL,SL,SL],[SD,SD,SD,SD,SD,SD,SD,SD]]];

  function drawFrame(f) {
    ctx.clearRect(0,0,32,32);
    const g=FRAMES[f];
    for(let r=0;r<32;r++) for(let c=0;c<32;c++){const col=g[r]&&g[r][c];if(col){ctx.fillStyle=col;ctx.fillRect(c,r,1,1);}}
  }
  function drawSlime(f) {
    sctx.clearRect(0,0,24,20);
    const g=SLIME_FRAMES[f];
    for(let r=0;r<g.length;r++) for(let c=0;c<8;c++){if(g[r][c]){sctx.fillStyle=g[r][c];sctx.fillRect(c,r+(f===0?0:1),1,1);}}
  }

  // State
  let currentTpf=9, currentSlimePx=1.2;
  let frame=0, tick=0, slimeFrame=0, slimeX=480, slimeTick=0, dustTick=0;

  // km/h → animation params (exponential curve, 1–16 km/h range)
  function kmhToParams(kmh) {
    if (kmh < 0.3) return { tpf:999, tileDur:'4s', slimePx:0.1, label:'— IDLE —' };
    const t = Math.max(0, Math.min(1, (kmh-1)/15));
    return {
      tpf:      Math.max(2, Math.round(22 * Math.pow(0.09, t))),
      tileDur:  Math.max(0.07, 1.0 * Math.pow(0.08, t)).toFixed(2) + 's',
      slimePx:  0.3 + 2.7*t,
      label:    kmh<4 ? '▼  WALKING' : kmh<9 ? '►  RUNNING!' : '▲  DASHING!!',
    };
  }

  function applyKmh(kmh, running) {
    const p = kmhToParams(running && kmh > 0.1 ? kmh : 0);
    currentTpf     = p.tpf;
    currentSlimePx = p.slimePx;
    tilesEl.style.animationDuration = p.tileDur;
    grassEl.style.animationDuration = p.tileDur;
    labelEl.textContent = running && kmh > 0.1
      ? `${kmh.toFixed(1)} KM/H  ${p.label}`
      : '— IDLE —';
    labelEl.style.color = running && kmh > 0.1 ? '#ffd700' : '#553300';
  }

  function spawnDust() {
    if (currentTpf > 16) return;
    const fast = currentTpf < 5;
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;width:${fast?8:4}px;height:${fast?8:4}px;`
      + `background:${fast?'#cc8800':'#886600'};`
      + `bottom:${52+Math.random()*10}px;left:${60+Math.random()*20}px;`
      + `opacity:0;animation:rn-dust-fly ${fast?'.3':'.5'}s ease-out forwards;`;
    dustCont.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }

  function loop() {
    tick++;
    if (currentTpf < 999 && tick >= currentTpf) { tick=0; frame=(frame+1)%4; drawFrame(frame); }
    slimeTick++;
    if (slimeTick%20===0) { slimeFrame=1-slimeFrame; drawSlime(slimeFrame); }
    slimeX -= currentSlimePx;
    if (slimeX < -60) slimeX = 650;
    slimeCvs.style.left = slimeX + 'px';
    dustTick++;
    const dustRate = currentTpf<5?4:currentTpf<12?12:999;
    if (dustTick%dustRate===0) spawnDust();
    requestAnimationFrame(loop);
  }

  function scaleScene() {
    const w = (scene.parentElement && scene.parentElement.clientWidth) || 380;
    const s = Math.min(1, w / 620);
    scene.style.transform = `scale(${s})`;
    scene.parentElement.style.height = (220*s) + 'px';
  }

  drawFrame(0); drawSlime(0); loop();
  scaleScene();
  window.addEventListener('resize', scaleScene);

  // Expose so treadmill app can drive it
  window.runnerApplyKmh = applyKmh;
})();

// ─── BroadcastChannel → pixel runner ──────────────────────────────────────
const runnerChannel = (() => {
  try { return new BroadcastChannel('treadmill-speed'); } catch { return null; }
})();
function broadcastSpeed(speed, running) {
  if (runnerChannel) runnerChannel.postMessage({ speed, running });
}

// ─── Speed history graph ───────────────────────────────────────────────────
const GRAPH_WINDOW_MS = 60000;
const GRAPH_MAX_KMH   = 16;
const graphCard   = document.getElementById('graphCard');
const graphCanvas = document.getElementById('speedGraph');

let speedHistory = [];   // [{t: timestamp ms, v: km/h}]
let graphTimer   = null;

function recordSpeed(v) {
  speedHistory.push({ t: Date.now(), v });
  // Keep only last 65 s (5 s buffer for the interpolated edge)
  const cutoff = Date.now() - GRAPH_WINDOW_MS - 5000;
  let i = 0;
  while (i < speedHistory.length - 1 && speedHistory[i].t < cutoff) i++;
  if (i > 0) speedHistory.splice(0, i);
}

function drawGraph() {
  if (!graphCanvas.clientWidth) return;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = graphCanvas.clientWidth;
  const cssH = graphCanvas.clientHeight;
  if (graphCanvas.width !== Math.round(cssW * dpr)) {
    graphCanvas.width  = Math.round(cssW * dpr);
    graphCanvas.height = Math.round(cssH * dpr);
  }
  const ctx = graphCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW, H = cssH;
  const PAD = { top: 8, right: 10, bottom: 22, left: 28 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top  - PAD.bottom;
  const now    = Date.now();
  const tStart = now - GRAPH_WINDOW_MS;

  // ── background ────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── horizontal grid + Y labels (0, 4, 8, 12, 16) ─────────────
  ctx.font          = `10px Menlo,Consolas,monospace`;
  ctx.textBaseline  = 'middle';
  ctx.textAlign     = 'right';
  for (let s = 0; s <= GRAPH_MAX_KMH; s += 4) {
    const y = PAD.top + ph * (1 - s / GRAPH_MAX_KMH);
    ctx.strokeStyle = s === 0 ? '#252525' : '#1c1c1c';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + pw, y); ctx.stroke();
    ctx.fillStyle = '#3a3a3a';
    ctx.fillText(s, PAD.left - 5, y);
  }

  // ── vertical grid + X labels (every 15 s) ────────────────────
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i <= 4; i++) {
    const sec = i * 15;
    const x   = PAD.left + (sec / 60) * pw;
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + ph); ctx.stroke();
    ctx.fillStyle = '#383838';
    ctx.fillText(i === 0 ? '−60s' : i === 4 ? 'now' : `−${60 - sec}s`, x, H - 3);
  }

  if (speedHistory.length === 0) return;

  // ── build point array clipped to the window ───────────────────
  // find last point before window (for smooth left edge)
  let beforeIdx = -1;
  for (let i = speedHistory.length - 1; i >= 0; i--) {
    if (speedHistory[i].t < tStart) { beforeIdx = i; break; }
  }
  let pts = speedHistory.filter(p => p.t >= tStart);
  if (beforeIdx >= 0) {
    // Interpolate speed at tStart for a clean left edge
    const b = speedHistory[beforeIdx];
    const a = pts[0] || b;
    const frac = (tStart - b.t) / Math.max(1, a.t - b.t);
    pts = [{ t: tStart, v: b.v + (a.v - b.v) * frac }, ...pts];
  }
  // Extend last known speed to "now" so the line reaches the right edge
  const lastKnown = speedHistory[speedHistory.length - 1];
  pts = [...pts, { t: now, v: lastKnown.v }];

  function toXY(p) {
    return [
      PAD.left + ((p.t - tStart) / GRAPH_WINDOW_MS) * pw,
      PAD.top  + ph * (1 - Math.min(Math.max(p.v, 0), GRAPH_MAX_KMH) / GRAPH_MAX_KMH),
    ];
  }

  const lineColor = isRunning ? '#22c55e' : '#4a4a4a';

  // ── gradient fill under curve ─────────────────────────────────
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ph);
  grad.addColorStop(0, isRunning ? '#22c55e28' : '#55555514');
  grad.addColorStop(1, 'transparent');
  ctx.beginPath();
  const [x0] = toXY(pts[0]);
  ctx.moveTo(x0, PAD.top + ph);
  for (const p of pts) { const [x, y] = toXY(p); ctx.lineTo(x, y); }
  const [xL] = toXY(pts[pts.length - 1]);
  ctx.lineTo(xL, PAD.top + ph);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── speed line ────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = toXY(pts[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── glowing dot at current speed ─────────────────────────────
  const [dx, dy] = toXY(lastKnown);
  ctx.beginPath();
  ctx.arc(dx, dy, 6, 0, Math.PI * 2);
  ctx.fillStyle = lineColor + '30';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dx, dy, 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
}

function startGraph() {
  document.getElementById('runnerCard').style.display = 'block';
  graphCard.style.display = 'block';
  if (graphTimer) clearInterval(graphTimer);
  graphTimer = setInterval(drawGraph, 500); // redraw 2×/s so x-axis scrolls smoothly
}
function stopGraph() {
  if (graphTimer) { clearInterval(graphTimer); graphTimer = null; }
  speedHistory = [];
  document.getElementById('runnerCard').style.display = 'none';
  graphCard.style.display = 'none';
}

// ─── Init ──────────────────────────────────────────────────────────────────
updateSpeedDisplay(targetSpeed);
log('App loaded v1.8 — bluetooth available: ' + (!!navigator.bluetooth), 'info');
log('Ready — click "Connect to Tritur" to begin.');
if (!navigator.bluetooth) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  browserWarn.style.display = 'block';
  if (isIOS) {
    browserWarn.innerHTML =
      '<strong>iOS detected:</strong> Safari and Chrome on iOS do not support Web Bluetooth ' +
      '(Apple restricts all browsers to WebKit).<br><br>' +
      'Use <strong><a href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055" ' +
      'style="color:#f59e0b">Bluefy</a></strong> — a free App Store browser with Web Bluetooth support.';
  } else {
    browserWarn.textContent = 'Web Bluetooth requires Chrome or Edge on desktop, or Bluefy on iOS.';
  }
  btnConnect.disabled = btnScanAll.disabled = true;
  log(isIOS
    ? 'iOS detected — use Bluefy app for Web Bluetooth support'
    : 'Web Bluetooth not available — use Chrome or Edge', 'err');
}
} catch(e) {
  var el = document.getElementById('jsTest');
  if (el) { el.textContent = 'app.js error: ' + e.message; el.style.color = '#ff0000'; }
}

