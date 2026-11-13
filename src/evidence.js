/** Literal text checks keep neighboring reviews/questions from being merged.
 * Whitespace/punctuation may differ between AX and DOM, but the actual words
 * and author/date must belong to the same observed entity. */
export const normalized = value => String(value ?? '').toLocaleLowerCase().replace(/[\s\u00a0\u2009\u202f.,:;«»"'()—–-]+/g, '');
export const containsLiteral = (text, value) => value !== null && value !== undefined && normalized(value).length > 0 && normalized(text).includes(normalized(value));

export function listEvidenceErrors(kind, rows, textFor) {
  const errors = []; const sources = new Set();
  for (const [index, row] of rows.entries()) {
    const raw = textFor(row.sourceRef) ?? ''; const body = textFor(row.textRef);
    const prefix = `Item ${index + 1}`;
    if (sources.has(row.sourceRef)) errors.push(`${prefix}: sourceRef duplicates another entity; choose its own full row.`);
    sources.add(row.sourceRef);
    if (!raw || kind === 'questions' && !body || body && !containsLiteral(raw, body)) errors.push(`${prefix}: textRef is outside its own sourceRef; select the complete entity parent and correct text.`);
    if (row.textRef && row.textRef === row.sourceRef) errors.push(`${prefix}: textRef must be the body child, not the full author/date/controls entity. Null is allowed for a textless review.`);
    for (const key of ['author', 'date']) if (row[key] && !containsLiteral(raw, row[key])) errors.push(`${prefix}: ${key} is absent from sourceRef; wrong entity parent.`);
    if (kind === 'questions') for (const [i, answer] of row.answers.entries()) {
      const answerRaw = textFor(answer.sourceRef) ?? ''; const text = textFor(answer.textRef);
      if (!text || !containsLiteral(answerRaw, text) || !containsLiteral(raw, answerRaw)) errors.push(`${prefix}, answer ${i + 1}: answer must be inside this question's complete sourceRef and its own answer sourceRef.`);
      for (const key of ['author', 'date']) if (answer[key] && !containsLiteral(answerRaw, answer[key])) errors.push(`${prefix}, answer ${i + 1}: ${key} is not in that answer.`);
    }
  }
  return errors;
}

/** Interpret Russian UI labels explicitly. In particular, low/high are never
 * delegated as English asc/desc to the small adapter. A combined Ozon option
 * "новые и полезные" is not falsely advertised as a strict newest-first sort. */
export function reviewSortMatches(label, wanted) {
  const text = String(label ?? '').toLocaleLowerCase();
  if (wanted === 'rating_asc') return /низк|возрастан/.test(text);
  if (wanted === 'rating_desc') return /высок|убыван/.test(text);
  if (wanted === 'new') return /нов|свеж/.test(text) && !/полез/.test(text);
  return /полез/.test(text);
}

/** Stable asset identity is for deduplication only. It never rewrites a URL
 * into a guessed original-resolution source. */
export function assetKey(value) {
  try { const u = new URL(value); return u.origin + u.pathname.replace(/\/(?:wc|w|c|s)\d+(?:_\d+)?\//g, '/'); } catch { return String(value); }
}

/** A gallery root is already model-discovered and independently validated as
 * a media-only fullscreen overlay. Discover thumbnail nodes semantically from
 * actual image/background sources and their small displayed size, no CSS IDs. */
export function galleryThumbnails(root) {
  const all = [...root.querySelectorAll('*')]; const found = new Map();
  for (const [index, el] of all.entries()) {
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (box.width < 44 || box.height < 44 || box.width > 180 || box.height > 180 || style.display === 'none' || style.visibility === 'hidden') continue;
    const background = style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
    const img = el.matches('img,video') ? el : null;
    const source = img?.currentSrc || img?.src || background;
    if (!source || !/^https:/.test(source)) continue;
    if (/\/marketing-api\/|\/cms\/|\/graphics\/|avatar|profile/iu.test(new URL(source).pathname)) continue;
    const control = el.closest('button,a,[role="button"]') ?? el;
    if ((control.innerText ?? '').trim() && !/^[\d\s:+/]+$/.test(control.innerText.trim())) continue;
    const key = new URL(source).pathname.replace(/\/(?:wc|w|c|s)\d+(?:_\d+)?\//g, '/');
    if (!found.has(key)) found.set(key, { index, source, fingerprint: source, key });
  }
  return [...found.values()];
}

export function largeGalleryMedia(root) {
  const media = [...root.querySelectorAll('img,video,source')].filter(el => {
    const displayed = el.tagName === 'SOURCE' ? el.parentElement : el; const box = displayed.getBoundingClientRect();
    return box.width >= 200 && box.height >= 200 && box.width * box.height >= 120000;
  }).map(el => ({ tag: el.tagName.toLowerCase(), src: el.currentSrc || el.src || el.getAttribute('src'), srcset: el.getAttribute('srcset'),
    width: el.naturalWidth || el.videoWidth || 0, height: el.naturalHeight || el.videoHeight || 0, poster: el.poster || null, alt: el.getAttribute('alt') ?? '' }));
  // Ozon's review viewer paints its LARGE photograph as a CSS background.
  // Reading only img/video silently kept the small "other users" covers instead.
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const box = el.getBoundingClientRect(); if (box.width < 200 || box.height < 200 || box.width * box.height < 120000) continue;
    for (const match of getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)) media.push({ tag: 'img', src: match[1], width: 0, height: 0, alt: '', displayedWidth: box.width, displayedHeight: box.height });
  }
  return media;
}

/** Repeated entities are bounded by semantic links/help prompts, never Ozon
 * class names. Luna still interprets each isolated subtree. It is not asked to
 * join authors, bodies and answers across an entire long page anymore. */
export function listEntityCandidates(adapter, kind) {
  const nodes = [...adapter.current.nodes.values()]; const result = new Map();
  const questionLinks = nodes.filter(node => node.role === 'link' && /\/question\/[\w-]+/.test(node.url ?? ''));
  // A star-only review has no body/helpfulness toolbar. Dated review headers
  // still define a separate entity, so those ratings must not disappear.
  const markers = kind === 'questions' ? questionLinks : nodes.filter(node => /^(?:измен[её]н\s+)?\d{1,2}\s+[а-я]+\s+20\d{2}$/iu.test(node.directText.trim()));
  const isAncestor = (ancestor, node) => {
    while (node) { if (ancestor.source === node.source) return true; node = adapter.current.nodes.get(node.parentRef); } return false;
  };
  for (const marker of markers) {
    let row = marker; let best = null;
    while (row) {
      if (!row.parentRef && row.role !== 'article' || ['main', 'WebArea', 'document'].includes(row.role) || row.text.length > 18000 || /Задайте вопрос о товаре|Отзывы о товаре|Рейтинг формируется на основе/iu.test(row.text)) break;
      const count = markers.filter(item => isAncestor(row, item)).length;
      if (count > 1) break;
      if (/\d{1,2}\s+[а-я]+\s+20\d{2}/iu.test(row.text)) {
        best = row;
        if (row.role === 'article') break;
      }
      row = adapter.current.nodes.get(row.parentRef);
    }
    if (best) result.set(best.source, { ...best, seed: marker.url ?? best.text.slice(0, 250) });
  }
  return [...result.values()];
}

/** Choose a nearby evidence parent only when it proves the requested fact.
 * Bounded ancestors preserve local association and cannot fall back to body. */
export function enclosingEvidence(adapter, source, predicate, maxChars = 8000) {
  let node = source ? adapter.evidence(source) : null;
  while (node && node.text.length <= maxChars) {
    if (predicate(node.text, node)) return node;
    node = adapter.snapshots.get(node.source.split(':')[0])?.nodes.get(node.parentRef);
  }
  return null;
}

/** Native definition lists/tables retain their semantic meaning even as Ozon
 * generated widget classes change. The model opens/expands the right section;
 * the host copies complete pairs without a long model transcription step. */
export function semanticAttributes() {
  const rows = []; let incomplete = 0; const seen = new Set();
  const add = (name, value) => {
    name = name?.trim(); value = value?.trim();
    if (!name || !value) { incomplete++; return; }
    if (name.length > 300 || value.length > 5000) return;
    const key = name + '\n' + value;
    if (!seen.has(key)) { rows.push({ name, value, sourceText: key, evidenceType: 'semantic_definition' }); seen.add(key); }
  };
  for (const term of document.querySelectorAll('dt,[role="term"]')) {
    const parent = term.parentElement;
    const definitions = parent ? [...parent.querySelectorAll('dd,[role="definition"]')] : [];
    if (definitions.length === 1 && parent.querySelectorAll('dt,[role="term"]').length === 1) add(term.innerText || term.textContent, definitions[0].innerText || definitions[0].textContent);
    else incomplete++;
  }
  for (const row of document.querySelectorAll('table tr')) {
    const cells = [...row.children]; if (cells.length === 2 && cells[0].tagName === 'TH') add(cells[0].innerText, cells[1].innerText);
  }
  return { rows, incomplete };
}

/** Read a rendered five-icon rating group without widget class names or a
 * hardcoded SVG path. Five identical adjacent glyphs form the scale; actual
 * warm filled colors distinguish stars from gray empty ones. Ambiguous themes
 * or geometry return null so the visual adapter remains the fallback. */
export function renderedStars(root) {
  const groups = new Map();
  for (const svg of root.querySelectorAll('svg')) {
    const box = svg.getBoundingClientRect(); const shape = svg.querySelector('path')?.getAttribute('d');
    if (!shape || box.width < 12 || box.width > 28 || box.height < 12 || box.height > 28) continue;
    const entry = { x: box.x, y: box.y, color: getComputedStyle(svg.querySelector('path') ?? svg).fill };
    const group = groups.get(shape) ?? []; group.push(entry); groups.set(shape, group);
  }
  for (const glyphs of groups.values()) {
    if (glyphs.length !== 5 || Math.max(...glyphs.map(g => g.y)) - Math.min(...glyphs.map(g => g.y)) > 3 || Math.max(...glyphs.map(g => g.x)) - Math.min(...glyphs.map(g => g.x)) > 140) continue;
    let filled = 0; let known = true;
    for (const glyph of glyphs) {
      const [r, g, b] = glyph.color.match(/[\d.]+/g)?.map(Number) ?? [];
      if (r > 150 && r - b > 100 && g < 240) filled++;
      else if (Math.max(r, g, b) - Math.min(r, g, b) > 55) known = false;
    }
    if (known && filled >= 1) return { stars: filled, scale: 5, evidence: 'rendered_icon_group', colors: glyphs.map(g => g.color) };
  }
  return null;
}

/** Native checked inputs can have an empty AX name while their associated
 * label carries the brand. Read that real relationship, not a model assertion
 * or a broad page-wide text occurrence. */
export function selectedControlLabels() {
  const labels = [];
  for (const el of document.querySelectorAll('input:checked,[aria-checked="true"],[aria-selected="true"],option:checked')) {
    const direct = el.getAttribute('aria-label') || el.innerText || '';
    if (direct.trim()) labels.push(direct.trim());
    for (const label of el.labels ?? []) if (label.innerText?.trim()) labels.push(label.innerText.trim());
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (parent.querySelectorAll('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]').length > 1) break;
      const text = parent.innerText?.trim(); if (text && text.length <= 180) labels.push(text); else if (text?.length > 180) break;
    }
  }
  return [...new Set(labels)];
}

/** A neutral fixed overlay may be omitted from the AX tree. Bind that actual
 * viewport-sized media object, then expose its complete fragment as e0. The
 * chosen review identity must occur INSIDE it, never in the underlying page. */
export function findGalleryOverlay(expected) {
  const norm = value => String(value ?? '').toLocaleLowerCase().replace(/[\s.,:;«»"'()—–-]+/g, '');
  return [...document.querySelectorAll('body *')].find(el => {
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (style.position !== 'fixed' || style.visibility === 'hidden' || box.width < innerWidth * 0.7 || box.height < innerHeight * 0.7 || !el.querySelector('img,video')) return false;
    if ([...el.querySelectorAll('button,[role="button"]')].some(button => /в корзин|оформить заказ|купить сейчас/iu.test(button.innerText))) return false;
    if (expected?.author && !norm(el.innerText).includes(norm(expected.author))) return false;
    return true;
  }) ?? null;
}

/** Match a network stream to its visible main video/poster asset. Viewer
 * prefetches for OTHER reviews are intentionally excluded from this identity. */
export function videoAssetId(value) {
  try { return new URL(value).pathname.match(/\/video-\d+\/([^/]+)\//)?.[1] ?? null; } catch { return null; }
}
