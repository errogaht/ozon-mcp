/** Ozon dates are interpreted in the owner's time zone. Delivery filters use
 * the LAST promised day of a range, not the cheapest interpretation of "from".
 * Unknown dates stay unknown and cannot satisfy a requested deadline. */
export function deliveryDates(label, now = new Date(), timezone = 'Europe/Moscow') {
  if (!label) return { label: null, earliest: null, latest: null, days: null };
  const todayString = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const today = new Date(todayString + 'T00:00:00+03:00');
  const iso = date => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  let low; let high; const lower = label.toLocaleLowerCase();
  if (/послезавтра/.test(lower)) low = high = new Date(today.getTime() + 2 * 86400000);
  else if (/завтра/.test(lower)) low = high = new Date(today.getTime() + 86400000);
  else if (/сегодня/.test(lower)) low = high = today;
  else {
    // Retention/return/payment periods are not delivery estimates. Relative
    // deadlines need explicit "через/до" or a standalone day-count label.
    const relative = /срок\s+хранения|возврат|льготн|плат[её]ж/.test(lower) ? null : lower.match(/(?:через|до)\s+(\d+)\s*(?:дн|дня|дней)|^\s*(\d+)\s*(?:дн|дня|дней)\s*$/);
    if (relative) low = high = new Date(today.getTime() + Number(relative[1] ?? relative[2]) * 86400000);
    else {
      const months = ['янв','фев','мар','апр','ма','июн','июл','авг','сен','окт','ноя','дек'];
      const token = '(?:янв(?:ар[ья])?|фев(?:рал[ья])?|мар(?:т[а]?)?|апр(?:ел[ья])?|ма[йя]|июн[ья]?|июл[ья]?|авг(?:уст[а]?)?|сен(?:т(?:ябр[ья])?)?|окт(?:ябр[ья])?|ноя(?:бр[ья])?|дек(?:абр[ья])?)';
      const cross = lower.match(new RegExp('(\\d{1,2})\\s+(' + token + ')\\.?\\s*[–—-]\\s*(\\d{1,2})\\s+(' + token + ')\\.?(?:\\s+(20\\d{2}))?'));
      const match = lower.match(new RegExp('(\\d{1,2})(?:\\s*[–—-]\\s*(\\d{1,2}))?\\s+(' + token + ')\\.?(?:\\s+(20\\d{2}))?'));
      const make = (year, month, day) => new Date(`${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00+03:00`);
      if (cross) {
        const loMonth = months.findIndex(m => cross[2].startsWith(m)); const hiMonth = months.findIndex(m => cross[4].startsWith(m));
        const year = Number(cross[5] ?? todayString.slice(0, 4));
        low = make(year, loMonth, cross[1]); high = make(year + (hiMonth < loMonth ? 1 : 0), hiMonth, cross[3]);
        if (!cross[5] && high < today) { low.setFullYear(low.getFullYear() + 1); high.setFullYear(high.getFullYear() + 1); }
      } else if (match) {
        const month = months.findIndex(m => match[3].startsWith(m)); const year = Number(match[4] ?? todayString.slice(0, 4));
        low = make(year, month, match[1]); high = make(year, month, match[2] ?? match[1]);
        if (!match[4] && high < today) { low.setFullYear(year + 1); high.setFullYear(year + 1); }
      }
    }
  }
  if (!low || !high || !Number.isFinite(high.getTime())) return { label, earliest: null, latest: null, days: null };
  // "С 16 ноября" promises an opening date, not a latest arrival. A strict
  // delivery deadline cannot be satisfied from that lower bound alone.
  const openEnded = /(?:^|[\s:])(?:с|от)\s+\d{1,2}\s+[а-я]{3}/.test(lower) && !/[–—-]/.test(lower);
  return { label, earliest: iso(low), latest: openEnded ? null : iso(high), days: openEnded ? null : Math.round((high - today) / 86400000) };
}

/** A verified UI deadline is valid constraint evidence even when individual
 * cards show no exact date or only "from". An actually observed late date still
 * overrides that filter. Never invent a concrete latest date from the filter. */
export function deadlineProof(delivery, requestedDays, selectedFilterDays = null, now = new Date()) {
  if (delivery.days !== null && delivery.days !== undefined) return { matches: delivery.days <= requestedDays, source: 'arrival_date' };
  if (selectedFilterDays === null || selectedFilterDays === undefined || selectedFilterDays > requestedDays) return { matches: false, source: 'unverified' };
  const today = deliveryDates('Сегодня', now).earliest;
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') + requestedDays * 86400000).toISOString().slice(0, 10);
  return { matches: !delivery.earliest || delivery.earliest <= cutoff, source: 'selected_filter', withinDays: selectedFilterDays };
}
