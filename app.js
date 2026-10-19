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
    shifts: [],
    platforms: [],
    selectedPlatformId: 'dida',
    page: 'record',
    range: 'day',
    cursor: new Date(),
    trendPointIndex: null
  };
  let passengerTripNumberDirty = false;
  let reopenAllRecordsAfterEdit = false;
  let reopenShiftHistoryAfterFlow = false;
  let professionalBannerInitialized = false;
  let professionalTransitionTimer = null;
  let trendResizeTimer = null;

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

  function normalizeShift(shift) {
    if (!shift) return null;
    const start = new Date(shift.startTimestamp);
    const end = shift.endTimestamp ? new Date(shift.endTimestamp) : null;
    const mode = shift.distanceMode === 'trip' ? 'trip' : 'odometer';
    const startOdometer = shift.startOdometer == null || shift.startOdometer === '' ? null : Number(shift.startOdometer);
    const endOdometer = shift.endOdometer == null || shift.endOdometer === '' ? null : Number(shift.endOdometer);
    const distance = shift.distance == null || shift.distance === '' ? null : Number(shift.distance);
    if (Number.isNaN(start.getTime()) || (end && (Number.isNaN(end.getTime()) || end <= start))) return null;
    if (mode === 'odometer' && (!Number.isFinite(startOdometer) || startOdometer < 0)) return null;
    if (end && (!Number.isFinite(distance) || distance <= 0)) return null;
    return {
      id: String(shift.id || makeId('shift')),
      startTimestamp: start.toISOString(),
      endTimestamp: end ? end.toISOString() : null,
      distanceMode: mode,
      startOdometer: mode === 'odometer' ? startOdometer : null,
      endOdometer: mode === 'odometer' && Number.isFinite(endOdometer) ? endOdometer : null,
      distance: end ? round(distance, 1) : null
    };
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      state.records = Array.isArray(saved && saved.records) ? saved.records.map(normalizeRecord).filter(Boolean) : [];
      state.shifts = Array.isArray(saved && saved.shifts) ? saved.shifts.map(normalizeShift).filter(Boolean) : [];
      state.platforms = Array.isArray(saved && saved.platforms) && saved.platforms.length
        ? saved.platforms.map(normalizePlatform).filter(Boolean)
        : DEFAULT_PLATFORMS.map((platform) => Object.assign({}, platform));
      state.selectedPlatformId = state.platforms.some((platform) => platform.id === (saved && saved.selectedPlatformId))
        ? saved.selectedPlatformId
        : state.platforms[0].id;
    } catch (error) {
      console.warn('无法读取已保存数据', error);
      state.records = [];
      state.shifts = [];
      state.platforms = DEFAULT_PLATFORMS.map((platform) => Object.assign({}, platform));
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 3,
        records: state.records,
        shifts: state.shifts,
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
    $('#today-weekday').textContent = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
  }

  function activeShift() {
    return state.shifts.find((shift) => !shift.endTimestamp) || null;
  }

  function recordsForShift(shift, endValue) {
    const start = new Date(shift.startTimestamp).getTime();
    const end = new Date(endValue || shift.endTimestamp || Date.now()).getTime();
    return state.records.filter((record) => {
      const time = new Date(record.timestamp).getTime();
      return time >= start && time <= end;
    });
  }

  function shiftSummary(shift, endValue) {
    const records = recordsForShift(shift, endValue);
    return {
      records: records,
      income: sum(records, 'amount'),
      count: records.length,
      duration: Math.max(0, new Date(endValue || shift.endTimestamp || Date.now()).getTime() - new Date(shift.startTimestamp).getTime())
    };
  }

  function formatDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (!totalMinutes) return '< 1 分钟';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return minutes + ' 分钟';
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainingHours = hours % 24;
      return days + ' 天' + (remainingHours ? ' ' + remainingHours + ' 小时' : '') + (minutes ? ' ' + minutes + ' 分钟' : '');
    }
    return hours + ' 小时' + (minutes ? ' ' + minutes + ' 分钟' : '');
  }

  function formatCompactDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (!totalMinutes) return '<1分钟';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor(totalMinutes % 1440 / 60);
    const minutes = totalMinutes % 60;
    if (days) return days + '天' + (hours ? hours + '小时' : '');
    if (hours) return hours + '小时' + (minutes ? minutes + '分' : '');
    return minutes + '分钟';
  }

  function formatShiftDateTime(value, includeYear) {
    const date = new Date(value);
    const pad = (number) => String(number).padStart(2, '0');
    const year = includeYear || date.getFullYear() !== new Date().getFullYear() ? date.getFullYear() + '年' : '';
    return year + (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function shiftOverlaps(start, end, excludeId) {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Infinity;
    return state.shifts.some((shift) => {
      if (shift.id === excludeId) return false;
      const otherStart = new Date(shift.startTimestamp).getTime();
      const otherEnd = shift.endTimestamp ? new Date(shift.endTimestamp).getTime() : Infinity;
      return startTime < otherEnd && endTime > otherStart;
    });
  }

  function renderProfessionalBanner() {
    const shift = activeShift();
    const banner = $('#professional-banner');
    const summaryBanner = banner.closest('.summary-banner');
    const nextActive = Boolean(shift);
    const wasActive = summaryBanner.classList.contains('professional-active');
    const shouldAnimate = professionalBannerInitialized && wasActive !== nextActive;
    if (shouldAnimate) {
      const action = banner.querySelector('[data-shift-action]');
      if (action) {
        const bannerBounds = summaryBanner.getBoundingClientRect();
        const actionBounds = action.getBoundingClientRect();
        const originX = (actionBounds.left + actionBounds.width / 2 - bannerBounds.left) / bannerBounds.width * 100;
        const originY = (actionBounds.top + actionBounds.height / 2 - bannerBounds.top) / bannerBounds.height * 100;
        summaryBanner.style.setProperty('--professional-origin-x', originX.toFixed(2) + '%');
        summaryBanner.style.setProperty('--professional-origin-y', originY.toFixed(2) + '%');
      }
      summaryBanner.classList.add('professional-transitioning');
      clearTimeout(professionalTransitionTimer);
      professionalTransitionTimer = setTimeout(() => summaryBanner.classList.remove('professional-transitioning'), 760);
    }
    banner.classList.toggle('active', nextActive);
    summaryBanner.classList.toggle('professional-active', nextActive);
    professionalBannerInitialized = true;
    $('#professional-status-text').textContent = shift ? '出车中' : '当前模式';
    $('#professional-mode-title').textContent = shift ? '专职模式' : '顺路模式';
    if (!shift) {
      $('#professional-content').innerHTML = '<div class="professional-idle"><span>顺路接单</span><button type="button" class="professional-action" data-shift-action="start">出车</button></div>';
      return;
    }
    const summary = shiftSummary(shift);
    const startTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(shift.startTimestamp));
    $('#professional-content').innerHTML = '<div class="professional-active-summary"><span>' + startTime + ' 出车 · ' + escapeHtml(formatDuration(summary.duration)) + '</span><strong>¥' + moneyFormatter.format(summary.income) + '<small>' + summary.count + ' 单</small></strong></div>' +
      '<button type="button" class="professional-action stop" data-shift-action="stop">收车</button>';
  }

  function updateStartShiftMode() {
    const mode = $('input[name="start-distance-mode"]:checked').value;
    $('#start-odometer-field').hidden = mode !== 'odometer';
    $('#start-mode-note').textContent = mode === 'odometer'
      ? '收车时再填写结束读数，系统会自动计算总里程。'
      : '出车时无需填写里程，收车时直接填写本次总行驶里程。';
    $('#start-shift-error').textContent = '';
  }

  function openStartShiftDialog() {
    if (activeShift()) {
      openStopShiftDialog();
      return;
    }
    $('input[name="start-distance-mode"][value="odometer"]').checked = true;
    $('#start-odometer').value = '';
    $('#start-shift-error').textContent = '';
    updateStartShiftMode();
    $('#start-shift-dialog').showModal();
  }

  function confirmStartShift() {
    const mode = $('input[name="start-distance-mode"]:checked').value;
    const startOdometer = mode === 'odometer' ? Number($('#start-odometer').value) : null;
    if (mode === 'odometer' && (!Number.isFinite(startOdometer) || startOdometer < 0 || $('#start-odometer').value === '')) {
      $('#start-shift-error').textContent = '请输入当前里程表读数。';
      return;
    }
    const now = new Date();
    if (shiftOverlaps(now, null)) {
      $('#start-shift-error').textContent = '当前时间与已有专职记录重叠，请先检查出车记录。';
      return;
    }
    const shift = {
      id: makeId('shift'),
      startTimestamp: now.toISOString(),
      endTimestamp: null,
      distanceMode: mode,
      startOdometer: mode === 'odometer' ? round(startOdometer, 1) : null,
      endOdometer: null,
      distance: null
    };
    state.shifts.push(shift);
    if (!saveState()) {
      state.shifts.pop();
      return;
    }
    $('#start-shift-dialog').close();
    renderProfessionalBanner();
    showToast('已出车，开始记录本次专职行程');
  }

  function updateStopShiftMode() {
    const shift = activeShift();
    if (!shift) return;
    const mode = shift.distanceMode === 'trip' ? 'trip' : $('input[name="stop-distance-mode"]:checked').value;
    $('#stop-odometer-field').hidden = mode !== 'odometer';
    $('#stop-trip-distance-field').hidden = mode !== 'trip';
    $('#stop-shift-error').textContent = '';
    updateCalculatedShiftDistance();
  }

  function updateCalculatedShiftDistance() {
    const shift = activeShift();
    if (!shift || shift.distanceMode !== 'odometer') return;
    const end = Number($('#stop-odometer').value);
    const valid = $('#stop-odometer').value !== '' && Number.isFinite(end) && end >= shift.startOdometer;
    $('#calculated-shift-distance').textContent = valid
      ? '本次行驶 ' + round(end - shift.startOdometer, 1).toFixed(1) + ' km'
      : '出车读数 ' + Number(shift.startOdometer).toFixed(1) + ' km';
  }

  function openStopShiftDialog() {
    const shift = activeShift();
    if (!shift) return;
    const summary = shiftSummary(shift);
    $('#stop-shift-duration').textContent = formatDuration(summary.duration);
    $('#stop-shift-income').textContent = moneyFormatter.format(summary.income);
    $('#stop-shift-count').textContent = summary.count;
    $('#stop-shift-error').textContent = '';
    $('#stop-odometer').value = '';
    $('#stop-trip-distance').value = '';
    $('#stop-distance-modes').hidden = shift.distanceMode !== 'odometer';
    if (shift.distanceMode === 'odometer') $('input[name="stop-distance-mode"][value="odometer"]').checked = true;
    updateStopShiftMode();
    $('#stop-shift-dialog').showModal();
  }

  function confirmStopShift() {
    const shift = activeShift();
    if (!shift) return;
    const mode = shift.distanceMode === 'trip' ? 'trip' : $('input[name="stop-distance-mode"]:checked').value;
    let distance;
    let endOdometer = null;
    if (mode === 'odometer') {
      endOdometer = Number($('#stop-odometer').value);
      distance = endOdometer - shift.startOdometer;
      if ($('#stop-odometer').value === '' || !Number.isFinite(endOdometer) || endOdometer < shift.startOdometer) {
        $('#stop-shift-error').textContent = '结束里程表不能小于出车时的读数。';
        return;
      }
    } else {
      distance = Number($('#stop-trip-distance').value);
    }
    if (!Number.isFinite(distance) || distance <= 0) {
      $('#stop-shift-error').textContent = '请输入大于 0 的本次总行驶里程。';
      return;
    }
    const end = new Date();
    if (shiftOverlaps(shift.startTimestamp, end, shift.id)) {
      $('#stop-shift-error').textContent = '本次时间与已有专职记录重叠，请先检查出车记录。';
      return;
    }
    const previous = Object.assign({}, shift);
    Object.assign(shift, {
      endTimestamp: end.toISOString(),
      distanceMode: mode,
      startOdometer: mode === 'odometer' ? shift.startOdometer : null,
      endOdometer: mode === 'odometer' ? round(endOdometer, 1) : null,
      distance: round(distance, 1)
    });
    if (!saveState()) {
      Object.assign(shift, previous);
      return;
    }
    $('#stop-shift-dialog').close();
    renderProfessionalBanner();
    if (state.page === 'stats') renderStats();
    const summary = shiftSummary(shift);
    showToast('已收车 · ' + formatDuration(summary.duration) + ' · ' + shift.distance.toFixed(1) + ' km');
  }

  function cancelActiveShift() {
    const shift = activeShift();
    if (!shift || !window.confirm('确认放弃本次出车记录？订单记录不会被删除。')) return;
    const previous = state.shifts.slice();
    state.shifts = state.shifts.filter((item) => item.id !== shift.id);
    if (!saveState()) {
      state.shifts = previous;
      return;
    }
    $('#stop-shift-dialog').close();
    renderProfessionalBanner();
    showToast('已放弃本次出车记录');
  }

  function renderShiftHistory() {
    const shifts = Array.from(state.shifts).sort((a, b) => new Date(b.startTimestamp) - new Date(a.startTimestamp));
    const completed = shifts.filter((shift) => shift.endTimestamp);
    const totalDuration = completed.reduce((total, shift) => total + shiftSummary(shift).duration, 0);
    $('#shift-history-meta').textContent = shifts.length
      ? completed.length + ' 次已完成' + (totalDuration ? ' · ' + formatDuration(totalDuration) : '')
      : '暂无记录';
    if (!shifts.length) {
      $('#shift-history-list').innerHTML = '<div class="empty-state"><strong>还没有专职出车记录</strong><p>在首页开启“出车”，收车后会在这里生成明细。</p></div>';
      return;
    }
    $('#shift-history-list').innerHTML = shifts.map((shift) => {
      const summary = shiftSummary(shift);
      const active = !shift.endTimestamp;
      const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(shift.startTimestamp));
      const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(shift.startTimestamp));
      const crossesDate = !active && localDateKey(shift.startTimestamp) !== localDateKey(shift.endTimestamp);
      const endTime = active
        ? '进行中'
        : crossesDate
          ? formatShiftDateTime(shift.endTimestamp)
          : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(shift.endTimestamp));
      return '<button type="button" class="shift-history-item ' + (active ? 'active' : '') + '" data-shift-id="' + escapeHtml(shift.id) + '">' +
        '<span class="shift-history-top"><strong>' + escapeHtml(date) + '</strong>' + (active ? '<em>出车中</em>' : '<b>¥' + moneyFormatter.format(summary.income) + '</b>') + '</span>' +
        '<span class="shift-history-time">' + time + ' — ' + endTime + ' · ' + escapeHtml(formatDuration(summary.duration)) + '</span>' +
        '<span class="shift-history-meta">' + summary.count + ' 单' + (active ? '' : ' · ' + Number(shift.distance).toFixed(1) + ' km · ¥' + moneyFormatter.format(shift.distance > 0 ? summary.income / shift.distance : 0) + '/km') + '</span></button>';
    }).join('');
  }

  function openShiftHistory() {
    reopenShiftHistoryAfterFlow = false;
    renderShiftHistory();
    $('#shift-history-dialog').showModal();
  }

  function updateEditShiftDateTimeDisplay() {
    [['#edit-shift-start', '#edit-shift-start-display'], ['#edit-shift-end', '#edit-shift-end-display']].forEach((selectors) => {
      const value = $(selectors[0]).value;
      $(selectors[1]).value = value ? value.replace('T', ' ') : '请选择时间';
    });
  }

  function openEditShiftDialog(id) {
    const shift = state.shifts.find((item) => item.id === id && item.endTimestamp);
    if (!shift) return;
    const summary = shiftSummary(shift);
    $('#edit-shift-id').value = shift.id;
    $('#edit-shift-start').value = toDatetimeLocal(new Date(shift.startTimestamp));
    $('#edit-shift-end').value = toDatetimeLocal(new Date(shift.endTimestamp));
    $('#edit-shift-distance').value = shift.distance;
    $('#edit-shift-summary').textContent = summary.count + ' 单 · 收入 ¥' + moneyFormatter.format(summary.income) + ' · ' + formatDuration(summary.duration);
    $('#edit-shift-error').textContent = '';
    updateEditShiftDateTimeDisplay();
    $('#edit-shift-dialog').showModal();
  }

  function saveEditedShift() {
    const shift = state.shifts.find((item) => item.id === $('#edit-shift-id').value);
    if (!shift) return;
    const originalStart = new Date(shift.startTimestamp);
    const originalEnd = new Date(shift.endTimestamp);
    const start = $('#edit-shift-start').value === toDatetimeLocal(originalStart) ? originalStart : new Date($('#edit-shift-start').value);
    const end = $('#edit-shift-end').value === toDatetimeLocal(originalEnd) ? originalEnd : new Date($('#edit-shift-end').value);
    const distance = Number($('#edit-shift-distance').value);
    let error = '';
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) error = '请选择有效的出车和收车时间。';
    else if (end <= start) error = '收车时间必须晚于出车时间。';
    else if (!Number.isFinite(distance) || distance <= 0) error = '总行驶里程必须大于 0。';
    else if (shiftOverlaps(start, end, shift.id)) error = '这段时间与另一条专职记录重叠。';
    if (error) {
      $('#edit-shift-error').textContent = error;
      return;
    }
    const previous = Object.assign({}, shift);
    Object.assign(shift, {
      startTimestamp: start.toISOString(),
      endTimestamp: end.toISOString(),
      distance: round(distance, 1),
      endOdometer: shift.distanceMode === 'odometer' ? round(shift.startOdometer + distance, 1) : null
    });
    if (!saveState()) {
      Object.assign(shift, previous);
      return;
    }
    $('#edit-shift-dialog').close();
    renderProfessionalBanner();
    if (state.page === 'stats') renderStats();
    showToast('专职记录已更新');
  }

  function deleteEditedShift() {
    const id = $('#edit-shift-id').value;
    const shift = state.shifts.find((item) => item.id === id);
    if (!shift || !window.confirm('确认删除这条专职记录？订单记录不会被删除。')) return;
    const previous = state.shifts.slice();
    state.shifts = state.shifts.filter((item) => item.id !== id);
    if (!saveState()) {
      state.shifts = previous;
      return;
    }
    $('#edit-shift-dialog').close();
    renderProfessionalBanner();
    if (state.page === 'stats') renderStats();
    showToast('专职记录已删除');
  }

  function renderPlatformPicker() {
    const picker = $('#platform-picker');
    const previousScroll = picker.scrollLeft;
    if (!state.platforms.some((platform) => platform.id === state.selectedPlatformId)) {
      state.selectedPlatformId = state.platforms[0].id;
    }
    picker.innerHTML = state.platforms.map((platform) => {
      const selected = platform.id === state.selectedPlatformId;
      return '<button class="platform-option ' + (selected ? 'selected' : '') + '" type="button" role="radio" aria-checked="' + selected + '" data-platform-id="' + escapeHtml(platform.id) + '" style="--platform-color:' + platform.color + '">' +
        '<b class="' + (platform.icon ? 'has-icon' : '') + '">' + platformMark(platform) + '</b><span>' + escapeHtml(platform.name) + '</span></button>';
    }).join('');
    picker.classList.toggle('has-overflow', state.platforms.length > 5);
    requestAnimationFrame(() => {
      if (previousScroll > 0) {
        picker.scrollLeft = previousScroll;
      } else {
        const selectedIndex = state.platforms.findIndex((platform) => platform.id === state.selectedPlatformId);
        const selected = picker.querySelector('.platform-option.selected');
        if (selectedIndex >= 5 && selected) picker.scrollLeft = selected.offsetLeft + selected.offsetWidth - picker.clientWidth + 4;
      }
      updatePlatformScrollCues();
    });
  }

  function updatePlatformScrollCues() {
    const picker = $('#platform-picker');
    const overflow = picker.scrollWidth > picker.clientWidth + 2;
    const atStart = picker.scrollLeft <= 2;
    const atEnd = picker.scrollLeft + picker.clientWidth >= picker.scrollWidth - 2;
    picker.classList.toggle('can-scroll-left', overflow && !atStart);
    picker.classList.toggle('can-scroll-right', overflow && !atEnd);
  }

  function renderHome() {
    updateDateHeader();
    renderPlatformPicker();
    renderProfessionalBanner();
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

  function tripItemMarkup(record) {
    const platform = platformFor(record);
    const gap = passengerTripGap(record);
    const tripNumberText = Number.isInteger(record.passengerTripNumber)
      ? ' · 第 ' + record.passengerTripNumber + ' 次出行' + (gap ? '<em class="trip-gap">中间 ' + gap + ' 次未同行</em>' : '')
      : '';
    const passengerText = record.passenger
      ? '乘客 ···' + record.passenger + tripNumberText
      : '未记录乘客';
    const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.timestamp));
    return '<button class="trip-item" type="button" data-record-id="' + escapeHtml(record.id) + '" aria-label="编辑 ' + escapeHtml(platform.name) + ' ' + record.amount.toFixed(2) + ' 元的记录">' +
      '<span class="trip-platform-icon ' + (platform.icon ? 'has-icon' : '') + '" style="--platform-color:' + platform.color + '">' + platformMark(platform) + '</span>' +
      '<span class="trip-main"><strong>' + escapeHtml(platform.name) + ' · ' + time + '</strong><span>' + passengerText + '</span></span>' +
      '<span class="trip-values"><strong>¥' + moneyFormatter.format(record.amount) + '</strong><span>' + record.distance.toFixed(1) + ' km</span></span></button>';
  }

  function renderTripList(records) {
    const list = $('#today-list');
    if (!records.length) {
      list.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h16M6 17V9l2-4h8l2 4v8M8 12h.01M16 12h.01M7 17v2M17 17v2"/></svg><strong>今天还没有记录</strong><p>录入这一单的收入和里程，轻轻一点就完成。</p></div>';
      return;
    }
    list.innerHTML = records.map(tripItemMarkup).join('');
  }

  function recordDateLabel(timestamp) {
    const date = new Date(timestamp);
    const includeYear = date.getFullYear() !== new Date().getFullYear();
    const dateText = new Intl.DateTimeFormat('zh-CN', {
      year: includeYear ? 'numeric' : undefined,
      month: 'long',
      day: 'numeric'
    }).format(date);
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date);
    return dateText + ' ' + weekday;
  }

  function renderAllRecords() {
    const records = Array.from(state.records).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const list = $('#all-records-list');
    $('#all-records-meta').textContent = records.length
      ? records.length + ' 单 · ¥' + moneyFormatter.format(sum(records, 'amount')) + ' · ' + sum(records, 'distance').toFixed(1) + ' km'
      : '暂无记录';
    if (!records.length) {
      list.innerHTML = '<div class="empty-state"><strong>还没有任何记录</strong><p>完成第一笔记录后，历史明细会显示在这里。</p></div>';
      return;
    }
    const groups = new Map();
    records.forEach((record) => {
      const key = localDateKey(record.timestamp);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });
    list.innerHTML = Array.from(groups.values()).map((group) => {
      return '<section class="record-date-group"><div class="record-date-heading"><h3>' + recordDateLabel(group[0].timestamp) + '</h3><span>' + group.length + ' 单 · ¥' + moneyFormatter.format(sum(group, 'amount')) + '</span></div>' +
        '<div class="trip-list">' + group.map(tripItemMarkup).join('') + '</div></section>';
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
    input.placeholder = '—';
    if (!completePassenger) {
      input.value = '';
      return;
    }
    if (forceSuggestion || (!passengerTripNumberDirty && !input.value)) {
      input.value = suggestedPassengerTripNumber(passenger);
    }
  }

  function updateEditPassengerTripNumber(forceSuggestion) {
    const passenger = $('#edit-passenger').value.replace(/\D/g, '').slice(-4);
    const input = $('#edit-passenger-count');
    const record = state.records.find((item) => item.id === $('#edit-id').value);
    const completePassenger = passenger.length === 4;
    input.disabled = !completePassenger;
    input.placeholder = '—';
    if (!completePassenger) {
      input.value = '';
      return;
    }
    if (forceSuggestion) {
      input.value = record && passenger === record.passenger && record.passengerTripNumber
        ? record.passengerTripNumber
        : suggestedPassengerTripNumber(passenger, record && record.id);
    }
  }

  function validateTrip(amount, distance, passenger, passengerTripNumber) {
    if (!Number.isFinite(amount) || amount <= 0) return '请输入大于 0 的收入金额。';
    if (!Number.isFinite(distance) || distance <= 0) return '请输入大于 0 的行驶里程。';
    if (passenger && passenger.length !== 4) return '乘客手机尾号请输入 4 位数字，或留空。';
    if (passengerTripNumber !== null && (!Number.isInteger(passengerTripNumber) || passengerTripNumber < 1)) return '乘客出行次数必须是大于 0 的整数。';
    return '';
  }

  function submitTrip(event) {
    event.preventDefault();
    const amount = Number($('#amount-input').value);
    const distance = Number($('#distance-input').value);
    const passenger = $('#passenger-input').value.replace(/\D/g, '').slice(-4);
    const passengerTripNumberValue = $('#passenger-count-input').value;
    const passengerTripNumber = passenger && passengerTripNumberValue ? Number(passengerTripNumberValue) : null;
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
      passengerTripNumber: passengerTripNumber
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
    showToast(passenger ? '已记录 · 尾号 ' + passenger + (passengerTripNumber ? ' 第 ' + passengerTripNumber + ' 次出行' : '') : '已记录这一单');
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
    updateEditDateTimeDisplay();
    $('#edit-amount').value = record.amount;
    $('#edit-distance').value = record.distance;
    $('#edit-passenger').value = record.passenger;
    $('#edit-passenger-count').disabled = record.passenger.length !== 4;
    $('#edit-passenger-count').value = record.passengerTripNumber || '';
    $('#edit-passenger-count').placeholder = '—';
    $('#edit-error').textContent = '';
    $('#edit-dialog').showModal();
  }

  function updateEditDateTimeDisplay() {
    const value = $('#edit-datetime').value;
    $('#edit-datetime-display').value = value ? value.replace('T', ' ') : '请选择时间';
  }

  function openEditDateTimePicker() {
    const input = $('#edit-datetime');
    input.focus({ preventScroll: true });
    if (typeof input.showPicker === 'function') {
      try { input.showPicker(); } catch (error) { /* 系统会继续处理这次原生点击 */ }
    }
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
    const passengerTripNumberValue = $('#edit-passenger-count').value;
    const passengerTripNumber = passenger && passengerTripNumberValue ? Number(passengerTripNumberValue) : null;
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
      passengerTripNumber: passengerTripNumber
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

  function scopeShifts() {
    const bounds = scopeBounds();
    return state.shifts.filter((shift) => {
      const start = new Date(shift.startTimestamp);
      return Boolean(shift.endTimestamp) && start >= bounds[0] && start < bounds[1];
    });
  }

  function renderProfessionalStats() {
    const shifts = scopeShifts();
    const container = $('#professional-stats');
    container.hidden = !shifts.length;
    if (!shifts.length) return;
    const totals = shifts.reduce((result, shift) => {
      const summary = shiftSummary(shift);
      result.duration += summary.duration;
      result.income += summary.income;
      result.distance += Number(shift.distance || 0);
      return result;
    }, { duration: 0, income: 0, distance: 0 });
    $('#scope-shift-duration').textContent = formatCompactDuration(totals.duration);
    $('#scope-hourly-rate').textContent = moneyFormatter.format(totals.duration > 0 ? totals.income / (totals.duration / 3600000) : 0);
    $('#scope-shift-rate').textContent = moneyFormatter.format(totals.distance > 0 ? totals.income / totals.distance : 0);
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
    renderProfessionalStats();
    renderTrendChart();
    renderPlatformInsights(records);
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
        return '<div class="period-cell ' + (current ? 'current' : '') + '"><span>' + (month + 1) + ' 月</span><strong>' + (value ? '¥' + compactIncome(value, true) : '—') + '</strong></div>';
      }).join('') + '</div>';
      return;
    }
    const start = sixYearStart();
    const aggregates = aggregateByKey(scopeRecords(), (record) => new Date(record.timestamp).getFullYear());
    panel.innerHTML = '<div class="period-grid year-grid">' + Array.from({ length: 6 }, (_, index) => {
      const year = start + index;
      const value = aggregates.get(year) ? aggregates.get(year).income : 0;
      return '<div class="period-cell ' + (year === now.getFullYear() ? 'current' : '') + '"><span>' + year + ' 年</span><strong>' + (value ? '¥' + compactIncome(value, true) : '—') + '</strong></div>';
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
    const values = points.map((point) => point.income);
    const max = Math.max.apply(null, values);
    if (max <= 0) {
      $('#trend-selection-label').textContent = '收入趋势';
      $('#trend-selection-value').textContent = '—';
      $('#trend-chart').innerHTML = '<div class="chart-empty">当前范围暂无收入数据</div>';
      return;
    }
    const chartContainer = $('#trend-chart');
    const width = Math.max(320, Math.round(chartContainer.clientWidth - 16) || 360);
    const height = 200;
    const margin = { top: 10, right: 11, bottom: 27, left: 43 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    const paddedMax = max * 1.12;
    const x = (index) => margin.left + (points.length === 1 ? chartWidth / 2 : index * chartWidth / (points.length - 1));
    const y = (value) => margin.top + chartHeight - (value / paddedMax) * chartHeight;
    const line = points.map((point, index) => (index ? 'L' : 'M') + ' ' + x(index).toFixed(2) + ' ' + y(point.income).toFixed(2)).join(' ');
    const area = line + ' L ' + x(points.length - 1).toFixed(2) + ' ' + (margin.top + chartHeight) + ' L ' + x(0).toFixed(2) + ' ' + (margin.top + chartHeight) + ' Z';
    const tickIndexes = chartTickIndexes(points.length);
    const yTicks = [0, paddedMax / 2, paddedMax];
    const fallbackIndex = lastPositiveIndex(values);
    const selectedIndex = Number.isInteger(state.trendPointIndex) && state.trendPointIndex >= 0 && state.trendPointIndex < points.length
      ? state.trendPointIndex
      : fallbackIndex;
    state.trendPointIndex = selectedIndex;
    const selectedPoint = points[selectedIndex];
    $('#trend-selection-label').textContent = trendPointDateLabel(selectedPoint.label);
    $('#trend-selection-value').textContent = '¥' + moneyFormatter.format(selectedPoint.income);
    const dots = points.map((point, index) => '<circle class="dot ' + (point.income ? '' : 'zero-dot') + '" cx="' + x(index) + '" cy="' + y(point.income) + '" r="' + (point.income ? '3.2' : '2.2') + '"><title>' + trendPointDateLabel(point.label) + '：¥' + moneyFormatter.format(point.income) + '</title></circle>').join('');
    const grids = yTicks.map((value) => '<line class="grid-line" x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text class="axis-label" x="' + (margin.left - 6) + '" y="' + (y(value) + 3) + '" text-anchor="end">' + compactIncome(value, state.range !== 'day') + '</text>').join('');
    const labels = tickIndexes.map((index) => '<text class="axis-label" x="' + x(index) + '" y="' + (height - 7) + '" text-anchor="middle">' + points[index].label + '</text>').join('');
    $('#trend-chart').innerHTML = '<svg class="trend-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="trend-svg-title trend-svg-desc">' +
      '<title id="trend-svg-title">收入趋势</title><desc id="trend-svg-desc">当前范围内最高收入为 ¥' + moneyFormatter.format(max) + '，轻触图表可查看各点金额</desc>' +
      '<defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' +
      grids + '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>' +
      '<line class="selection-guide" x1="' + x(selectedIndex) + '" x2="' + x(selectedIndex) + '" y1="' + margin.top + '" y2="' + (margin.top + chartHeight) + '"/>' +
      dots + '<circle class="selected-dot" cx="' + x(selectedIndex) + '" cy="' + y(selectedPoint.income) + '" r="5"/>' + labels +
      '<rect class="trend-hit-area" x="' + margin.left + '" y="' + margin.top + '" width="' + chartWidth + '" height="' + chartHeight + '"/></svg>';
  }

  function trendPointDateLabel(label) {
    if (state.range === 'day') return (state.cursor.getMonth() + 1) + '月' + label + '日';
    if (state.range === 'month') return state.cursor.getFullYear() + '年' + label;
    return label + '年';
  }

  function selectTrendPoint(event) {
    const svg = event.target.closest('.trend-svg');
    if (!svg) return;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const points = periodPoints();
    const pointer = svg.createSVGPoint();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const svgX = pointer.matrixTransform(matrix.inverse()).x;
    const chartWidth = svg.viewBox.baseVal.width - 43 - 11;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((svgX - 43) / chartWidth * (points.length - 1))));
    state.trendPointIndex = index;
    renderTrendChart();
  }

  function platformStats(records) {
    const data = new Map();
    records.forEach((record) => {
      const platform = platformFor(record);
      if (!data.has(platform.id)) data.set(platform.id, { platform: platform, income: 0, distance: 0, count: 0 });
      const item = data.get(platform.id);
      item.income += record.amount;
      item.distance += record.distance;
      item.count += 1;
    });
    return Array.from(data.values()).map((item) => Object.assign(item, { rate: item.distance > 0 ? item.income / item.distance : 0 }));
  }

  function renderPlatformInsights(records) {
    const rows = platformStats(records);
    renderPlatformShareChart(rows);
    renderPlatformRateChart(rows);
  }

  function renderPlatformShareChart(rows) {
    const container = $('#platform-share-chart');
    if (!rows.length) {
      container.innerHTML = '<div class="compact-chart-empty">暂无数据</div>';
      return;
    }
    const sorted = Array.from(rows).sort((a, b) => b.income - a.income);
    const total = sum(sorted, 'income');
    const radius = 48;
    const circumference = Math.PI * 2 * radius;
    let offset = 0;
    const segments = sorted.map((row) => {
      const length = row.income / total * circumference;
      const visibleLength = Math.max(.8, length - 1.8);
      const markup = '<circle class="donut-segment" cx="80" cy="80" r="' + radius + '" transform="rotate(-90 80 80)" style="--segment-color:' + row.platform.color + '" stroke-dasharray="' + visibleLength + ' ' + (circumference - visibleLength) + '" stroke-dashoffset="' + (-offset) + '"><title>' + escapeHtml(row.platform.name) + '：¥' + moneyFormatter.format(row.income) + '</title></circle>';
      offset += length;
      return markup;
    }).join('');
    const legend = sorted.map((row) => {
      const percent = row.income / total * 100;
      const percentText = percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
      const amountText = String(Number(row.income.toFixed(2)));
      return '<div class="donut-legend-row"><span class="donut-swatch" style="--segment-color:' + row.platform.color + '"></span><span>' + escapeHtml(row.platform.name) + '</span><b>' + amountText + '（' + percentText + '%）</b></div>';
    }).join('');
    container.innerHTML = '<svg class="donut-svg" viewBox="0 0 160 160" role="img" aria-label="各平台收入占比和具体金额"><circle class="donut-track" cx="80" cy="80" r="' + radius + '"/>' + segments +
      '<text class="donut-total-label" x="80" y="75" text-anchor="middle">总收入</text><text class="donut-total" x="80" y="94" text-anchor="middle">¥' + compactIncome(total, true) + '</text></svg><div class="donut-legend">' + legend + '</div>';
  }

  function renderPlatformRateChart(rows) {
    const container = $('#platform-rate-chart');
    const sorted = Array.from(rows).filter((row) => row.distance > 0).sort((a, b) => b.rate - a.rate);
    if (!sorted.length) {
      container.innerHTML = '<div class="compact-chart-empty">暂无数据</div>';
      return;
    }
    const max = Math.max.apply(null, sorted.map((row) => row.rate));
    const bars = sorted.map((row) => {
      const width = max ? Math.max(4, row.rate / max * 100) : 0;
      return '<div class="rate-horizontal-row" aria-label="' + escapeHtml(row.platform.name) + '，每公里 ' + moneyFormatter.format(row.rate) + ' 元"><div class="rate-horizontal-meta"><span>' + escapeHtml(row.platform.name) + '</span><b>¥' + moneyFormatter.format(row.rate) + '</b></div><div class="rate-horizontal-track"><span class="rate-horizontal-fill" style="--bar-color:' + row.platform.color + ';width:' + width + '%"></span></div></div>';
    }).join('');
    container.innerHTML = '<div class="rate-horizontal-chart" role="img" aria-label="各平台平均每公里单价">' + bars + '</div>';
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
    state.trendPointIndex = null;
    renderStats();
  }

  function setRange(range) {
    state.range = range;
    state.trendPointIndex = null;
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
    $('#export-shifts-label').textContent = '共 ' + state.shifts.filter((shift) => shift.endTimestamp).length + ' 次已完成';
  }

  function exportCsv(records, suffix) {
    if (!records.length) {
      showToast('当前没有可导出的记录');
      return;
    }
    const sorted = Array.from(records).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const header = ['日期', '时间', '平台', '收入(元)', '里程(公里)', '乘客手机尾号', '乘客出行次数', '记录ID'];
    const rows = sorted.map((record) => {
      const date = new Date(record.timestamp);
      return [
        localDateKey(date),
        String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ':' + String(date.getSeconds()).padStart(2, '0'),
        platformFor(record).name,
        record.amount.toFixed(2),
        record.distance.toFixed(1),
        record.passenger,
        record.passengerTripNumber || '',
        record.id
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

  function exportShiftCsv() {
    const shifts = state.shifts.filter((shift) => shift.endTimestamp).sort((a, b) => new Date(a.startTimestamp) - new Date(b.startTimestamp));
    if (!shifts.length) {
      showToast('当前没有已完成的专职记录');
      return;
    }
    const header = ['出车日期', '出车时间', '收车日期', '收车时间', '记录方式', '开始里程表', '结束里程表', '总行驶里程(公里)', '专职收入(元)', '订单数', '时长(分钟)', '记录ID'];
    const rows = shifts.map((shift) => {
      const start = new Date(shift.startTimestamp);
      const end = new Date(shift.endTimestamp);
      const summary = shiftSummary(shift);
      const timeText = (date) => String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ':' + String(date.getSeconds()).padStart(2, '0');
      return [
        localDateKey(start),
        timeText(start),
        localDateKey(end),
        timeText(end),
        shift.distanceMode === 'odometer' ? '里程表读数' : '本次总里程',
        shift.startOdometer == null ? '' : Number(shift.startOdometer).toFixed(1),
        shift.endOdometer == null ? '' : Number(shift.endOdometer).toFixed(1),
        Number(shift.distance).toFixed(1),
        summary.income.toFixed(2),
        summary.count,
        Math.round(summary.duration / 60000),
        shift.id
      ];
    });
    const csv = '\ufeff' + [header].concat(rows).map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '顺风账-' + localDateKey(new Date()).replaceAll('-', '') + '-专职记录.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#export-dialog').close();
    showToast('已导出 ' + shifts.length + ' 次专职记录');
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          cell += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ',') {
        row.push(cell);
        cell = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += character;
      }
    }
    if (quoted) throw new Error('CSV 文件中存在未闭合的引号。');
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((item) => item.some((value) => value.trim()));
  }

  function importRecordKey(record, platformName) {
    const date = new Date(record.timestamp);
    const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    return [
      localDateKey(date),
      time,
      String(platformName || '').trim().toLowerCase(),
      Number(record.amount).toFixed(2),
      Number(record.distance).toFixed(1),
      record.passenger || '',
      record.passengerTripNumber || ''
    ].join('|');
  }

  function importedPlatform(name) {
    const existing = state.platforms.find((platform) => platform.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const builtIn = DEFAULT_PLATFORMS.find((platform) => platform.name.toLowerCase() === name.toLowerCase());
    const colors = ['#497766', '#a96548', '#6b6fa8', '#8b7045', '#4b7892'];
    const platform = builtIn
      ? Object.assign({}, builtIn)
      : {
          id: makeId('platform'),
          name: name.slice(0, 8),
          short: Array.from(name)[0] || '车',
          color: colors[state.platforms.length % colors.length],
          icon: '',
          builtIn: false
        };
    state.platforms.push(platform);
    return platform;
  }

  function parseImportedDateTime(dateText, timeText) {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText);
    const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(timeText);
    if (!validDate || !validTime) return new Date(NaN);
    const date = new Date(dateText + 'T' + (timeText.length === 5 ? timeText + ':00' : timeText));
    return localDateKey(date) === dateText ? date : new Date(NaN);
  }

  function importShiftCsvRows(rows, headers, status) {
    const column = (name) => headers.indexOf(name);
    const startDateColumn = column('出车日期');
    const startTimeColumn = column('出车时间');
    const endDateColumn = column('收车日期');
    const endTimeColumn = column('收车时间');
    const modeColumn = column('记录方式');
    const startOdometerColumn = column('开始里程表');
    const endOdometerColumn = column('结束里程表');
    const distanceColumn = column('总行驶里程(公里)');
    const recordIdColumn = column('记录ID');
    if ([startDateColumn, startTimeColumn, endDateColumn, endTimeColumn, modeColumn, distanceColumn, recordIdColumn].some((index) => index < 0)) {
      throw new Error('专职记录 CSV 表头不完整。');
    }
    const existingIds = new Set(state.shifts.map((shift) => shift.id));
    const candidates = [];
    let invalidCount = 0;
    let duplicateCount = 0;
    rows.slice(1).forEach((row) => {
      const value = (index) => index >= 0 ? String(row[index] || '').trim() : '';
      const sourceId = value(recordIdColumn).slice(0, 128);
      if (sourceId && existingIds.has(sourceId)) {
        duplicateCount += 1;
        return;
      }
      const start = parseImportedDateTime(value(startDateColumn), value(startTimeColumn));
      const end = parseImportedDateTime(value(endDateColumn), value(endTimeColumn));
      const modeText = value(modeColumn);
      const mode = /里程表|odometer/i.test(modeText) ? 'odometer' : /总里程|trip|直接/i.test(modeText) ? 'trip' : '';
      const startOdometerText = value(startOdometerColumn);
      const endOdometerText = value(endOdometerColumn);
      const startOdometer = startOdometerText === '' ? null : Number(startOdometerText);
      const endOdometer = endOdometerText === '' ? null : Number(endOdometerText);
      const distance = Number(value(distanceColumn));
      const validOdometer = mode !== 'odometer' || (Number.isFinite(startOdometer) && startOdometer >= 0 && Number.isFinite(endOdometer) && endOdometer >= startOdometer);
      if (!sourceId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || !mode || !Number.isFinite(distance) || distance <= 0 || !validOdometer) {
        invalidCount += 1;
        return;
      }
      existingIds.add(sourceId);
      candidates.push({
        id: sourceId,
        startTimestamp: start.toISOString(),
        endTimestamp: end.toISOString(),
        distanceMode: mode,
        startOdometer: mode === 'odometer' ? round(startOdometer, 1) : null,
        endOdometer: mode === 'odometer' ? round(endOdometer, 1) : null,
        distance: round(distance, 1)
      });
    });
    candidates.sort((a, b) => new Date(a.startTimestamp) - new Date(b.startTimestamp));
    const imported = [];
    candidates.forEach((candidate) => {
      const overlaps = state.shifts.concat(imported).some((shift) => {
        const candidateStart = new Date(candidate.startTimestamp).getTime();
        const candidateEnd = new Date(candidate.endTimestamp).getTime();
        const otherStart = new Date(shift.startTimestamp).getTime();
        const otherEnd = shift.endTimestamp ? new Date(shift.endTimestamp).getTime() : Infinity;
        return candidateStart < otherEnd && candidateEnd > otherStart;
      });
      if (overlaps) invalidCount += 1;
      else imported.push(candidate);
    });
    if (!imported.length) {
      const skipped = duplicateCount + invalidCount;
      throw new Error(skipped ? '没有新增专职记录，共跳过 ' + skipped + ' 条。' : '文件中没有可导入的专职记录。');
    }
    const previousShifts = state.shifts.slice();
    state.shifts = state.shifts.concat(imported);
    if (!saveState()) {
      state.shifts = previousShifts;
      status.textContent = '导入失败，请检查 Safari 存储空间。';
      return;
    }
    $('#import-dialog').close();
    renderHome();
    if (state.page === 'stats') renderStats();
    const skipped = duplicateCount + invalidCount;
    showToast('已导入 ' + imported.length + ' 次专职记录' + (skipped ? '，跳过 ' + skipped + ' 条' : ''));
  }

  async function importCsvFile(file) {
    const status = $('#import-status');
    status.textContent = '正在读取文件…';
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('文件中没有可导入的记录。');
      const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\ufeff/, '') : value).trim());
      if (headers.includes('出车日期')) {
        importShiftCsvRows(rows, headers, status);
        return;
      }
      const column = (name) => headers.indexOf(name);
      const dateColumn = column('日期');
      const timeColumn = column('时间');
      const platformColumn = column('平台');
      const amountColumn = column('收入(元)');
      const distanceColumn = column('里程(公里)');
      const passengerColumn = column('乘客手机尾号');
      const tripNumberColumn = column('乘客出行次数') >= 0 ? column('乘客出行次数') : column('该乘客第几次出行');
      const recordIdColumn = column('记录ID');
      if ([dateColumn, timeColumn, platformColumn, amountColumn, distanceColumn].some((index) => index < 0)) {
        throw new Error('CSV 表头不符合顺风账的导出格式。');
      }

      const existingKeys = new Set(state.records.map((record) => importRecordKey(record, platformFor(record).name)));
      const existingIds = new Set(state.records.map((record) => record.id));
      const imported = [];
      let invalidCount = 0;
      let duplicateCount = 0;
      rows.slice(1).forEach((row) => {
        const value = (index) => index >= 0 ? String(row[index] || '').trim() : '';
        const dateText = value(dateColumn);
        const timeText = value(timeColumn);
        const platformName = value(platformColumn);
        const amount = Number(value(amountColumn));
        const distance = Number(value(distanceColumn));
        const passenger = value(passengerColumn);
        const tripNumberText = value(tripNumberColumn);
        const sourceId = value(recordIdColumn).slice(0, 128);
        const passengerTripNumber = tripNumberText ? Number(tripNumberText) : null;
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText);
        const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(timeText);
        const timestamp = validDate && validTime ? new Date(dateText + 'T' + (timeText.length === 5 ? timeText + ':00' : timeText)) : new Date(NaN);
        const validPassenger = !passenger || /^\d{4}$/.test(passenger);
        const validTripNumber = passengerTripNumber === null || (Number.isInteger(passengerTripNumber) && passengerTripNumber > 0);
        if (!platformName || Number.isNaN(timestamp.getTime()) || localDateKey(timestamp) !== dateText || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(distance) || distance <= 0 || !validPassenger || !validTripNumber) {
          invalidCount += 1;
          return;
        }
        const candidate = {
          timestamp: timestamp.toISOString(),
          platformName: platformName,
          amount: round(amount, 2),
          distance: round(distance, 1),
          passenger: passenger,
          passengerTripNumber: passenger ? passengerTripNumber : null,
          sourceId: sourceId
        };
        const key = importRecordKey(candidate, platformName);
        if ((sourceId && existingIds.has(sourceId)) || (!sourceId && existingKeys.has(key))) {
          duplicateCount += 1;
          return;
        }
        if (sourceId) existingIds.add(sourceId);
        existingKeys.add(key);
        imported.push(candidate);
      });

      if (!imported.length) {
        const skipped = duplicateCount + invalidCount;
        throw new Error(skipped ? '没有新增记录，共跳过 ' + skipped + ' 条。' : '文件中没有可导入的记录。');
      }
      const previousRecords = state.records.slice();
      const previousPlatforms = state.platforms.slice();
      imported.forEach((candidate) => {
        const platform = importedPlatform(candidate.platformName);
        state.records.push({
          id: candidate.sourceId || makeId('trip'),
          timestamp: candidate.timestamp,
          platformId: platform.id,
          platformName: platform.name,
          amount: candidate.amount,
          distance: candidate.distance,
          passenger: candidate.passenger,
          passengerTripNumber: candidate.passengerTripNumber
        });
      });
      if (!saveState()) {
        state.records = previousRecords;
        state.platforms = previousPlatforms;
        status.textContent = '导入失败，请检查 Safari 存储空间。';
        return;
      }
      $('#import-dialog').close();
      renderHome();
      if (state.page === 'stats') renderStats();
      if (!passengerTripNumberDirty) updatePassengerTripNumberInput(true);
      const skipped = duplicateCount + invalidCount;
      showToast('已导入 ' + imported.length + ' 条' + (skipped ? '，跳过 ' + skipped + ' 条' : ''));
    } catch (error) {
      status.textContent = error.message || '无法读取这个 CSV 文件。';
    } finally {
      $('#import-file').value = '';
    }
  }

  function clearAllRecords() {
    const orderCount = state.records.length;
    const shiftCount = state.shifts.length;
    if (!orderCount && !shiftCount) {
      $('#settings-dialog').close();
      showToast('当前没有记录可清空');
      return;
    }
    const countText = (orderCount ? orderCount + ' 条订单' : '') + (orderCount && shiftCount ? '和' : '') + (shiftCount ? shiftCount + ' 次专职记录' : '');
    if (!window.confirm('确认清空全部' + countText + '？此操作无法撤销，建议先导出备份。')) return;
    const previousRecords = state.records;
    const previousShifts = state.shifts;
    state.records = [];
    state.shifts = [];
    if (!saveState()) {
      state.records = previousRecords;
      state.shifts = previousShifts;
      return;
    }
    $('#settings-dialog').close();
    passengerTripNumberDirty = false;
    renderHome();
    updatePassengerTripNumberInput(true);
    if (state.page === 'stats') renderStats();
    showToast('订单和专职记录已清空');
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
    $('#platform-picker').addEventListener('scroll', updatePlatformScrollCues, { passive: true });
    $('#trip-form').addEventListener('submit', submitTrip);
    $('#professional-content').addEventListener('click', (event) => {
      const action = event.target.closest('[data-shift-action]');
      if (!action) return;
      if (action.dataset.shiftAction === 'start') openStartShiftDialog();
      else openStopShiftDialog();
    });
    $('#open-shift-history').addEventListener('click', openShiftHistory);
    $('#start-distance-modes').addEventListener('change', updateStartShiftMode);
    $('#confirm-start-shift').addEventListener('click', confirmStartShift);
    $('#stop-distance-modes').addEventListener('change', updateStopShiftMode);
    $('#stop-odometer').addEventListener('input', updateCalculatedShiftDistance);
    $('#confirm-stop-shift').addEventListener('click', confirmStopShift);
    $('#cancel-active-shift').addEventListener('click', cancelActiveShift);
    $('#shift-history-list').addEventListener('click', (event) => {
      const item = event.target.closest('[data-shift-id]');
      if (!item) return;
      const shift = state.shifts.find((candidate) => candidate.id === item.dataset.shiftId);
      if (!shift) return;
      reopenShiftHistoryAfterFlow = true;
      $('#shift-history-dialog').close();
      requestAnimationFrame(() => {
        if (shift.endTimestamp) openEditShiftDialog(shift.id);
        else openStopShiftDialog();
      });
    });
    [$('#stop-shift-dialog'), $('#edit-shift-dialog')].forEach((dialog) => {
      dialog.addEventListener('close', () => {
        if (!reopenShiftHistoryAfterFlow) return;
        reopenShiftHistoryAfterFlow = false;
        requestAnimationFrame(() => {
          renderShiftHistory();
          $('#shift-history-dialog').showModal();
        });
      });
    });
    $('#edit-shift-start').addEventListener('input', updateEditShiftDateTimeDisplay);
    $('#edit-shift-start').addEventListener('change', updateEditShiftDateTimeDisplay);
    $('#edit-shift-end').addEventListener('input', updateEditShiftDateTimeDisplay);
    $('#edit-shift-end').addEventListener('change', updateEditShiftDateTimeDisplay);
    $('#save-shift').addEventListener('click', saveEditedShift);
    $('#delete-shift').addEventListener('click', deleteEditedShift);
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
      if (item) {
        reopenAllRecordsAfterEdit = false;
        openEditDialog(item.dataset.recordId);
      }
    });
    $('#open-all-records').addEventListener('click', () => {
      renderAllRecords();
      $('#all-records-dialog').showModal();
    });
    $('#all-records-list').addEventListener('click', (event) => {
      const item = event.target.closest('[data-record-id]');
      if (!item) return;
      reopenAllRecordsAfterEdit = true;
      $('#all-records-dialog').close();
      requestAnimationFrame(() => openEditDialog(item.dataset.recordId));
    });
    $('#edit-dialog').addEventListener('close', () => {
      if (!reopenAllRecordsAfterEdit) return;
      reopenAllRecordsAfterEdit = false;
      requestAnimationFrame(() => {
        renderAllRecords();
        $('#all-records-dialog').showModal();
      });
    });
    $('#save-trip').addEventListener('click', saveEditedTrip);
    $('#delete-trip').addEventListener('click', deleteEditedTrip);
    $('#edit-passenger').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
      updateEditPassengerTripNumber(true);
    });
    $('#edit-datetime').addEventListener('input', updateEditDateTimeDisplay);
    $('#edit-datetime').addEventListener('change', updateEditDateTimeDisplay);
    $('.edit-datetime-control').addEventListener('click', openEditDateTimePicker);
    $$('.bottom-nav button').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
    $$('.range-tabs button').forEach((button) => button.addEventListener('click', () => setRange(button.dataset.range)));
    $('#period-prev').addEventListener('click', () => movePeriod(-1));
    $('#period-next').addEventListener('click', () => movePeriod(1));
    $('#period-label').addEventListener('click', () => { state.cursor = new Date(); state.trendPointIndex = null; renderStats(); });
    $('#trend-chart').addEventListener('click', selectTrendPoint);
    window.addEventListener('resize', () => {
      updatePlatformScrollCues();
      if (state.page !== 'stats') return;
      clearTimeout(trendResizeTimer);
      trendResizeTimer = setTimeout(renderTrendChart, 120);
    });
    $('#open-export').addEventListener('click', openExportDialog);
    $('#export-scope').addEventListener('click', () => exportCsv(scopeRecords(), '当前范围'));
    $('#export-all').addEventListener('click', () => exportCsv(state.records, '全部'));
    $('#export-shifts').addEventListener('click', exportShiftCsv);
    $('#open-settings').addEventListener('click', () => $('#settings-dialog').showModal());
    $('#settings-platforms').addEventListener('click', () => { renderPlatformManager(); chainDialog($('#settings-dialog'), $('#platform-dialog')); });
    $('#settings-export').addEventListener('click', () => { updateExportLabels(); chainDialog($('#settings-dialog'), $('#export-dialog')); });
    $('#settings-import').addEventListener('click', () => {
      $('#import-status').textContent = '';
      chainDialog($('#settings-dialog'), $('#import-dialog'));
    });
    $('#import-file').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importCsvFile(file);
    });
    $('#settings-install').addEventListener('click', () => chainDialog($('#settings-dialog'), $('#install-dialog')));
    $('#settings-clear').addEventListener('click', clearAllRecords);
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
  function compactIncome(value, preferWan) {
    if (preferWan && Math.abs(value) < 10000) {
      return String(Number(value.toFixed(2)));
    }
    if (preferWan) {
      const absolute = Math.abs(value);
      const digits = absolute >= 100000 ? 0 : absolute >= 10000 ? 1 : 2;
      return (value / 10000).toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') + '万';
    }
    return compactNumber(value);
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
      else if (activeShift()) renderProfessionalBanner();
      $('#today-date').dataset.dateKey = current;
    }, 60000);
  }

  init();
})();
