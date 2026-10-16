(() => {
  'use strict';

  const STORAGE_KEY = 'shunfeng-ledger-v1';
  const INSTALL_DISMISSED_KEY = 'shunfeng-install-tip-dismissed';
  const DEFAULT_PLATFORMS = [
    { id: 'dida', name: '嘀嗒出行', short: '嘀', color: '#e85d46', icon: 'assets/platforms/dida.png', builtIn: true },
    { id: 'hello', name: '哈啰', short: '哈', color: '#1b72e8', icon: 'assets/platforms/hello.png', builtIn: true },
    { id: 'didi', name: '滴滴', short: '滴', color: '#f0832f', icon: 'assets/platforms/didi.png', builtIn: true },
    { id: 'amap', name: '高德', short: '高', color: '#4f65db', icon: 'assets/platforms/amap.png', builtIn: true },
    { id: 'private', name: '私下交易', short: '私', color: '#337c63', builtIn: true }
  ];

  const moneyFormatter = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const state = {
    records: [],
    platforms: [],
    selectedPlatformId: 'dida',
    page: 'record',
    range: 'day',
    cursor: new Date(),
    metric: 'income'
  };
  let passengerTripNumberDirty = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function makeId(prefix) {
    if (globalThis.crypto && crypto.randomUUID) return prefix + '-' + crypto.randomUUID();
    return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function normalizePlatform(platform) {
    if (!platform || typeof platform.name !== 'string') return null;
    const name = platform.name.trim().slice(0, 8);
    if (!name) return null;
    const knownPlatform = DEFAULT_PLATFORMS.find((item) => item.id === platform.id);
    return {
      id: String(platform.id || makeId('platform')),
      name: name,
      short: String(platform.short || Array.from(name)[0] || '车').slice(0, 1),
      color: /^#[0-9a-f]{6}$/i.test(platform.color) ? platform.color : '#4f7c68',
      icon: knownPlatform && knownPlatform.icon ? knownPlatform.icon : '',
      builtIn: Boolean(platform.builtIn)
    };
  }

  function normalizeRecord(record) {
    if (!record || !Number.isFinite(Number(record.amount)) || !Number.isFinite(Number(record.distance))) return null;
    const timestamp = new Date(record.timestamp);
    if (Number.isNaN(timestamp.getTime())) return null;
    const rawPassengerTripNumber = Number(record.passengerTripNumber);
    return {
      id: String(record.id || makeId('trip')),
      timestamp: timestamp.toISOString(),
      platformId: String(record.platformId || 'private'),
      platformName: String(record.platformName || ''),
      amount: Math.max(0, Number(record.amount)),
      distance: Math.max(0, Number(record.distance)),
      passenger: String(record.passenger || '').replace(/\D/g, '').slice(-4),
      passengerTripNumber: Number.isInteger(rawPassengerTripNumber) && rawPassengerTripNumber > 0
        ? rawPassengerTripNumber
        : null
    };
  }

  function migratePassengerTripNumbers(records) {
    const latestByPassenger = new Map();
    const ordered = Array.from(records).sort((a, b) => {
      const timeDifference = new Date(a.timestamp) - new Date(b.timestamp);
      return timeDifference || a.id.localeCompare(b.id);
    });
    ordered.forEach((record) => {
      if (!record.passenger) {
        record.passengerTripNumber = null;
        return;
      }
      const latest = latestByPassenger.get(record.passenger) || 0;
      if (Number.isInteger(record.passengerTripNumber) && record.passengerTripNumber > 0) {
        latestByPassenger.set(record.passenger, Math.max(latest, record.passengerTripNumber));
        return;
      }
      record.passengerTripNumber = latest + 1;
      latestByPassenger.set(record.passenger, record.passengerTripNumber);
    });
    return records;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      state.records = Array.isArray(saved && saved.records)
        ? migratePassengerTripNumbers(saved.records.map(normalizeRecord).filter(Boolean))
        : [];
      state.platforms = Array.isArray(saved && saved.platforms) && saved.platforms.length
        ? saved.platforms.map(normalizePlatform).filter(Boolean)
        : DEFAULT_PLATFORMS.map((platform) => Object.assign({}, platform));
      state.selectedPlatformId = state.platforms.some((platform) => platform.id === (saved && saved.selectedPlatformId))
        ? saved.selectedPlatformId
        : state.platforms[0].id;
    } catch (error) {
      console.warn('无法读取已保存数据', error);
      state.records = [];
      state.platforms = DEFAULT_PLATFORMS.map((platform) => Object.assign({}, platform));
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 2,
        records: state.records,
        platforms: state.platforms,
        selectedPlatformId: state.selectedPlatformId
      }));
      return true;
    } catch (error) {
      console.error('保存失败', error);
      showToast('保存失败，请检查 Safari 存储空间');
      return false;
    }
  }

  function localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function platformFor(recordOrId) {
    const id = typeof recordOrId === 'string' ? recordOrId : recordOrId.platformId;
    const found = state.platforms.find((platform) => platform.id === id);
    if (found) return found;
    const fallbackName = typeof recordOrId === 'object' && recordOrId.platformName ? recordOrId.platformName : '其他平台';
    return { id: id, name: fallbackName, short: Array.from(fallbackName)[0] || '其', color: '#6f7772', icon: '' };
  }

  function platformMark(platform, imageClass) {
    if (platform.icon) {
      return '<img class="' + (imageClass || 'platform-image') + '" src="' + escapeHtml(platform.icon) + '" alt="">';
    }
    return escapeHtml(platform.short);
  }

  function updateDateHeader() {
    const now = new Date();
    $('#today-date').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(now);
    $('#today-weekday').textContent = '今天 · ' + new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
  }

  function renderPlatformPicker() {
    const visible = state.platforms.slice(0, 5);
    if (!visible.some((platform) => platform.id === state.selectedPlatformId)) {
      state.selectedPlatformId = visible[0] ? visible[0].id : state.platforms[0].id;
    }
    $('#platform-picker').innerHTML = visible.map((platform) => {
      const selected = platform.id === state.selectedPlatformId;
      return '<button class="platform-option ' + (selected ? 'selected' : '') + '" type="button" role="radio" aria-checked="' + selected + '" data-platform-id="' + escapeHtml(platform.id) + '" style="--platform-color:' + platform.color + '">' +
        '<b class="' + (platform.icon ? 'has-icon' : '') + '">' + platformMark(platform) + '</b><span>' + escapeHtml(platform.name) + '</span></button>';
    }).join('');
  }

  function renderHome() {
    updateDateHeader();
    renderPlatformPicker();
    const today = localDateKey(new Date());
    const records = state.records
      .filter((record) => localDateKey(record.timestamp) === today)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const income = sum(records, 'amount');
    const distance = sum(records, 'distance');
    $('#today-income').textContent = moneyFormatter.format(income);
    $('#today-distance').textContent = distance.toFixed(1);
    $('#today-count').textContent = records.length;
    $('#today-list-meta').textContent = records.length ? records.length + ' 单 · ' + distance.toFixed(1) + ' km' : '暂无记录';
    renderTripList(records);
    updatePassengerTripNumberInput();
  }

  function renderTripList(records) {
    const list = $('#today-list');
    if (!records.length) {
      list.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h16M6 17V9l2-4h8l2 4v8M8 12h.01M16 12h.01M7 17v2M17 17v2"/></svg><strong>今天还没有记录</strong><p>录入这一单的收入和里程，轻轻一点就完成。</p></div>';
      return;
    }
    list.innerHTML = records.map((record) => {
      const platform = platformFor(record);
      const gap = passengerTripGap(record);
      const passengerText = record.passenger
        ? '乘客 ···' + record.passenger + ' · 第 ' + record.passengerTripNumber + ' 次出行' + (gap ? '<em class="trip-gap">中间 ' + gap + ' 次未同行</em>' : '')
        : '未记录乘客';
      const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.timestamp));
      return '<button class="trip-item" type="button" data-record-id="' + escapeHtml(record.id) + '" aria-label="编辑 ' + escapeHtml(platform.name) + ' ' + record.amount.toFixed(2) + ' 元的记录">' +
        '<span class="trip-platform-icon ' + (platform.icon ? 'has-icon' : '') + '" style="--platform-color:' + platform.color + '">' + platformMark(platform) + '</span>' +
        '<span class="trip-main"><strong>' + escapeHtml(platform.name) + ' · ' + time + '</strong><span>' + passengerText + '</span></span>' +
        '<span class="trip-values"><strong>¥' + moneyFormatter.format(record.amount) + '</strong><span>' + record.distance.toFixed(1) + ' km</span></span></button>';
    }).join('');
  }

  function suggestedPassengerTripNumber(passenger, excludeRecordId) {
    if (passenger.length !== 4) return null;
    const recordedNumbers = state.records
      .filter((record) => record.passenger === passenger && record.id !== excludeRecordId)
      .map((record) => record.passengerTripNumber)
      .filter((value) => Number.isInteger(value) && value > 0);
    return (recordedNumbers.length ? Math.max.apply(null, recordedNumbers) : 0) + 1;
  }

  function passengerTripGap(target) {
    if (!target.passenger || !Number.isInteger(target.passengerTripNumber)) return 0;
    const targetTime = new Date(target.timestamp).getTime();
    const previous = state.records
      .filter((record) => record.id !== target.id && record.passenger === target.passenger && new Date(record.timestamp).getTime() < targetTime)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (!previous || !Number.isInteger(previous.passengerTripNumber)) return 0;
    return Math.max(0, target.passengerTripNumber - previous.passengerTripNumber - 1);
  }

  function updatePassengerTripNumberInput(forceSuggestion) {
    const passenger = $('#passenger-input').value.replace(/\D/g, '').slice(-4);
    const input = $('#passenger-count-input');
    const completePassenger = passenger.length === 4;
    input.disabled = !completePassenger;
    if (!completePassenger) {
      input.value = '';
      return;
    }
    if (forceSuggestion || !passengerTripNumberDirty || !input.value) {
      input.value = suggestedPassengerTripNumber(passenger);
    }
  }

  function updateEditPassengerTripNumber(forceSuggestion) {
    const passenger = $('#edit-passenger').value.replace(/\D/g, '').slice(-4);
    const input = $('#edit-passenger-count');
    const record = state.records.find((item) => item.id === $('#edit-id').value);
    const completePassenger = passenger.length === 4;
    input.disabled = !completePassenger;
    if (!completePassenger) {
      input.value = '';
      return;
    }
    if (forceSuggestion || !input.value) {
      input.value = record && passenger === record.passenger && record.passengerTripNumber
        ? record.passengerTripNumber
        : suggestedPassengerTripNumber(passenger, record && record.id);
    }
  }

  function validateTrip(amount, distance, passenger, passengerTripNumber) {
    if (!Number.isFinite(amount) || amount <= 0) return '请输入大于 0 的收入金额。';
    if (!Number.isFinite(distance) || distance <= 0) return '请输入大于 0 的行驶里程。';
    if (passenger && passenger.length !== 4) return '乘客手机尾号请输入 4 位数字，或留空。';
    if (passenger && (!Number.isInteger(passengerTripNumber) || passengerTripNumber < 1)) return '请输入乘客本次是第几次出行。';
    return '';
  }

  function submitTrip(event) {
    event.preventDefault();
    const amount = Number($('#amount-input').value);
    const distance = Number($('#distance-input').value);
    const passenger = $('#passenger-input').value.replace(/\D/g, '').slice(-4);
    const passengerTripNumber = passenger ? Number($('#passenger-count-input').value) : null;
    const error = validateTrip(amount, distance, passenger, passengerTripNumber);
    if (error) {
      $('#form-error').textContent = error;
      return;
    }
    const platform = platformFor(state.selectedPlatformId);
    const record = {
      id: makeId('trip'),
      timestamp: new Date().toISOString(),
      platformId: platform.id,
      platformName: platform.name,
      amount: round(amount, 2),
      distance: round(distance, 1),
      passenger: passenger,
      passengerTripNumber: passenger ? passengerTripNumber : null
    };
    state.records.push(record);
    if (!saveState()) {
      state.records.pop();
      return;
    }
    $('#trip-form').reset();
    passengerTripNumberDirty = false;
    $('#form-error').textContent = '';
    renderHome();
    showToast(passenger ? '已记录 · 尾号 ' + passenger + ' 第 ' + passengerTripNumber + ' 次出行' : '已记录这一单');
    $('#amount-input').focus({ preventScroll: true });
  }

  function renderPlatformManager() {
    $('#platform-manager-list').innerHTML = state.platforms.map((platform, index) => {
      return '<div class="platform-manager-row" data-platform-id="' + escapeHtml(platform.id) + '">' +
        '<span class="manager-icon ' + (platform.icon ? 'has-icon' : '') + '" style="--platform-color:' + platform.color + '">' + platformMark(platform) + '</span>' +
        '<span class="manager-name">' + escapeHtml(platform.name) + '</span>' +
        '<button type="button" class="manager-action" data-action="up" aria-label="上移 ' + escapeHtml(platform.name) + '" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
        '<button type="button" class="manager-action" data-action="down" aria-label="下移 ' + escapeHtml(platform.name) + '" ' + (index === state.platforms.length - 1 ? 'disabled' : '') + '>↓</button>' +
        '<button type="button" class="manager-action remove" data-action="remove" aria-label="删除 ' + escapeHtml(platform.name) + '" ' + (platform.builtIn ? 'disabled' : '') + '>×</button></div>';
    }).join('');
  }

  function managePlatformClick(event) {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('[data-platform-id]');
    if (!button || !row) return;
    const index = state.platforms.findIndex((platform) => platform.id === row.dataset.platformId);
    if (index < 0) return;
    const action = button.dataset.action;
    if (action === 'up' && index > 0) {
      const previous = state.platforms[index - 1];
      state.platforms[index - 1] = state.platforms[index];
      state.platforms[index] = previous;
    } else if (action === 'down' && index < state.platforms.length - 1) {
      const next = state.platforms[index + 1];
      state.platforms[index + 1] = state.platforms[index];
      state.platforms[index] = next;
    } else if (action === 'remove' && !state.platforms[index].builtIn) {
      const removed = state.platforms.splice(index, 1)[0];
      if (state.selectedPlatformId === removed.id) state.selectedPlatformId = state.platforms[0].id;
      showToast('已移除平台“' + removed.name + '”');
    } else {
      return;
    }
    saveState();
    renderPlatformManager();
    renderPlatformPicker();
  }

  function addPlatform() {
    const input = $('#new-platform-name');
    const name = input.value.trim();
    $('#platform-error').textContent = '';
    if (!name) {
      $('#platform-error').textContent = '请输入平台名称。';
      input.focus();
      return;
    }
    if (state.platforms.some((platform) => platform.name.toLowerCase() === name.toLowerCase())) {
      $('#platform-error').textContent = '这个平台已经存在。';
      return;
    }
    if (state.platforms.length >= 12) {
      $('#platform-error').textContent = '最多可保留 12 个平台。';
      return;
    }
    const platform = {
      id: makeId('platform'),
      name: name.slice(0, 8),
      short: Array.from(name)[0],
      color: $('#new-platform-color').value,
      icon: '',
      builtIn: false
    };
    state.platforms.push(platform);
    input.value = '';
    saveState();
    renderPlatformManager();
    renderPlatformPicker();
    showToast('已添加“' + platform.name + '”');
  }

  function openEditDialog(id) {
    const record = state.records.find((item) => item.id === id);
    if (!record) return;
    $('#edit-id').value = record.id;
    $('#edit-platform').innerHTML = state.platforms.map((platform) => '<option value="' + escapeHtml(platform.id) + '" ' + (platform.id === record.platformId ? 'selected' : '') + '>' + escapeHtml(platform.name) + '</option>').join('');
    $('#edit-datetime').value = toDatetimeLocal(new Date(record.timestamp));
    $('#edit-amount').value = record.amount;
    $('#edit-distance').value = record.distance;
    $('#edit-passenger').value = record.passenger;
    $('#edit-passenger-count').disabled = !record.passenger;
    $('#edit-passenger-count').value = record.passengerTripNumber || '';
    $('#edit-error').textContent = '';
    $('#edit-dialog').showModal();
  }

  function saveEditedTrip() {
    const record = state.records.find((item) => item.id === $('#edit-id').value);
    if (!record) return;
    const datetimeValue = $('#edit-datetime').value;
    let timestamp = new Date(datetimeValue);
    const originalTimestamp = new Date(record.timestamp);
    if (datetimeValue === toDatetimeLocal(originalTimestamp)) timestamp = originalTimestamp;
    const amount = Number($('#edit-amount').value);
    const distance = Number($('#edit-distance').value);
    const passenger = $('#edit-passenger').value.replace(/\D/g, '').slice(-4);
    const passengerTripNumber = passenger ? Number($('#edit-passenger-count').value) : null;
    const error = Number.isNaN(timestamp.getTime()) ? '请选择有效的日期和时间。' : validateTrip(amount, distance, passenger, passengerTripNumber);
    if (error) {
      $('#edit-error').textContent = error;
      return;
    }
    const platform = platformFor($('#edit-platform').value);
    Object.assign(record, {
      timestamp: timestamp.toISOString(),
      platformId: platform.id,
      platformName: platform.name,
      amount: round(amount, 2),
      distance: round(distance, 1),
      passenger: passenger,
      passengerTripNumber: passenger ? passengerTripNumber : null
    });
    saveState();
    $('#edit-dialog').close();
    renderHome();
    if (state.page === 'stats') renderStats();
    showToast('记录已更新');
  }

  function deleteEditedTrip() {
    const id = $('#edit-id').value;
    const record = state.records.find((item) => item.id === id);
    if (!record || !window.confirm('确认删除这条记录？删除后无法恢复。')) return;
    state.records = state.records.filter((item) => item.id !== id);
    saveState();
    $('#edit-dialog').close();
    renderHome();
    if (state.page === 'stats') renderStats();
    showToast('记录已删除');
  }

  function switchPage(page) {
    state.page = page;
    $('#record-page').hidden = page !== 'record';
    $('#stats-page').hidden = page !== 'stats';
    $('.app-shell').classList.toggle('stats-mode', page === 'stats');
    $$('.bottom-nav button').forEach((button) => {
      const active = button.dataset.page === page;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (page === 'stats') renderStats();
    else renderHome();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function sixYearStart() {
    return state.cursor.getFullYear() - 3;
  }

  function scopeBounds() {
    const year = state.cursor.getFullYear();
    if (state.range === 'day') return [new Date(year, state.cursor.getMonth(), 1), new Date(year, state.cursor.getMonth() + 1, 1)];
    if (state.range === 'month') return [new Date(year, 0, 1), new Date(year + 1, 0, 1)];
    const start = sixYearStart();
    return [new Date(start, 0, 1), new Date(start + 6, 0, 1)];
  }

  function scopeRecords() {
    const bounds = scopeBounds();
    return state.records.filter((record) => {
      const time = new Date(record.timestamp);
      return time >= bounds[0] && time < bounds[1];
    });
  }

  function renderStats() {
    renderPeriodLabel();
    renderCalendar();
    const records = scopeRecords();
    const income = sum(records, 'amount');
    const distance = sum(records, 'distance');
    $('#scope-income').textContent = moneyFormatter.format(income);
    $('#scope-distance').textContent = distance.toFixed(1);
    $('#scope-rate').textContent = distance > 0 ? moneyFormatter.format(income / distance) : '0.00';
    renderTrendChart();
    renderPlatformChart(records);
    updateExportLabels(records);
  }

  function renderPeriodLabel() {
    const year = state.cursor.getFullYear();
    if (state.range === 'day') $('#period-label').textContent = year + ' 年 ' + (state.cursor.getMonth() + 1) + ' 月';
    else if (state.range === 'month') $('#period-label').textContent = year + ' 年';
    else $('#period-label').textContent = sixYearStart() + '—' + (sixYearStart() + 5) + ' 年';
  }

  function renderCalendar() {
    const panel = $('#calendar-panel');
    const now = new Date();
    if (state.range === 'day') {
      const year = state.cursor.getFullYear();
      const month = state.cursor.getMonth();
      const days = new Date(year, month + 1, 0).getDate();
      const firstDay = new Date(year, month, 1).getDay();
      const aggregates = aggregateByKey(scopeRecords(), (record) => new Date(record.timestamp).getDate());
      let cells = Array.from({ length: firstDay }, () => '<div class="calendar-day empty" aria-hidden="true"></div>').join('');
      for (let day = 1; day <= days; day += 1) {
        const value = aggregates.get(day) ? aggregates.get(day).income : 0;
        const isToday = year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
        cells += '<div class="calendar-day ' + (isToday ? 'today' : '') + '"><span class="day-num">' + day + '</span><span class="day-value">' + (value ? '¥' + compactNumber(value) : '') + '</span></div>';
      }
      const remainder = (7 - ((firstDay + days) % 7)) % 7;
      cells += Array.from({ length: remainder }, () => '<div class="calendar-day empty" aria-hidden="true"></div>').join('');
      panel.innerHTML = '<div class="calendar-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="calendar-grid">' + cells + '</div>';
      return;
    }
    if (state.range === 'month') {
      const year = state.cursor.getFullYear();
      const aggregates = aggregateByKey(scopeRecords(), (record) => new Date(record.timestamp).getMonth());
      panel.innerHTML = '<div class="period-grid">' + Array.from({ length: 12 }, (_, month) => {
        const value = aggregates.get(month) ? aggregates.get(month).income : 0;
        const current = year === now.getFullYear() && month === now.getMonth();
        return '<div class="period-cell ' + (current ? 'current' : '') + '"><span>' + (month + 1) + ' 月</span><strong>' + (value ? '¥' + compactNumber(value) : '—') + '</strong></div>';
      }).join('') + '</div>';
      return;
    }
    const start = sixYearStart();
    const aggregates = aggregateByKey(scopeRecords(), (record) => new Date(record.timestamp).getFullYear());
    panel.innerHTML = '<div class="period-grid year-grid">' + Array.from({ length: 6 }, (_, index) => {
      const year = start + index;
      const value = aggregates.get(year) ? aggregates.get(year).income : 0;
      return '<div class="period-cell ' + (year === now.getFullYear() ? 'current' : '') + '"><span>' + year + ' 年</span><strong>' + (value ? '¥' + compactNumber(value) : '—') + '</strong></div>';
    }).join('') + '</div>';
  }

  function periodPoints() {
    const records = scopeRecords();
    if (state.range === 'day') {
      const year = state.cursor.getFullYear();
      const month = state.cursor.getMonth();
      const days = new Date(year, month + 1, 0).getDate();
      const data = aggregateByKey(records, (record) => new Date(record.timestamp).getDate());
      return Array.from({ length: days }, (_, index) => Object.assign({ label: String(index + 1) }, data.get(index + 1) || emptyAggregate()));
    }
    if (state.range === 'month') {
      const data = aggregateByKey(records, (record) => new Date(record.timestamp).getMonth());
      return Array.from({ length: 12 }, (_, index) => Object.assign({ label: (index + 1) + '月' }, data.get(index) || emptyAggregate()));
    }
    const start = sixYearStart();
    const data = aggregateByKey(records, (record) => new Date(record.timestamp).getFullYear());
    return Array.from({ length: 6 }, (_, index) => Object.assign({ label: String(start + index) }, data.get(start + index) || emptyAggregate()));
  }

  function renderTrendChart() {
    const points = periodPoints();
    const metric = state.metric;
    const values = points.map((point) => point[metric]);
    const max = Math.max.apply(null, values);
    const config = metricConfig(metric);
    $('#trend-title').textContent = config.label + '趋势';
    $('#platform-chart-title').textContent = '平台' + config.label;
    if (max <= 0) {
      $('#trend-chart').innerHTML = '<div class="chart-empty">当前范围暂无' + config.label + '数据</div>';
      return;
    }
    const width = 360;
    const height = 200;
    const margin = { top: 10, right: 11, bottom: 27, left: 43 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    const paddedMax = max * 1.12;
    const x = (index) => margin.left + (points.length === 1 ? chartWidth / 2 : index * chartWidth / (points.length - 1));
    const y = (value) => margin.top + chartHeight - (value / paddedMax) * chartHeight;
    const line = points.map((point, index) => (index ? 'L' : 'M') + ' ' + x(index).toFixed(2) + ' ' + y(point[metric]).toFixed(2)).join(' ');
    const area = line + ' L ' + x(points.length - 1).toFixed(2) + ' ' + (margin.top + chartHeight) + ' L ' + x(0).toFixed(2) + ' ' + (margin.top + chartHeight) + ' Z';
    const tickIndexes = chartTickIndexes(points.length);
    const yTicks = [0, paddedMax / 2, paddedMax];
    const dots = points.map((point, index) => point[metric] > 0
      ? '<circle class="dot ' + (index === lastPositiveIndex(values) ? 'last-dot' : '') + '" cx="' + x(index) + '" cy="' + y(point[metric]) + '" r="3.2"><title>' + point.label + '：' + formatMetric(point[metric], metric) + '</title></circle>'
      : '').join('');
    const grids = yTicks.map((value) => '<line class="grid-line" x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text class="axis-label" x="' + (margin.left - 6) + '" y="' + (y(value) + 3) + '" text-anchor="end">' + compactNumber(value) + '</text>').join('');
    const labels = tickIndexes.map((index) => '<text class="axis-label" x="' + x(index) + '" y="' + (height - 7) + '" text-anchor="middle">' + points[index].label + '</text>').join('');
    $('#trend-chart').innerHTML = '<svg class="trend-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="trend-svg-title trend-svg-desc">' +
      '<title id="trend-svg-title">' + config.label + '趋势</title><desc id="trend-svg-desc">当前范围内' + config.label + '最高值为 ' + formatMetric(max, metric) + '</desc>' +
      '<defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' +
      grids + '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>' + dots + labels + '</svg>';
  }

  function renderPlatformChart(records) {
    const metric = state.metric;
    const config = metricConfig(metric);
    const data = new Map();
    records.forEach((record) => {
      const platform = platformFor(record);
      if (!data.has(platform.id)) data.set(platform.id, { platform: platform, income: 0, distance: 0, count: 0 });
      const item = data.get(platform.id);
      item.income += record.amount;
      item.distance += record.distance;
      item.count += 1;
    });
    const rows = Array.from(data.values()).sort((a, b) => b[metric] - a[metric]);
    const max = Math.max.apply(null, [0].concat(rows.map((row) => row[metric])));
    $('#platform-chart-meta').textContent = '按' + config.label;
    if (!rows.length) {
      $('#platform-chart').innerHTML = '<div class="empty-state"><strong>暂无平台数据</strong><p>记录订单后，这里会自动按平台汇总。</p></div>';
      return;
    }
    $('#platform-chart').innerHTML = rows.map((row) => '<div class="bar-row"><span class="bar-label"><span class="bar-logo ' + (row.platform.icon ? 'has-icon' : '') + '" style="--platform-color:' + row.platform.color + '">' + platformMark(row.platform) + '</span><span class="bar-name">' + escapeHtml(row.platform.name) + '</span></span>' +
      '<span class="bar-track"><span class="bar-fill" style="--bar-color:' + row.platform.color + ';width:' + (max ? Math.max(3, row[metric] / max * 100) : 0) + '%"></span></span>' +
      '<span class="bar-value">' + formatMetric(row[metric], metric) + '</span></div>').join('');
  }

  function aggregateByKey(records, keyFn) {
    const map = new Map();
    records.forEach((record) => {
      const key = keyFn(record);
      if (!map.has(key)) map.set(key, emptyAggregate());
      const value = map.get(key);
      value.income += record.amount;
      value.distance += record.distance;
      value.count += 1;
    });
    return map;
  }

  function emptyAggregate() { return { income: 0, distance: 0, count: 0 }; }

  function metricConfig(metric) {
    return {
      income: { label: '收入', unit: '元' },
      distance: { label: '里程', unit: 'km' },
      count: { label: '订单', unit: '单' }
    }[metric];
  }

  function formatMetric(value, metric) {
    if (metric === 'income') return '¥' + compactNumber(value);
    if (metric === 'distance') return compactNumber(value) + ' km';
    return Math.round(value) + ' 单';
  }

  function chartTickIndexes(length) {
    if (length <= 5) return Array.from({ length: length }, (_, index) => index);
    return Array.from(new Set([0, Math.round((length - 1) / 3), Math.round((length - 1) * 2 / 3), length - 1]));
  }

  function lastPositiveIndex(values) {
    for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] > 0) return index;
    return -1;
  }

  function movePeriod(direction) {
    const cursor = new Date(state.cursor);
    if (state.range === 'day') cursor.setMonth(cursor.getMonth() + direction);
    else if (state.range === 'month') cursor.setFullYear(cursor.getFullYear() + direction);
    else cursor.setFullYear(cursor.getFullYear() + direction * 6);
    state.cursor = cursor;
    renderStats();
  }

  function setRange(range) {
    state.range = range;
    $$('.range-tabs button').forEach((button) => {
      const active = button.dataset.range === range;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    renderStats();
  }

  function periodDescription() {
    const year = state.cursor.getFullYear();
    if (state.range === 'day') return year + '年' + (state.cursor.getMonth() + 1) + '月';
    if (state.range === 'month') return year + '年';
    return sixYearStart() + '—' + (sixYearStart() + 5) + '年';
  }

  function updateExportLabels(records = scopeRecords()) {
    $('#export-scope-label').textContent = periodDescription() + ' · ' + records.length + ' 条';
    $('#export-all-label').textContent = '共 ' + state.records.length + ' 条';
  }

  function exportCsv(records, suffix) {
    if (!records.length) {
      showToast('当前没有可导出的记录');
      return;
    }
    const sorted = Array.from(records).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const header = ['日期', '时间', '平台', '收入(元)', '里程(公里)', '乘客手机尾号', '该乘客第几次出行'];
    const rows = sorted.map((record) => {
      const date = new Date(record.timestamp);
      return [
        localDateKey(date),
        String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'),
        platformFor(record).name,
        record.amount.toFixed(2),
        record.distance.toFixed(1),
        record.passenger,
        record.passengerTripNumber || ''
      ];
    });
    const csv = '\ufeff' + [header].concat(rows).map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '顺风账-' + localDateKey(new Date()).replaceAll('-', '') + '-' + suffix + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#export-dialog').close();
    showToast('已导出 ' + records.length + ' 条记录');
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function renderPeriodAndChartsAfterEdit() {
    renderHome();
    if (state.page === 'stats') renderStats();
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function setupDialogs() {
    $$('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  function openPlatformDialog() {
    $('#platform-error').textContent = '';
    renderPlatformManager();
    $('#platform-dialog').showModal();
  }

  function openExportDialog() {
    updateExportLabels();
    $('#export-dialog').showModal();
  }

  function chainDialog(from, to) {
    from.close();
    requestAnimationFrame(() => to.showModal());
  }

  function setupEvents() {
    $('#platform-picker').addEventListener('click', (event) => {
      const button = event.target.closest('[data-platform-id]');
      if (!button) return;
      state.selectedPlatformId = button.dataset.platformId;
      saveState();
      renderPlatformPicker();
    });
    $('#trip-form').addEventListener('submit', submitTrip);
    $('#passenger-input').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
      passengerTripNumberDirty = false;
      updatePassengerTripNumberInput(true);
    });
    $('#passenger-count-input').addEventListener('input', () => { passengerTripNumberDirty = true; });
    $('#manage-platforms').addEventListener('click', openPlatformDialog);
    $('#platform-manager-list').addEventListener('click', managePlatformClick);
    $('#add-platform-button').addEventListener('click', addPlatform);
    $('#new-platform-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addPlatform();
      }
    });
    $('#today-list').addEventListener('click', (event) => {
      const item = event.target.closest('[data-record-id]');
      if (item) openEditDialog(item.dataset.recordId);
    });
    $('#save-trip').addEventListener('click', saveEditedTrip);
    $('#delete-trip').addEventListener('click', deleteEditedTrip);
    $('#edit-passenger').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
      updateEditPassengerTripNumber(true);
    });
    $$('.bottom-nav button').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
    $$('.range-tabs button').forEach((button) => button.addEventListener('click', () => setRange(button.dataset.range)));
    $('#period-prev').addEventListener('click', () => movePeriod(-1));
    $('#period-next').addEventListener('click', () => movePeriod(1));
    $('#period-label').addEventListener('click', () => { state.cursor = new Date(); renderStats(); });
    $('#metric-select').addEventListener('change', (event) => { state.metric = event.target.value; renderStats(); });
    $('#open-export').addEventListener('click', openExportDialog);
    $('#export-scope').addEventListener('click', () => exportCsv(scopeRecords(), '当前范围'));
    $('#export-all').addEventListener('click', () => exportCsv(state.records, '全部'));
    $('#open-settings').addEventListener('click', () => $('#settings-dialog').showModal());
    $('#settings-platforms').addEventListener('click', () => { renderPlatformManager(); chainDialog($('#settings-dialog'), $('#platform-dialog')); });
    $('#settings-export').addEventListener('click', () => { updateExportLabels(); chainDialog($('#settings-dialog'), $('#export-dialog')); });
    $('#settings-install').addEventListener('click', () => chainDialog($('#settings-dialog'), $('#install-dialog')));
    $('#dismiss-install').addEventListener('click', () => {
      $('#install-tip').hidden = true;
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    });
  }

  function setupInstallTip() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const dismissed = localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
    if (!standalone && !dismissed) setTimeout(() => { $('#install-tip').hidden = false; }, 700);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('离线服务启用失败', error)));
    }
  }

  function sum(records, key) { return records.reduce((total, record) => total + Number(record[key] || 0), 0); }
  function round(value, digits) { const factor = Math.pow(10, digits); return Math.round((value + Number.EPSILON) * factor) / factor; }
  function compactNumber(value) {
    if (Math.abs(value) >= 10000) return (value / 10000).toFixed(value >= 100000 ? 0 : 1) + '万';
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'k';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(value < 10 ? 1 : 0);
  }
  function toDatetimeLocal(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
  }

  function init() {
    loadState();
    setupDialogs();
    setupEvents();
    setupInstallTip();
    renderHome();
    registerServiceWorker();
    $('#today-date').dataset.dateKey = localDateKey(new Date());
    setInterval(() => {
      const rendered = $('#today-date').dataset.dateKey;
      const current = localDateKey(new Date());
      if (rendered && rendered !== current) renderHome();
      $('#today-date').dataset.dateKey = current;
    }, 60000);
  }

  init();
})();
