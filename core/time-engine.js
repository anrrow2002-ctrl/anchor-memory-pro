const UNKNOWN_RE = /^(?:未明|未知|不详|无法判断|暂无|无)$/i;
const FLASHBACK_RE = /(回忆|梦境|幻觉|设想|假设|转述|过去|此前|曾经|当年|记忆中|flashback|dream)/i;
const FORWARD_RE = /(次日|翌日|第二天|隔天|翌晨|当晚|几天后|数周后|后来|随后|之后|(?:\d+|[一二两三四五六七八九十两]+)\s*(?:天|日|周|星期|个月|月)后|一周后|一个月后)/i;

const DAYPARTS = [
  // label, representative hour, inclusive start minute, inclusive end minute.
  // Ranges intentionally overlap: natural-language dayparts are fuzzy, so an exact clock that
  // falls inside the stated period should be treated as the same period rather than a rollback.
  ['凌晨', 2, 0, 4 * 60 + 59],
  ['黎明', 5, 4 * 60, 6 * 60 + 59],
  ['清晨', 7, 5 * 60, 8 * 60 + 59],
  ['早晨', 8, 6 * 60, 9 * 60 + 59],
  ['上午', 10, 8 * 60, 11 * 60 + 59],
  ['中午', 12, 11 * 60, 13 * 60 + 59],
  ['下午', 15, 13 * 60, 17 * 60 + 59],
  ['傍晚', 18, 17 * 60, 19 * 60 + 59],
  ['晚上', 20, 18 * 60, 22 * 60 + 59],
  ['夜晚', 21, 19 * 60, 23 * 60 + 59],
  ['深夜', 23, 22 * 60, 23 * 60 + 59],
];

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

export function normalizeNarrativeTime(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text || UNKNOWN_RE.test(text)) return { raw: text || '未明', kind: 'unknown', comparable: false, confidence: 0 };

  const full = text.match(/(?:(\d{4})\s*[年\-/\.])?\s*(\d{1,2})\s*[月\-/\.]\s*(\d{1,2})\s*(?:日|号)?(?:[^\d]{0,6}(\d{1,2})\s*[:：时]\s*(\d{1,2})?)?/);
  if (full) {
    const year = full[1] ? Number(full[1]) : null;
    const month = Number(full[2]);
    const day = Number(full[3]);
    let hour = full[4] !== undefined ? Number(full[4]) : null;
    const minute = full[5] !== undefined && full[5] !== '' ? Number(full[5]) : 0;
    let daypart = null;
    let daypartRange = null;
    // A value such as “2025年3月15日 深夜” is first matched by the full-date regex.
    // Preserve the attached daypart instead of silently treating it as 00:00. Keep the fuzzy
    // range too, so 23:30 -> “深夜” is treated as the same period rather than a false rollback.
    if (hour === null) {
      for (const [label, daypartHour, startMinute, endMinute] of DAYPARTS) {
        if (text.includes(label)) {
          hour = daypartHour;
          daypart = label;
          daypartRange = [startMinute, endMinute];
          break;
        }
      }
    }
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31
      && (hour === null || (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59));
    if (valid) {
      const sortKey = Number(`${pad(year ?? 0, 4)}${pad(month)}${pad(day)}${pad(hour ?? 0)}${pad(minute)}`);
      return {
        raw: text,
        kind: year ? 'absolute-date' : 'month-day',
        comparable: !!year,
        year, month, day, hour, minute, sortKey,
        daypart,
        daypartRange,
        confidence: daypart ? (year ? 0.78 : 0.64) : (year ? 1 : 0.72),
      };
    }
  }

  const clock = text.match(/(?:^|\D)(\d{1,2})\s*[:：时]\s*(\d{1,2})?(?:分)?/);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { raw: text, kind: 'clock', comparable: true, hour, minute, sortKey: hour * 60 + minute, confidence: 0.82 };
    }
  }

  for (const [label, hour, startMinute, endMinute] of DAYPARTS) {
    if (text.includes(label)) {
      return {
        raw: text,
        kind: 'daypart',
        comparable: true,
        hour,
        minute: 0,
        sortKey: hour * 60,
        daypart: label,
        daypartRange: [startMinute, endMinute],
        confidence: 0.56,
      };
    }
  }

  if (FORWARD_RE.test(text)) return { raw: text, kind: 'relative-forward', comparable: false, direction: 1, confidence: 0.6 };
  return { raw: text, kind: 'label', comparable: false, confidence: 0.35 };
}

function chineseInteger(raw) {
  const text = String(raw || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    const tens = left ? (digits[left] || 0) : 1;
    const ones = right ? (digits[right] || 0) : 0;
    return tens * 10 + ones;
  }
  return digits[text] || null;
}

function dateParts(raw) {
  const parsed = normalizeNarrativeTime(raw);
  if (!['absolute-date', 'month-day'].includes(parsed.kind)) return null;
  return {
    year: parsed.year ?? null,
    month: parsed.month,
    day: parsed.day,
  };
}

function shiftedDate(parts, amount, unit) {
  if (!parts || !Number.isFinite(amount) || amount <= 0) return null;
  if (parts.year) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
    else date.setUTCDate(date.getUTCDate() + (unit === 'week' ? amount * 7 : amount));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
  // Without a year, exact rollover across month boundaries cannot be inferred safely.
  // Keep same-month arithmetic only when it stays within a conservative 31-day bound.
  if (unit === 'month') return null;
  const days = unit === 'week' ? amount * 7 : amount;
  if (parts.day + days > 31) return null;
  return { ...parts, day: parts.day + days };
}

function formatDate(parts) {
  if (!parts) return '';
  return parts.year
    ? `${parts.year}年${parts.month}月${parts.day}日`
    : `${parts.month}月${parts.day}日`;
}

function relativeDateResolution(previousRaw, nextRaw) {
  const previous = dateParts(previousRaw);
  const text = String(nextRaw || '').trim();
  if (!previous || !text) return null;

  let amount = null;
  let unit = 'day';
  let remainder = '';
  let match = text.match(/^(次日|翌日|第二天|隔天|翌晨)\s*(.*)$/);
  if (match) {
    amount = 1;
    remainder = match[2] || (match[1] === '翌晨' ? '清晨' : '');
  } else {
    match = text.match(/^((?:\d+|[一二两三四五六七八九十两]+))\s*(天|日|周|星期|个月|月)后\s*(.*)$/);
    if (match) {
      amount = chineseInteger(match[1]);
      unit = /周|星期/.test(match[2]) ? 'week' : /月/.test(match[2]) ? 'month' : 'day';
      remainder = match[3] || '';
    } else if (/^一周后(?:\s|$)/.test(text)) {
      amount = 1;
      unit = 'week';
      remainder = text.replace(/^一周后\s*/, '');
    } else if (/^一个月后(?:\s|$)/.test(text)) {
      amount = 1;
      unit = 'month';
      remainder = text.replace(/^一个月后\s*/, '');
    }
  }
  if (!amount) return null;
  const shifted = shiftedDate(previous, amount, unit);
  if (!shifted) return null;
  return `${formatDate(shifted)}${remainder ? ` ${remainder}` : ''}`.trim();
}


function inheritedDateLabel(previousRaw, nextRaw) {
  const previous = normalizeNarrativeTime(previousRaw);
  const nextText = String(nextRaw || '').trim();
  const next = normalizeNarrativeTime(nextText);
  if (!previousRaw || !nextText || next.kind === 'absolute-date' || next.kind === 'month-day') return nextText;
  if (!['absolute-date', 'month-day'].includes(previous.kind)) return nextText;
  const relativeResolved = relativeDateResolution(previousRaw, nextText);
  if (relativeResolved) return relativeResolved;
  const hasTimeDetail = ['clock', 'daypart'].includes(next.kind) || DAYPARTS.some(([label]) => nextText.includes(label));
  if (!hasTimeDetail) return nextText;

  let year = previous.year;
  let month = previous.month;
  let day = previous.day;
  if (/(次日|翌日|第二天|隔天|翌晨)/.test(nextText)) {
    if (year) {
      const date = new Date(Date.UTC(year, month - 1, day + 1));
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1;
      day = date.getUTCDate();
    } else {
      day += 1;
    }
  }
  const dateLabel = year ? `${year}年${month}月${day}日` : `${month}月${day}日`;
  return `${dateLabel} ${nextText.replace(/^(?:次日|翌日|第二天|隔天|翌晨)\s*/, '')}`.trim();
}

function minuteRange(time) {
  if (Array.isArray(time?.daypartRange) && time.daypartRange.length === 2) return time.daypartRange;
  if (Number.isFinite(time?.hour)) {
    const point = Number(time.hour) * 60 + Number(time.minute || 0);
    return [point, point];
  }
  return null;
}

function sameCalendarDay(a, b) {
  return Number(a?.year) === Number(b?.year)
    && Number(a?.month) === Number(b?.month)
    && Number(a?.day) === Number(b?.day);
}

export function compareNarrativeTimes(previousRaw, nextRaw, sourceText = '') {
  const previous = normalizeNarrativeTime(previousRaw);
  const next = normalizeNarrativeTime(nextRaw);
  const source = String(sourceText || '');
  if (FLASHBACK_RE.test(source) || FLASHBACK_RE.test(next.raw)) {
    return { order: 'flashback', previous, next, warning: '' };
  }
  if (FORWARD_RE.test(source) || FORWARD_RE.test(next.raw)) return { order: 'forward', previous, next, warning: '' };
  if (next.kind === 'relative-forward') return { order: 'forward', previous, next, warning: '' };
  if (!previous.comparable || !next.comparable) return { order: 'unknown', previous, next, warning: '' };
  if (previous.kind === 'absolute-date' && next.kind === 'absolute-date'
      && sameCalendarDay(previous, next) && (previous.daypartRange || next.daypartRange)) {
    const previousRange = minuteRange(previous);
    const nextRange = minuteRange(next);
    if (previousRange && nextRange) {
      if (nextRange[0] > previousRange[1]) return { order: 'forward', previous, next, warning: '' };
      if (nextRange[1] >= previousRange[0]) return { order: 'same', previous, next, warning: '' };
      return {
        order: 'backward', previous, next,
        warning: `剧情时间可能倒退：上一有效时间“${previous.raw}”，本楼时间“${next.raw}”。若本楼是回忆/梦境，请在摘要中明确标注。`,
      };
    }
  }
  if (previous.kind !== next.kind && !(previous.kind === 'absolute-date' && next.kind === 'absolute-date')) {
    return { order: 'unknown', previous, next, warning: '' };
  }
  if (next.sortKey > previous.sortKey) return { order: 'forward', previous, next, warning: '' };
  if (next.sortKey === previous.sortKey) return { order: 'same', previous, next, warning: '' };
  return {
    order: 'backward',
    previous,
    next,
    warning: `剧情时间可能倒退：上一有效时间“${previous.raw}”，本楼时间“${next.raw}”。若本楼是回忆/梦境，请在摘要中明确标注。`,
  };
}

export function rebuildTimelineState(entries = [], manual = {}) {
  const history = [];
  const warnings = [];
  let currentRaw = String(manual.currentTime || '').trim();
  let lastKnownDateRaw = dateParts(currentRaw) ? currentRaw : '';
  let currentSourceKey = manual.sourceKey || '';
  let currentFloor = Number.isFinite(Number(manual.floor)) ? Number(manual.floor) : -1;

  for (const entry of entries || []) {
    const raw = String(entry?.time || '').trim();
    if (!raw || UNKNOWN_RE.test(raw)) continue;
    const sourceText = `${entry?.title || ''}\n${entry?.body || ''}`;
    // Keep a separate absolute-date anchor so vague relative labels never permanently erase the date.
    const inheritanceBase = dateParts(currentRaw) ? currentRaw : (lastKnownDateRaw || currentRaw);
    const resolvedRaw = inheritanceBase ? inheritedDateLabel(inheritanceBase, raw) : raw;
    const comparison = currentRaw ? compareNarrativeTimes(currentRaw, resolvedRaw, sourceText) : { order: 'unknown' };
    const flashback = comparison.order === 'flashback';
    if (comparison.warning) warnings.push({ floor: entry.floor ?? -1, key: entry.key || '', message: comparison.warning });
    history.push({
      key: entry.key || '', floor: entry.floor ?? -1, raw, resolvedRaw, kind: normalizeNarrativeTime(resolvedRaw).kind,
      order: comparison.order || 'unknown', flashback,
    });
    if (!flashback && comparison.order !== 'backward') {
      currentRaw = resolvedRaw;
      if (dateParts(resolvedRaw)) lastKnownDateRaw = resolvedRaw;
      currentSourceKey = entry.key || currentSourceKey;
      currentFloor = Number.isFinite(Number(entry.floor)) ? Number(entry.floor) : currentFloor;
    }
  }

  return {
    currentRaw: currentRaw || '未明',
    currentSourceKey,
    currentFloor,
    warnings: warnings.slice(-20),
    history: history.slice(-120),
    updatedAt: Date.now(),
  };
}

export function isExplicitFlashback(text) {
  return FLASHBACK_RE.test(String(text || ''));
}
