// Run: node --test tests/app.test.cjs (no external packages or ESP32 required).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');

function harness() {
  let now = 1_800_000_000_000, nextTimer = 1;
  const timers = new Map(), elements = new Map(), storage = new Map();
  class Element {
    constructor() { this.children = []; this.style = {}; this.attributes = {}; this.value = ''; this.type = 'password'; this.className = ''; this.disabled = false; this.hidden = false; this._text = ''; this.classList = { toggle: () => {} }; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children.at(-1); }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    replaceChildren() { this._text = ''; this.children = []; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    click() {}
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    assert.ok(!elements.has(match[1]), `Duplicate DOM id: ${match[1]}`);
    elements.set(match[1], new Element());
  }
  elements.get('sliderDry').value = '40'; elements.get('sliderWet').value = '65'; elements.get('espIp').value = 'smartgarden.local'; elements.get('geminiModel').value = 'gemini-2.0-flash';
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Blob, AbortController, Date: class extends Date { static now() { return now; } },
    document: { readyState: 'loading', addEventListener() {}, hidden: false, getElementById: id => { assert.ok(elements.has(id), `Missing DOM id: ${id}`); return elements.get(id); }, createElement: () => new Element(), createTextNode: text => { const el = new Element(); el.textContent = text; return el; } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: {}, setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async () => { throw new Error('No network fixture'); }
  });
  vm.runInContext(source, ctx);
  const evaluate = code => vm.runInContext(code, ctx);
  async function flush() { for (let i = 0; i < 20; ++i) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const jobs = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!jobs.length) break;
      const [id, job] = jobs[0]; now = job.at; timers.delete(id); job.fn(); await flush();
    }
    now = end; await flush();
  }
  const data = overrides => ({ temp: 29.6, hum: 66.2, soil: 46, raw: 2534, water_pct: 78, water: true, pump: false, mode: 'AUTO', pump_time: 0, dry_th: 40, wet_th: 65, ai_dry_min: 41, dht_valid: true, flow_anomaly: false, flow_confirmed: false, time: '10:00:00', ...overrides });
  return { ctx, evaluate, advance, flush, data, el: id => elements.get(id), storage, now: () => now };
}
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('HTTP 400/500 preserve the draft and distinguish REST errors from offline', async () => {
  for (const status of [400, 500]) {
    const h = harness();
    h.ctx.sample = h.data();
    h.evaluate('updateUI(sample)');
    h.el('sliderDry').value = '49';
    h.evaluate('onSliderChange()');
    h.ctx.fetch = async (_, options) => {
      assert.equal(options.method, 'POST');
      return { ok: false, status };
    };
    await h.evaluate('saveThresholds()');
    assert.equal(h.el('sliderDry').value, '49');
    assert.equal(h.el('sliderDry').disabled, false);
    assert.match(h.el('statusDot').className, /^dot connected$/);
    assert.match(h.el('toastContainer').textContent, new RegExp(String(status)));
  }
});

test('HTTP 200 with a mismatched pump snapshot never confirms the command', async () => {
  const h = harness();
  h.ctx.sample = h.data();
  h.evaluate('updateUI(sample)');
  h.ctx.fetch = async () => response(h.data());
  await h.evaluate('togglePump()');
  assert.doesNotMatch(h.el('toastContainer').textContent, /200 OK/);
  assert.match(h.el('toastContainer').textContent, /chưa ở trạng thái yêu cầu/);
});

test('An aborted poll within the same source cannot overwrite the newer snapshot', async () => {
  const h = harness(), old = deferred();
  h.ctx.fetch = () => old.promise;
  const first = h.evaluate('fetchData()');
  h.ctx.fetch = async () => response(h.data({ soil: 52 }));
  await h.evaluate('fetchData()');
  old.resolve(response(h.data({ soil: 12 })));
  await first;
  assert.equal(h.evaluate('currentData.soil'), 52);
});

test('Leaving Demo clears measurements and the CSV journal before ESP32 responds', async () => {
  const h = harness(), pending = deferred();
  h.evaluate('toggleDemo()');
  await h.evaluate('togglePump()');
  assert.equal(h.evaluate('logHistory.length'), 1);
  h.ctx.fetch = () => pending.promise;
  h.evaluate('toggleDemo()');
  assert.equal(h.el('valSoil').textContent, '-- %');
  assert.equal(h.el('logTableBody').children.length, 0);
  assert.equal(h.el('toastContainer').children.length, 0);
  assert.equal(h.evaluate('logHistory.length'), 0);
  assert.equal(h.el('mainPumpBtn').disabled, true);
  pending.resolve(response(h.data({ soil: 71 })));
  await h.flush();
  assert.equal(h.el('valSoil').textContent, '71 %');
});

test('Firmware flow flag overrides local estimates and low water blocks starts', async () => {
  const h = harness();
  h.ctx.sample = h.data({ pump: true });
  h.evaluate('updateUI(sample)');
  h.ctx.sample = h.data({ pump: true, soil: 60 });
  h.evaluate('updateUI(sample)');
  assert.match(h.el('flowBadge').textContent, /Đang kiểm tra/);
  h.ctx.sample = h.data({ water_pct: 14, water: true });
  h.evaluate('updateUI(sample); updateUI(sample)');
  assert.equal(h.el('mainPumpBtn').disabled, true);
  assert.equal(h.evaluate('logHistory.filter(entry => entry.event.includes("Hết nước")).length'), 1);
});

test('A retired-model response from an old source cannot launch fallback or change settings', async () => {
  const h = harness(), pending = deferred();
  h.evaluate('toggleDemo()');
  h.el('geminiKey').value = 'demo-key';
  let geminiRequests = 0;
  h.ctx.fetch = url => {
    if (!url.includes('googleapis')) return Promise.resolve(response(h.data()));
    geminiRequests++;
    return pending.promise;
  };
  const analysis = h.evaluate('analyzeGarden()');
  h.evaluate('toggleDemo()');
  pending.resolve({ ok: false, status: 404 });
  await analysis;
  assert.equal(geminiRequests, 1);
  assert.equal(h.storage.has('gemini_model'), false);
});

test('Automatic Gemini uses saved settings and fallback preserves an edited model', async () => {
  const h = harness(), pending = deferred();
  h.storage.set('gemini_api_key', 'saved-key');
  h.el('geminiKey').value = 'draft-key';
  h.el('geminiModel').value = 'gemini-editing';
  const requests = [];
  h.ctx.fetch = (url, options) => {
    requests.push([url, options.headers['x-goog-api-key']]);
    return requests.length === 1 ? pending.promise : Promise.resolve(response({
      candidates: [{ content: { parts: [{ text: 'Theo dõi đất.' }] } }]
    }));
  };
  h.evaluate('toggleDemo()');
  pending.resolve({ ok: false, status: 404 });
  await h.flush();
  assert.match(requests[0][0], /gemini-2.0-flash/);
  assert.match(requests[1][0], /gemini-2.5-flash-lite/);
  assert.ok(requests.every(([, key]) => key === 'saved-key'));
  assert.equal(h.el('geminiModel').value, 'gemini-editing');
  assert.match(h.el('aiAnalysis').textContent, /Theo dõi đất/);
});

test('Light theme and GPIO map remain unchanged; every literal DOM reference exists', () => {
  const h = harness(), css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
  assert.match(css, /--bg-color:\s*#f8fafc/); assert.match(css, /--card-bg:\s*#ffffff/);
  for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(h.el(match[1]), match[1]);
  const ino = fs.readFileSync(path.join(root, 'sketch_oct23a/sketch_oct23a.ino'), 'utf8');
  for (const [pin, number] of Object.entries({ OLED_SDA: 21, OLED_SCL: 22, SOIL_ADC: 34, WATER_ADC: 35, RELAY: 23, TOUCH: 4, DHT: 15 })) assert.match(ino, new RegExp(`#define PIN_${pin}\\s+${number}\\b`));
  assert.match(ino, /#define DHTTYPE\s+DHT22/); assert.match(ino, /SENSOR_INTERVAL\s*=\s*2000/);
});
test('Demo works without Chart.js, confirms flow, and manually switches to MANU', async () => {
  const h = harness(); h.evaluate('initChart(); toggleDemo()');
  assert.equal(h.el('chartFallback').hidden, false); assert.match(h.el('statusText').textContent, /Mô phỏng|mô phỏng/);
  await h.evaluate('togglePump()'); assert.equal(h.evaluate('demo.mode'), 'MANU'); assert.equal(h.evaluate('demo.pump'), true);
  assert.match(h.el('flowBadge').textContent, /Đang kiểm tra/);
  await h.advance(6000); assert.match(h.el('flowBadge').textContent, /Nước đang chảy tốt/);
  assert.equal(h.el('mainPumpBtn').disabled, false);
});
test('Blocked demo flow alarms only after 12 seconds, then stops at 60 seconds', async () => {
  const h = harness(); h.evaluate('toggleDemo()'); h.el('demoScenario').value = 'blocked'; h.evaluate('changeDemoScenario()'); await h.evaluate('togglePump()');
  await h.advance(12000); assert.equal(h.evaluate('demo.anomaly'), false);
  await h.advance(2000); assert.equal(h.evaluate('demo.anomaly'), true); assert.match(h.el('flowBadge').textContent, /Cảnh báo/);
  await h.advance(46000); assert.equal(h.evaluate('demo.pump'), false); assert.equal(h.evaluate('demo.timeout'), true);
});
test('AUTO respects thresholds and does not restart after timeout', async () => {
  const h = harness(); h.evaluate('toggleDemo(); demo.soil = 30; demo.blocked = true; applyDemoSafety()');
  assert.equal(h.evaluate('demo.pump'), true); await h.advance(64000);
  assert.equal(h.evaluate('demo.pump'), false); assert.equal(h.evaluate('demo.timeout'), true);
  h.evaluate('demo.timeout = false; demo.soil = 70; setDemoPump(true); applyDemoSafety()'); assert.equal(h.evaluate('demo.pump'), false);
});
test('Empty demo tank blocks pump, and valid thresholds affect AUTO', async () => {
  const h = harness(); h.evaluate('toggleDemo()'); h.el('demoScenario').value = 'empty'; h.evaluate('changeDemoScenario()');
  assert.equal(h.el('mainPumpBtn').disabled, true); await h.evaluate('togglePump()'); assert.equal(h.evaluate('demo.pump'), false);
  h.el('demoScenario').value = 'normal'; h.evaluate('changeDemoScenario()'); h.el('sliderDry').value = '50'; h.el('sliderWet').value = '70'; await h.evaluate('saveThresholds()');
  assert.equal(h.evaluate('demo.dry'), 50);
  await h.evaluate('toggleMode()');
  assert.equal(h.evaluate('demo.pump'), false);
  await h.advance(2000);
  assert.equal(h.evaluate('demo.pump'), true);
});
test('Fast response: no spinner, immediate confirmation; command spam sends once', async () => {
  const h = harness(), pending = deferred(); let calls = 0;
  h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.ctx.fetch = () => { calls++; return pending.promise; };
  const command = h.evaluate('togglePump()'); h.evaluate('togglePump()'); assert.equal(calls, 1); assert.equal(h.el('mainPumpBtn').disabled, true);
  await h.advance(100); assert.equal(h.el('mainPumpBtn').children.length, 1);
  pending.resolve(response(h.data({ pump: true, mode: 'MANU' }))); await command; await h.advance(100);
  assert.equal(h.el('mainPumpBtn').children.length, 1); assert.equal(h.el('mainPumpBtn').disabled, false); assert.match(h.el('toastContainer').textContent, /200 OK/);
});
test('Slow response: spinner appears at 180ms and clears on confirmation', async () => {
  const h = harness(), pending = deferred(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.ctx.fetch = () => pending.promise;
  const command = h.evaluate('togglePump()'); await h.advance(179); assert.doesNotMatch(h.el('mainPumpBtn').textContent, /Đang gửi/);
  await h.advance(1); assert.match(h.el('mainPumpBtn').textContent, /Đang gửi lệnh/);
  pending.resolve(response(h.data({ pump: true, mode: 'MANU' }))); await command;
  assert.match(h.el('mainPumpBtn').textContent, /TẮT/); assert.equal(h.el('mainPumpBtn').children.length, 1);
});
test('HTTP 409 does not produce a false success toast and releases command lock', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.ctx.fetch = async () => ({ ok: false, status: 409 });
  await h.evaluate('togglePump()'); assert.doesNotMatch(h.el('toastContainer').textContent, /200 OK/); assert.match(h.el('toastContainer').textContent, /khóa bơm/); assert.equal(h.evaluate('commandPending'), false);
});
test('Command timeout releases lock, removes spinner and does not retry the mutation', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); let mutations = 0;
  h.ctx.fetch = (url, options) => {
    if (!url.includes('/api/toggle')) return Promise.resolve(response(h.data({ pump: true, mode: 'MANU' })));
    mutations++; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
  };
  const command = h.evaluate('togglePump()'); await h.advance(6000); await command; await h.flush();
  assert.equal(h.evaluate('commandPending'), false); assert.equal(h.evaluate('pumpSpinner'), false); assert.equal(mutations, 1); assert.doesNotMatch(h.el('toastContainer').textContent, /200 OK/);
});
test('Delayed ESP32 polling response cannot overwrite Demo or confirmed command state', async () => {
  const h = harness(), pending = deferred(); h.ctx.fetch = () => pending.promise;
  const poll = h.evaluate('fetchData()'); h.evaluate('toggleDemo()'); pending.resolve(response(h.data({ soil: 5 }))); await poll;
  assert.equal(h.evaluate('currentData.soil'), 46); assert.match(h.el('statusText').textContent, /Demo/);
});
test('Polling started before pump command cannot undo its confirmed state', async () => {
  const h = harness(), pending = deferred(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)');
  h.ctx.fetch = url => url.includes('/api/data') ? pending.promise : Promise.resolve(response(h.data({ pump: true, mode: 'MANU' })));
  const poll = h.evaluate('fetchData()'); await h.evaluate('togglePump()'); pending.resolve(response(h.data({ pump: false }))); await poll;
  assert.equal(h.evaluate('currentData.pump'), true); assert.match(h.el('mainPumpBtn').textContent, /TẮT/);
});
test('Draft IP does not redirect commands until reconnect; dirty sliders survive polling', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.el('espIp').value = '192.168.1.250'; let sentTo = '';
  h.ctx.fetch = async url => { sentTo = url; return response(h.data({ pump: true, mode: 'MANU' })); };
  await h.evaluate('togglePump()'); assert.match(sentTo, /^http:\/\/smartgarden.local/);
  h.el('sliderDry').value = '55'; h.evaluate('onSliderChange(); updateUI(sample)'); assert.equal(h.el('sliderDry').value, '55');
});
test('Anomaly overrides green confirmation; invalid DHT hides stale values', () => {
  const h = harness(); h.ctx.sample = h.data({ pump: true, flow_confirmed: true, flow_anomaly: true, dht_valid: false, ai_dry_min: -1 }); h.evaluate('updateUI(sample)');
  assert.match(h.el('flowBadge').textContent, /Cảnh báo/); assert.match(h.el('valTemp').textContent, /--/); assert.match(h.el('edgePrediction').textContent, /Chờ/);
});
test('Gemini sends measured context and key header; response is inserted as plain text', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.el('geminiKey').value = 'test-key-only'; let request;
  h.ctx.fetch = async (url, options) => { request = { url, ...options }; return response({ candidates: [{ content: { parts: [{ text: '<img onerror=alert(1)> Tưới theo ngưỡng.' }] } }] }); };
  await h.evaluate('analyzeGarden()'); assert.match(request.url, /gemini-2.0-flash:generateContent$/); assert.equal(request.headers['x-goog-api-key'], 'test-key-only'); assert.ok(!request.url.includes('test-key-only'));
  const body = JSON.parse(request.body); assert.match(body.systemInstruction.parts[0].text, /tank_water_pct/); assert.match(body.systemInstruction.parts[0].text, /ai_dry_min/);
  assert.match(h.el('aiAnalysis').textContent, /<img/); assert.equal(h.el('aiAnalysis').children.length, 0);
  h.el('chatInput').value = 'Cây nên tưới lúc nào?'; await h.evaluate('sendChat({preventDefault(){}})'); assert.equal(h.evaluate('chatHistory.length'), 2);
});
test('Gemini model errors and missing key are surfaced without breaking local telemetry', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); await h.evaluate('analyzeGarden()'); assert.match(h.el('aiAnalysis').textContent, /API Key/);
  h.el('geminiKey').value = 'test-key-only'; h.ctx.fetch = async () => ({ ok: false, status: 404 }); await h.evaluate('analyzeGarden()');
  assert.match(h.el('aiAnalysis').textContent, /Model không còn khả dụng/); assert.equal(h.el('analyzeBtn').disabled, false); assert.equal(h.evaluate('connected'), true);
});
test('Retired Gemini model falls back once to supported Flash Lite and saves successful choice', async () => {
  const h = harness(); h.ctx.sample = h.data(); h.evaluate('updateUI(sample)'); h.el('geminiKey').value = 'test-key-only'; const urls = [];
  h.ctx.fetch = async url => { urls.push(url); return urls.length === 1 ? { ok: false, status: 404 } : response({ candidates: [{ content: { parts: [{ text: 'Đủ ẩm, theo dõi thêm.' }] } }] }); };
  await h.evaluate('analyzeGarden()'); assert.equal(urls.length, 2); assert.match(urls[1], /gemini-2.5-flash-lite/); assert.equal(h.storage.get('gemini_model'), 'gemini-2.5-flash-lite'); assert.match(h.el('aiAnalysis').textContent, /Đủ ẩm/);
});
test('Regression responds to temperature/humidity and handles dry threshold', () => {
  const h = harness(); assert.equal(h.evaluate('predictDemoMinutes(30, 60, 40)'), 0);
  assert.ok(h.evaluate('predictDemoMinutes(35, 60, 60) < predictDemoMinutes(25, 60, 60)'));
  assert.ok(h.evaluate('predictDemoMinutes(25, 90, 60) > predictDemoMinutes(25, 40, 60)'));
});
