'use strict';
const $ = id => document.getElementById(id);
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
function saved(key, fallback = '') { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function persist(key, value) { try { localStorage.setItem(key, value); return true; } catch { toast('Trình duyệt không cho phép lưu cấu hình.', 'warning'); return false; } }
let isDemo = false, espIp = saved('saved_esp_ip', 'smartgarden.local');
let chart = null, pollTimer = null, pollController = null;
let sourceVersion = 0, revision = 0, currentData = null, dataReceivedAt = 0;
let connected = false, commandPending = false, pumpSpinner = false, settingsDirty = false;
let previousData = null, flowBaseline = null, lastAiAttempt = 0, aiController = null;
let geminiSettingsVersion = 0;
let logHistory = [], chatHistory = [], demo = null;

function toast(message, kind = 'success') {
  const el = document.createElement('div'); el.className = `toast toast-${kind}`; el.textContent = message;
  $('toastContainer').appendChild(el);
  while ($('toastContainer').children.length > 4) $('toastContainer').firstChild.remove();
  setTimeout(() => el.remove(), 5000);
}
function initChart() {
  if (chart) return;
  if (typeof Chart === 'undefined') { $('chartFallback').hidden = false; return; }
  $('chartFallback').hidden = true;
  const gradient = rgb => context => {
    const area = context.chart.chartArea;
    if (!area) return `rgba(${rgb},0.08)`;
    const fill = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    fill.addColorStop(0, `rgba(${rgb},0.22)`); fill.addColorStop(1, `rgba(${rgb},0.01)`); return fill;
  };
  chart = new Chart($('realtimeChart').getContext('2d'), {
    type: 'line', data: { labels: [], datasets: [
      { label: 'Độ ẩm đất (%)', borderColor: '#10b981', backgroundColor: gradient('16,185,129'), fill: true, tension: 0.4, cubicInterpolationMode: 'monotone', data: [] },
      { label: 'Nhiệt độ (°C)', borderColor: '#f59e0b', backgroundColor: gradient('245,158,11'), fill: true, tension: 0.4, cubicInterpolationMode: 'monotone', yAxisID: 'temperature', data: [] }
    ] },
    options: { responsive: true, animation: false, interaction: { intersect: false, mode: 'index' },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2.5 } },
      plugins: { legend: { labels: { color: '#475569', usePointStyle: true } } },
      scales: { x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 8 } },
        y: { min: 0, max: 100, grid: { color: '#f1f5f9' }, title: { display: true, text: 'Độ ẩm (%)' } },
        temperature: { position: 'right', suggestedMin: 15, suggestedMax: 45, grid: { drawOnChartArea: false }, title: { display: true, text: 'Nhiệt độ (°C)' } } }
    }
  });
}
function addDataToChart(data) {
  if (!chart) return;
  if (chart.data.labels.length >= 60) { chart.data.labels.shift(); chart.data.datasets.forEach(set => set.data.shift()); }
  chart.data.labels.push(data.time && data.time !== '--:--:--' ? data.time : new Date().toLocaleTimeString('vi-VN'));
  chart.data.datasets[0].data.push(data.soil); chart.data.datasets[1].data.push(data.dht_valid === false ? null : data.temp); chart.update('none');
}
function meter(name, value) {
  $(name + 'BarFill').style.width = (Number.isFinite(value) ? clamp(name === 'temp' ? (value + 40) / 120 * 100 : value) : 0) + '%';
  if (Number.isFinite(value)) $(name + 'Meter').setAttribute('aria-valuenow', value);
  else $(name + 'Meter').removeAttribute('aria-valuenow');
}
function tankEmpty(data) {
  return data?.water === false || data?.water_pct < 15;
}

function renderPumpButton() {
  const btn = $('mainPumpBtn'), on = !!currentData?.pump;
  $('modeBtn').disabled = commandPending || !connected;
  $('saveSettingsBtn').disabled = commandPending || !connected;
  btn.disabled = commandPending || !connected || (!on && tankEmpty(currentData));
  btn.className = 'btn-pump ' + (on ? 'btn-pump-on' : 'btn-pump-off'); btn.setAttribute('aria-busy', String(commandPending)); btn.replaceChildren();
  if (pumpSpinner) { const spinner = document.createElement('span'); spinner.className = 'spinner'; spinner.setAttribute('aria-hidden', 'true'); btn.appendChild(spinner); }
  btn.appendChild(document.createTextNode(pumpSpinner ? 'Đang gửi lệnh...' : on ? 'TẮT MÁY BƠM NGAY' : 'BẬT MÁY BƠM'));
}
function updateFlow(data) {
  let text = '○ Bơm đang tắt', state = 'idle';
  if (data.pump) {
    if (!flowBaseline || !previousData?.pump || data.pump_time < previousData.pump_time) flowBaseline = { soil: data.soil, water: data.water_pct, confirmed: false };
    if (typeof data.flow_confirmed === 'boolean') {
      flowBaseline.confirmed = data.flow_confirmed;
    } else if (data.soil - flowBaseline.soil >= 2 || flowBaseline.water - data.water_pct >= 2) {
      flowBaseline.confirmed = true;
    }
    text = flowBaseline.confirmed ? '🟢 Nước đang chảy tốt' : '🟡 Đang kiểm tra dòng nước...'; state = flowBaseline.confirmed ? 'good' : 'checking';
  } else flowBaseline = null;
  if (data.flow_anomaly === true) { text = '⚠️ Cảnh báo: Bơm bật nhưng không ghi nhận nước ngấm!'; state = 'error'; }
  $('flowBadge').textContent = text; $('flowBadge').className = 'flow-badge flow-' + state;
}
function updateUI(data, sample = true) {
  const validPercent = value => Number.isFinite(value) && value >= 0 && value <= 100;
  if (!data || !validPercent(data.soil) || !validPercent(data.water_pct) || typeof data.pump !== 'boolean' || !['AUTO', 'MANU'].includes(data.mode)) throw new Error('Dữ liệu ESP32 không hợp lệ.');
  currentData = data; connected = true; dataReceivedAt = Date.now();
  $('statusDot').className = 'dot connected'; $('statusText').textContent = isDemo ? 'Demo · Dữ liệu mô phỏng' : 'Đã kết nối với ESP32'; $('statusText').style.color = '#059669';
  $('clockBox').textContent = '🕒 ' + (data.time && data.time !== '--:--:--' ? data.time : new Date().toLocaleTimeString('vi-VN'));
  const validDht = data.dht_valid !== false && Number.isFinite(data.temp) && Number.isFinite(data.hum);
  $('valTemp').textContent = validDht ? data.temp.toFixed(1) + ' °C' : '-- °C'; $('valHum').textContent = validDht ? data.hum.toFixed(1) + ' %' : '-- %';
  $('tempStatus').textContent = !validDht ? 'Lỗi đọc cảm biến' : data.temp > 32 ? 'Nhiệt độ cao · tăng thông thoáng' : data.temp < 20 ? 'Nhiệt độ thấp' : 'Trong dải nhiệt lý tưởng';
  $('valSoil').textContent = data.soil + ' %'; $('valRaw').textContent = 'Tín hiệu ADC: ' + (data.raw ?? '--'); $('valWater').textContent = data.water_pct + ' %';
  meter('temp', validDht ? data.temp : NaN); meter('hum', validDht ? data.hum : NaN); meter('soil', data.soil);
  $('waterBarFill').style.width = clamp(data.water_pct) + '%'; $('waterMeter').setAttribute('aria-valuenow', data.water_pct);
  const empty = tankEmpty(data);
  $('waterBarFill').style.backgroundColor = empty ? '#ef4444' : data.water_pct < 35 ? '#f59e0b' : '#3b82f6';
  $('waterSub').textContent = empty ? 'CẠN NƯỚC · KHÓA BƠM' : data.water_pct < 35 ? 'Sắp hết nước · cần châm thêm' : 'Nước đầy đủ';
  const dry = Number.isFinite(data.ai_dry_min) && data.ai_dry_min >= 0 ? data.ai_dry_min : null;
  $('edgePrediction').textContent = dry === null ? 'Edge AI · Chờ dữ liệu cảm biến' : dry === 0 ? 'Edge AI · Đất đã chạm ngưỡng khô' : `Edge AI · Khô sau ~${dry} phút`;
  const alerts = [];
  if (empty) alerts.push('Bình chứa cạn nước (<15%). Hệ thống khóa bơm để bảo vệ.');
  if (data.timeout_alert) alerts.push('Bơm đã tự ngắt sau 60 giây. Kiểm tra hệ thống trước khi bật lại thủ công.');
  if (data.flow_anomaly) alerts.push('Bơm bật nhưng không ghi nhận nước ngấm! Kiểm tra ống, bơm và cảm biến.');
  $('safetyAlertBanner').style.display = alerts.length ? 'block' : 'none'; $('safetyAlertMsg').textContent = alerts.join(' ');
  $('modeBtn').className = 'btn-mode ' + (data.mode === 'AUTO' ? 'mode-auto' : 'mode-manu'); $('modeBtn').textContent = data.mode === 'AUTO' ? 'TỰ ĐỘNG [AUTO]' : 'THỦ CÔNG [MANU]';
  $('pumpStatusLabel').textContent = data.pump ? 'ĐANG HOẠT ĐỘNG (BẬT)' : 'ĐANG DỪNG (TẮT)'; $('pumpStatusLabel').style.color = data.pump ? '#dc2626' : '#059669'; $('pumpDuration').textContent = data.pump_time || 0;
  renderPumpButton(); updateFlow(data);
  if (!settingsDirty && Number.isFinite(data.dry_th) && Number.isFinite(data.wet_th)) { $('sliderDry').value = data.dry_th; $('sliderWet').value = data.wet_th; renderThresholdLabels(); }
  if (previousData && data.pump !== previousData.pump) addLogEntry(data.time, data.pump ? 'Bật máy bơm' : 'Tắt máy bơm', data.soil + '%', data.temp + '°C', data.mode === 'AUTO' ? 'Tự động' : 'Thủ công');
  if (data.flow_anomaly && !previousData?.flow_anomaly) { addLogEntry(data.time, 'Cảnh báo dòng nước', data.soil + '%', data.temp + '°C', 'Kiểm tra ống, bơm, cảm biến'); toast('⚠️ Bơm bật nhưng không ghi nhận nước ngấm!', 'error'); }
  if (empty && !tankEmpty(previousData)) addLogEntry(data.time, 'Hết nước bình chứa', data.soil + '%', data.temp + '°C', 'Cảm biến mực nước');
  previousData = { ...data };
  $('localInsight').textContent = `${isDemo ? '[Mô phỏng] ' : ''}Đất ${data.soil}% · Bình nước ${data.water_pct}%. ` +
    (empty ? 'Châm thêm nước trước khi tưới. ' : data.flow_anomaly ? 'Ưu tiên kiểm tra đường nước. ' : data.soil < data.dry_th ? 'Đất dưới ngưỡng tưới đã cài đặt. ' : 'Theo dõi độ ẩm và tưới theo ngưỡng. ') +
    (dry === null ? 'Chưa đủ dữ liệu cảm biến cho dự đoán.' : `Ước tính chạm 40% sau ${dry} phút nếu không tưới; cần hiệu chuẩn theo loại đất.`);
  if (sample) addDataToChart(data); maybeAutoAnalyze();
}
function addLogEntry(time, event, soil, temp, note) {
  time = time || new Date().toLocaleTimeString('vi-VN'); const row = document.createElement('tr');
  [time, event, soil, temp, note].forEach(value => { const td = document.createElement('td'); td.textContent = value; row.appendChild(td); }); $('logTableBody').prepend(row);
  while ($('logTableBody').children.length > 150) $('logTableBody').lastChild.remove();
  logHistory.push({ time, event, soil, temp, note }); if (logHistory.length > 1000) logHistory.shift();
}
function baseUrl(raw = espIp) {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Nhập IP hoặc hostname ESP32 hợp lệ.');
  return url.origin;
}
async function request(path, signal, method = 'GET') {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); signal?.addEventListener('abort', abort, { once: true }); const timer = setTimeout(abort, 6000);
  try {
    const res = await fetch(baseUrl() + path, { method, mode: 'cors', cache: 'no-store', signal: controller.signal });
    if (!res.ok) {
      const messages = {
        400: 'ESP32 từ chối tham số lệnh (HTTP 400).',
        409: 'Bình chứa cạn nước, ESP32 đã khóa bơm (HTTP 409).',
        500: 'ESP32 gặp lỗi khi xử lý lệnh (HTTP 500).',
        503: 'ESP32 chưa sẵn sàng thực hiện lệnh (HTTP 503).'
      };
      const error = new Error(messages[res.status] || 'ESP32 trả lỗi HTTP ' + res.status + '.');
      error.status = res.status;
      throw error;
    }
    return await res.json();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function disconnected(message) {
  connected = false; $('statusDot').className = 'dot disconnected'; $('statusText').textContent = message; $('statusText').style.color = '#dc2626';
  $('flowBadge').className = 'flow-badge flow-checking'; $('flowBadge').textContent = '🟡 Chưa có dữ liệu mới để xác nhận dòng nước'; renderPumpButton();
}
async function fetchData() {
  clearTimeout(pollTimer); const version = sourceVersion, requestRevision = revision;
  if (commandPending) { pollTimer = setTimeout(fetchData, 2000); return; }
  if (isDemo) { simulateData(); pollTimer = setTimeout(fetchData, 2000); return; }
  pollController?.abort(); const controller = new AbortController(); pollController = controller;
  try { const data = await request('/api/data', controller.signal); if (version === sourceVersion && requestRevision === revision && !controller.signal.aborted) updateUI(data); }
  catch (err) { if (version === sourceVersion && requestRevision === revision && !controller.signal.aborted) disconnected('Mất kết nối ESP32 · Kiểm tra IP / WiFi'); }
  finally { if (version === sourceVersion && requestRevision === revision && pollController === controller && !controller.signal.aborted) pollTimer = setTimeout(fetchData, 2000); }
}
async function runCommand(path, demoAction, pump = false) {
  if (commandPending) return;
  commandPending = true; ++revision; pollController?.abort(); clearTimeout(pollTimer);
  const lockedInputs = ['demoBtn', 'espIp', 'sliderDry', 'sliderWet', 'demoScenario'];
  lockedInputs.forEach(id => { $(id).disabled = true; });
  renderPumpButton();
  const version = sourceVersion, spinnerTimer = pump ? setTimeout(() => { pumpSpinner = true; renderPumpButton(); }, 180) : null;
  let success = false;
  try {
    let data;
    if (isDemo) { demoAction(); data = demoSnapshot(); }
    else {
      data = await request(path, undefined, 'POST');
      if (typeof data?.pump !== 'boolean') data = await request('/api/data');
    }
    if (version !== sourceVersion) return;
    clearTimeout(spinnerTimer); pumpSpinner = false;
    updateUI(data, false);
    const params = new URLSearchParams(path.split('?')[1]);
    if (pump && data.pump !== (params.get('state') === '1')) {
      toast('ESP32 phản hồi nhưng bơm chưa ở trạng thái yêu cầu.', 'error');
      return;
    }
    if (path.startsWith('/api/settings')) {
      if (data.dry_th !== Number(params.get('dry')) || data.wet_th !== Number(params.get('wet'))) {
        toast('ESP32 chưa xác nhận ngưỡng yêu cầu.', 'error');
        return;
      }
      settingsDirty = false;
      $('sliderDry').value = data.dry_th;
      $('sliderWet').value = data.wet_th;
      renderThresholdLabels();
    }
    success = true;
    toast(isDemo ? 'Demo: Đã xác nhận lệnh mô phỏng thành công' : 'Đã xác nhận lệnh thành công (200 OK)');
  } catch (err) {
    if (version === sourceVersion) {
      toast(err.name === 'AbortError' ? 'Hết thời gian chờ. Đang đọc lại trạng thái; lệnh có thể đã được thực hiện.' : err.message, 'error');
      if (!isDemo && !err.status) disconnected('Đang đọc lại trạng thái ESP32...');
      if (err.status === 409) currentData = { ...currentData, water: false };
    }
  } finally {
    clearTimeout(spinnerTimer); pumpSpinner = false; commandPending = false;
    lockedInputs.forEach(id => { $(id).disabled = false; }); renderPumpButton();
    if (version === sourceVersion) pollTimer = setTimeout(fetchData, success ? 2000 : 0);
  }
}
function togglePump() {
  if (!connected || !currentData || commandPending) return;
  const target = !currentData.pump;
  if (target && tankEmpty(currentData)) return toast('Bình chứa cạn nước, bơm đã khóa.', 'error');
  return runCommand('/api/toggle?state=' + (target ? '1' : '0'), () => { demo.mode = 'MANU'; setDemoPump(target); }, true);
}
function toggleMode() {
  if (!connected || commandPending) return;
  const target = currentData.mode === 'AUTO' ? 'MANU' : 'AUTO';
  return runCommand('/api/mode?mode=' + (target === 'AUTO' ? 'auto' : 'manual'), () => { demo.mode = target; });
}
function renderThresholdLabels() { $('lblDry').textContent = $('sliderDry').value + '%'; $('lblWet').textContent = $('sliderWet').value + '%'; }
function onSliderChange() { settingsDirty = true; renderThresholdLabels(); }
function saveThresholds() {
  const dry = Number($('sliderDry').value), wet = Number($('sliderWet').value);
  if (!Number.isInteger(dry) || !Number.isInteger(wet) || dry >= wet || dry < 10 || dry > 60 || wet < 50 || wet > 95) return toast('Ngưỡng khô phải nhỏ hơn ngưỡng đủ ẩm và nằm trong dải cho phép.', 'error');
  if (!connected) return toast('Kết nối ESP32 hoặc bật Demo trước khi lưu.', 'warning');
  return runCommand(`/api/settings?dry=${dry}&wet=${wet}`, () => { demo.dry = dry; demo.wet = wet; });
}
function resetSource() {
  ++sourceVersion; ++revision; pollController?.abort(); aiController?.abort(); clearTimeout(pollTimer);
  previousData = null; flowBaseline = null; currentData = null; dataReceivedAt = 0; lastAiAttempt = 0; settingsDirty = false;
  logHistory = [];
  $('logTableBody').replaceChildren();
  $('toastContainer').replaceChildren();
  $('clockBox').textContent = '🕒 --:--:--';
  $('valTemp').textContent = '-- °C';
  ['valHum', 'valSoil', 'valWater'].forEach(id => { $(id).textContent = '-- %'; });
  $('valRaw').textContent = 'Tín hiệu ADC: --';
  $('tempStatus').textContent = $('waterSub').textContent = 'Đang chờ dữ liệu';
  $('edgePrediction').textContent = 'Edge AI · Đang chờ dữ liệu';
  ['temp', 'hum', 'soil', 'water'].forEach(name => meter(name, NaN));
  $('pumpStatusLabel').textContent = 'Chưa xác định';
  $('pumpDuration').textContent = '--';
  $('modeBtn').textContent = 'Chưa xác định';
  $('sliderDry').value = 40;
  $('sliderWet').value = 65;
  renderThresholdLabels();
  $('safetyAlertBanner').style.display = 'none';
  chatHistory = []; $('chatMessages').replaceChildren(); $('aiAnalysis').textContent = 'Đã đổi nguồn dữ liệu. Chờ nhận định mới.'; $('localInsight').textContent = 'Đang chờ dữ liệu từ nguồn mới...';
  if (chart) { chart.data.labels = []; chart.data.datasets.forEach(set => { set.data = []; }); chart.update('none'); }
  disconnected('Đang kết nối nguồn dữ liệu...');
}
function reconnect() {
  if (commandPending) return;
  try { baseUrl($('espIp').value.trim()); } catch (err) { return toast(err.message, 'error'); }
  espIp = $('espIp').value.trim(); persist('saved_esp_ip', espIp); resetSource(); fetchData();
}
// Cung phuong trinh voi firmware, chi dung cho du lieu mo phong.
function predictDemoMinutes(temp, hum, soil) { return soil <= 40 ? 0 : clamp(Math.ceil((soil - 40) / clamp(0.12 + 0.008 * (temp - 25) - 0.0012 * (hum - 60), 0.02, 0.8)), 1, 4320); }
function setDemoPump(on) {
  if (on && demo.water < 15) throw new Error('Demo: Bình chứa cạn nước, bơm bị khóa.');
  if (on === demo.pump) return;
  demo.pump = on;
  if (on) {
    demo.started = demo.lastTick = demo.flowStart = Date.now();
    demo.timeout = demo.anomaly = demo.confirmed = false;
    demo.baselineSoil = Math.floor(demo.soil);
    demo.baselineWater = Math.floor(demo.water);
  }
}
function applyDemoSafety() {
  if (demo.water < 15) setDemoPump(false);
  if (demo.pump && Date.now() - demo.started >= 60000) { setDemoPump(false); demo.timeout = true; }
  if (demo.mode === 'AUTO' && demo.water >= 15) {
    if (!demo.pump && !demo.timeout && demo.soil < demo.dry) setDemoPump(true);
    else if (demo.pump && demo.soil >= demo.wet) setDemoPump(false);
  }
}
function demoSnapshot() {
  return { temp: 29.6, hum: 66.2, dht_valid: true, soil: Math.floor(demo.soil), raw: Math.round(3500 - demo.soil * 21), water_pct: Math.floor(demo.water), water_raw: Math.round(200 + demo.water * 24), water: demo.water >= 15,
    pump: demo.pump, pump_time: demo.pump ? Math.floor((Date.now() - demo.started) / 1000) : 0, mode: demo.mode, timeout_alert: demo.timeout, flow_anomaly: demo.anomaly, flow_confirmed: demo.confirmed && !demo.anomaly,
    dry_th: demo.dry, wet_th: demo.wet, ai_dry_min: predictDemoMinutes(29.6, 66.2, Math.floor(demo.soil)), time: new Date().toLocaleTimeString('vi-VN') };
}
function simulateData() {
  const now = Date.now(), dt = clamp((now - demo.lastTick) / 1000, 0, 5); demo.lastTick = now;
  if (demo.pump && !demo.blocked) { demo.soil = clamp(demo.soil + dt * 0.55); demo.water = clamp(demo.water - dt * 0.24); }
  else if (!demo.pump) demo.soil = clamp(demo.soil - dt * 0.025);
  if (demo.pump && demo.water >= 15 && now - demo.started < 60000) {
    const soil = Math.floor(demo.soil), water = Math.floor(demo.water);
    if (soil - demo.baselineSoil >= 2 || demo.baselineWater - water >= 2) { demo.confirmed = true; demo.baselineSoil = soil; demo.baselineWater = water; demo.flowStart = now; }
    else if (now - demo.flowStart > 12000) { demo.anomaly = true; demo.confirmed = false; }
  }
  applyDemoSafety(); updateUI(demoSnapshot());
}
function toggleDemo() {
  if (commandPending) return;
  isDemo = !isDemo; resetSource();
  if (isDemo) demo = { soil: 46, water: 78, pump: false, mode: 'AUTO', dry: 40, wet: 65, started: 0, lastTick: Date.now(), timeout: false, anomaly: false, confirmed: false, blocked: false };
  $('demoBtn').textContent = 'Chế độ Demo: ' + (isDemo ? 'BẬT' : 'TẮT'); $('demoBtn').classList.toggle('demo-active', isDemo); $('demoControls').hidden = !isDemo; $('demoScenario').value = 'normal'; fetchData();
}
function changeDemoScenario() {
  if (!isDemo || commandPending) return;
  const scenario = $('demoScenario').value;
  setDemoPump(false); demo.mode = 'MANU'; demo.anomaly = false; demo.confirmed = false; demo.timeout = false; demo.blocked = scenario === 'blocked'; demo.water = scenario === 'empty' ? 10 : 78; demo.soil = 46; demo.lastTick = Date.now();
  updateUI(demoSnapshot(), false); toast('Đã đổi kịch bản Demo. Bật bơm để quan sát phản hồi.', 'warning');
}
function toggleKeyVisibility() {
  const visible = $('geminiKey').type === 'password'; $('geminiKey').type = visible ? 'text' : 'password'; $('keyVisibilityBtn').textContent = visible ? 'Ẩn key' : 'Hiện key'; $('keyVisibilityBtn').setAttribute('aria-pressed', String(visible));
}
function saveGeminiSettings() {
  const key = $('geminiKey').value.trim(), model = $('geminiModel').value.trim();
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) return toast('Tên model Gemini không hợp lệ.', 'error');
  ++geminiSettingsVersion;
  aiController?.abort();
  const keySaved = persist('gemini_api_key', key), modelSaved = persist('gemini_model', model);
  if (keySaved && modelSaved) toast(key ? 'Đã lưu cấu hình Gemini trên trình duyệt.' : 'Đã xóa key đã lưu.');
  $('aiAnalysis').textContent = key ? 'Đang chờ phân tích với cấu hình mới.' : 'Nhập key để dùng Gemini.';
  lastAiAttempt = 0; maybeAutoAnalyze();
}
function sensorContext() {
  if (!connected || !currentData || Date.now() - dataReceivedAt > 10000) throw new Error('Cần dữ liệu cảm biến mới. Kết nối ESP32 hoặc bật Demo.');
  const d = currentData;
  return `Nguồn: ${isDemo ? 'DEMO MÔ PHỎNG, không phải cảm biến thực' : 'ESP32 thực'}. ` + JSON.stringify({ temperature_c: d.dht_valid === false ? null : d.temp, air_humidity_pct: d.dht_valid === false ? null : d.hum, soil_pct: d.soil, tank_water_pct: d.water_pct, ai_dry_min: d.ai_dry_min, pump: d.pump, flow_anomaly: d.flow_anomaly, dry_threshold: d.dry_th, wet_threshold: d.wet_th, timeout_alert: d.timeout_alert });
}
async function callGemini(question, history = [], automatic = false) {
  if (aiController) throw new Error('Gemini đang xử lý yêu cầu trước.');
  const key = automatic ? saved('gemini_api_key') : $('geminiKey').value.trim();
  const model = automatic ? saved('gemini_model', 'gemini-2.0-flash') : $('geminiModel').value.trim();
  const draftModel = $('geminiModel').value;
  const settingsVersion = geminiSettingsVersion;
  if (!key) throw new Error('Nhập và lưu API Key Gemini trước.');
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error('Tên model Gemini không hợp lệ.');
  const context = sensorContext(), controller = new AbortController(); aiController = controller;
  const timer = setTimeout(() => controller.abort(), 30000); $('analyzeBtn').disabled = true; $('chatSendBtn').disabled = true;
  try {
    const instruction = 'Bạn là chuyên gia cây trồng. Trả lời ngắn gọn bằng tiếng Việt, văn bản thuần. Chỉ tư vấn, không điều khiển thiết bị. Ưu tiên cảnh báo cạn nước, dòng chảy bất thường và quá giờ. Dự đoán Edge AI là hồi quy kinh nghiệm chưa hiệu chuẩn, không phải kết quả đã kiểm chứng. Không bịa loại cây hay điều kiện chưa biết. Dữ liệu hiện tại: ' + context;
    const generate = name => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: controller.signal,
      body: JSON.stringify({ systemInstruction: { parts: [{ text: instruction }] }, contents: [...history, { role: 'user', parts: [{ text: question }] }] }) });
    let res = await generate(model), activeModel = model;
    // Model 1.5/2.0 cu da ngung phuc vu: fallback mot lan, khong retry loi key/quota.
    if (res.status === 404 && /^gemini-(1\.5|2\.0)-/.test(model)) {
      controller.signal.throwIfAborted();
      activeModel = 'gemini-2.5-flash-lite';
      res = await generate(activeModel);
    }
    if (!res.ok) {
      const messages = { 400: 'Kiểm tra API Key, model và cấu hình Gemini.', 401: 'API Key Gemini không hợp lệ.', 403: 'API Key không có quyền truy cập Gemini.', 404: 'Model không còn khả dụng. Hãy chọn model khác rồi lưu cấu hình.', 429: 'Gemini đã hết hạn mức hoặc quá nhiều yêu cầu. Thử lại sau.' };
      throw new Error(messages[res.status] || `Gemini tạm thời không khả dụng (HTTP ${res.status}).`);
    }
    const payload = await res.json(), answer = payload.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('\n').trim();
    controller.signal.throwIfAborted();
    if (!answer) throw new Error('Gemini chưa trả nội dung. Hãy thử câu hỏi khác.');
    if (activeModel !== model && settingsVersion === geminiSettingsVersion &&
        $('geminiModel').value === draftModel && draftModel.trim() === model) {
      $('geminiModel').value = activeModel; persist('gemini_model', activeModel);
      toast(`Model cũ không còn khả dụng. Đã chuyển sang ${activeModel}.`, 'warning');
    }
    return answer;
  } finally { clearTimeout(timer); if (aiController === controller) aiController = null; $('analyzeBtn').disabled = false; $('chatSendBtn').disabled = false; }
}
function maybeAutoAnalyze() {
  if (!connected || !saved('gemini_api_key') || aiController || Date.now() - lastAiAttempt < 300000 || document.hidden) return;
  analyzeGarden(true);
}
async function analyzeGarden(automatic = false) {
  if (aiController) return;
  const version = sourceVersion, settingsVersion = geminiSettingsVersion;
  lastAiAttempt = Date.now();
  $('aiAnalysis').textContent = 'Gemini đang phân tích dữ liệu vi khí hậu...';
  try {
    const answer = await callGemini('Phân tích vi khí hậu hiện tại, đánh giá nhu cầu tưới và đề xuất 3 việc chăm sóc cây cụ thể. Nêu rõ nếu dữ liệu là Demo.', [], automatic);
    if (version === sourceVersion && settingsVersion === geminiSettingsVersion) $('aiAnalysis').textContent = answer;
  } catch (err) {
    if (version !== sourceVersion || settingsVersion !== geminiSettingsVersion) return;
    const msg = err.name === 'AbortError' ? 'Gemini hết thời gian chờ. Edge AI vẫn hoạt động.' : err.message;
    $('aiAnalysis').textContent = msg;
    if (!automatic) toast(msg, 'error');
  }
}
function appendChat(text, role) {
  const el = document.createElement('p'); el.className = 'chat-message ' + role; el.textContent = text; $('chatMessages').appendChild(el);
  while ($('chatMessages').children.length > 24) $('chatMessages').firstChild.remove(); $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}
async function sendChat(event) {
  event.preventDefault(); const question = $('chatInput').value.trim(); if (!question || aiController) return;
  const version = sourceVersion, settingsVersion = geminiSettingsVersion;
  appendChat(question, 'user');
  $('chatInput').value = '';
  try {
    const answer = await callGemini(question, chatHistory);
    if (version !== sourceVersion || settingsVersion !== geminiSettingsVersion) return;
    appendChat(answer, 'assistant');
    chatHistory.push({ role: 'user', parts: [{ text: question }] }, { role: 'model', parts: [{ text: answer }] });
    chatHistory = chatHistory.slice(-8);
  } catch (err) {
    if (version === sourceVersion && settingsVersion === geminiSettingsVersion) {
      appendChat(err.name === 'AbortError' ? 'Hết thời gian chờ Gemini. Vui lòng thử lại.' : err.message, 'assistant');
    }
  }
}
function exportCSV() {
  if (!logHistory.length) return toast('Chưa có sự kiện để xuất.', 'warning');
  const quote = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const csv = '\uFEFFThời gian,Sự kiện,Độ ẩm đất,Nhiệt độ,Ghi chú\r\n' + logHistory.map(row => [row.time, row.event, row.soil, row.temp, row.note].map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a'); link.href = url; link.download = `Bao_Cao_Tuoi_ESP32_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function startDashboard() {
  $('espIp').value = espIp; $('geminiKey').value = saved('gemini_api_key'); $('geminiModel').value = saved('gemini_model', 'gemini-2.0-flash'); initChart(); renderPumpButton(); fetchData();
}
// Khong cho CDN Chart.js tri hoan khoi dong dieu khien khi offline.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startDashboard, { once: true });
else startDashboard();
