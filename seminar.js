"use strict";

const invalid = (reason) => ({ invalid: reason });
const fillHoles = (e) => Array.from(e); // […,,…] → […,undefined,…] (.every/.some/.map/… skip holes!)
const isArrayOfNStrings = (e, N) =>
  Array.isArray(e) && e.length === N && fillHoles(e).every((f) => typeof f === "string");

const term = (() => {
  const compare = (a, b) => TERMS[b].firstMonth - TERMS[a].firstMonth; // reverse chronological
  return { compare, sorted: Object.keys(TERMS).sort(compare) };
})();
const termYear = {
  compare: (a, b) => -(a.year - b.year) || term.compare(a.term, b.term), // reverse chronological
  make(t, y) { return { term: t, year: y, name: `${t} ${y}`, abbr: TERMS[t].abbr + y.slice(-2) }; },
  parse(t, y) {
    if (!Object.hasOwn(TERMS, t))
      return invalid(`unknown term "${t}"`);
    if (typeof y !== "string" || !/^\d{4}$/.test(y))
      return invalid(`invalid year "${y}"`);
    return this.make(t, y);
  },
};
class SeminarDate extends Date {
  static #months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  static today() { // local date at UTC midnight, to be compared to UTC-parsed talk dates
    const now = new Date();
    return new SeminarDate(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  }
  get iso() { return this.toISOString().slice(0, 10); }
  get parts() { return { month: SeminarDate.#months[this.getUTCMonth()],
                           day:              String(this.getUTCDate()),
                          year:              String(this.getUTCFullYear()), };
  }
  get termYear() {
    const month = this.getUTCMonth() + 1;
    const t = term.sorted.find((t) => TERMS[t].firstMonth <= month);
    const y = this.getUTCFullYear();
    return termYear.make(t || term.sorted[0], String(t ? y : y - 1));
  }
}
function parseDate(iso) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new SeminarDate(iso) : NaN; // UTC midnight b/c date-only
  return isNaN(date) || date.iso !== iso ? invalid(`invalid date "${iso}"`) : date;
}

const fieldsOf = (colHeaders) => ({ fields: colHeaders, index: Object.fromEntries(colHeaders.map((f, i) => [f, i])) });
const data = {
  talks: {
    ...fieldsOf(["dateISO", "name", "href", "affil", "title", "cat"]),
    rows: TALKS,
    parse(row) {
      if (!isArrayOfNStrings(row, this.fields.length))
        return invalid("malformed");
      if (!CATEGORIES.includes(row[this.index.cat]))
        return invalid(`unknown category "${row[this.index.cat]}"`);
      const date = parseDate(row[this.index.dateISO]);
      if (date.invalid) return date;
      return { row, date,
        ...Object.fromEntries(this.fields.flatMap((f, i) => i === this.index.dateISO ? [] : [[f, row[i]]]))
      };
    },
    compare: (t, u) => t.date - u.date, // chronological
  },
  editions: {
    ...fieldsOf(["term", "year", "time", "room", "orgs"]),
    rows: EDITIONS,
    parse(row) {
      if (!Array.isArray(row) || !isArrayOfNStrings(row.slice(0, this.index.orgs), this.index.orgs))
        return invalid("malformed");
      if (!fillHoles(row.slice(this.index.orgs)).every((org) => isArrayOfNStrings(org, 2)))
        return invalid("malformed organizer");
      const ty = termYear.parse(row[this.index.term], row[this.index.year]);
      if (ty.invalid) return ty;
      return { ...ty, time: row[this.index.time], room: row[this.index.room], orgs: row.slice(this.index.orgs) };
    },
    compare: termYear.compare, // reverse chronological
  },
};
const parseData = (kind) => fillHoles(data[kind].rows).flatMap((row, i) => {
  const p = data[kind].parse(row);
  if (p.invalid) { console.warn(`Dropping ${kind.toUpperCase()} row #${i + 1} — ${p.invalid}:`, row); return []; }
  return [p];
}).sort(data[kind].compare);
const [talks, editionsParsed] = ["talks", "editions"].map(parseData);
const editions = new Map(editionsParsed.map((e) => [e.abbr, e]));
[...editionsParsed.reduce((m, e) => m.set(e.abbr, [...(m.get(e.abbr) ?? []), e]), new Map())]
  .filter(([_abbr, es]) => es.length > 1)
  .forEach(([abbr, es]) => console.warn(`Duplicate abbreviation "${abbr}" — dropping all but the last one here:`, es));
const defaultTermYear = termYear.parse(...DEFAULT);
const fallback = defaultTermYear.invalid ||
  (!editions.has(defaultTermYear.abbr) ? `unknown edition ${defaultTermYear.name}` : undefined);
const defaultAbbr = fallback ? editions.keys().next().value : defaultTermYear.abbr;
if (fallback) console.warn(`Dropping DEFAULT & using newest edition — ${fallback}:`, DEFAULT);
const countStats = (condition = (_) => true) => new Map(SEARCHCATS
  .map((cat) => [cat, talks.filter((t) => condition(t) && t.cat === cat).length]));

const param = {
  makeURL(value) {
    const u = new URL(document.baseURI);
    u.searchParams.set("s", value);
    return u;
  },
  readURL() { return new URL(window.location.href).searchParams.get("s"); },
  parse(vAlUE) {
    vAlUE = vAlUE?.trim() ?? "";
    if (!vAlUE) return undefined;
    const value = vAlUE.toLowerCase();
    return editions.has(value) ? value : vAlUE;
  },
  current() { return this.parse(this.readURL()) ?? defaultAbbr; },
};

const pdf = {
  path: (iso) => `pdf/${iso}.pdf`,
  match: (pathname) => pathname.match(/\/pdf\/(\d{4}-\d{2}-\d{2})\.pdf$/)?.[1],
};

const csv = (() => {
  let url;
  const create = (arrayOfArrayOfStrings) => arrayOfArrayOfStrings
    .map((row) => row.map((f) => `"${f.replace(/"/g, '""')}"`).join(","))
    .join("\r\n") + "\r\n";
  const createURL = (arrayOfArrayOfStrings) => {
    revokeURL();
    return url = URL.createObjectURL(new Blob(["\uFEFF", create(arrayOfArrayOfStrings)], { type: "text/csv;charset=utf-8" }));
  };
  const revokeURL = () => { if (url) { URL.revokeObjectURL(url); url = undefined; } };
  return { createURL, revokeURL };
})();

const baseDocTitle = document.title;
const addToBaseDocTitle = (x) => document.title = `${baseDocTitle} — ${x}`;
const dom = Object.freeze(Object.fromEntries(
  ["header", "masthead", "headline", "controls", "toggle", "select", "form", "search", "info", "content", "colophon"]
  .map((id) => [id, document.getElementById(id)])
));
function el(tag, { dataset, ...properties } = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, properties);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function showError() {
  dom.headline.textContent = "404 — Not Found";
  addToBaseDocTitle("404");
  const match = pdf.match(window.location.pathname);
  dom.info.textContent = match && talks.some((t) => t.date.iso === match && t.title)
    ? "The PDF is not available (yet)." : "Page not found.";
}

const escapeRegex = RegExp.escape ?? ((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
function makeRegexes(query) { // "/…/flags"    → [raw regex] or undefined if invalid
                              // anything else → array containing one regex per word
  const m = query.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {                             // drop g and y flags (per-field .test would go stateful)
    try   { return [new RegExp(m[1], m[2].replace(/[gy]/g, ""))]; }
    catch { return undefined; }        // bad pattern or unknown/duplicate/conflicting flags
  }
  return [...new Set(query.toLowerCase().split(/\s+/))].map((w) => new RegExp(escapeRegex(w), "i"));
}
const views = {
  schedule(abbr) {
    const edition = editions.get(abbr);
    return {
      condition: (t) => t.date.termYear.abbr === abbr,
      docTitle: edition.name,
      searchValue: "",
      headline: (_results) => edition.name,
      info: (_results) => [edition.time, " in ", edition.room,
          edition.orgs.length === 0 ? "" : el("span", { className: "subinfo" },
            ` — Organizer${edition.orgs.length > 1 ? "s" : ""}: `,
            ...(edition.orgs.flatMap(([name, href]) => [el("a", { href }, name), ", "]).slice(0, -1))
          )],
      dateLink: (_t) => undefined,
    };
  },
  search(query) {
    const regexes = makeRegexes(query);
    return {
      condition: regexes
        ? (t) => SEARCHCATS.includes(t.cat) && regexes.every((r) => ["name", "affil", "title"].some((f) => r.test(t[f])))
        : (_t) => false,
      docTitle: `Search for "${query}"`,
      searchValue: query,
      headline: (results) => { const n = results.length; return `${n} Result${n === 1 ? "" : "s"}` },
      info: (results) => {
        if (!results.length)
          return regexes ? [`No search results for "${query}"`] : [`Invalid regex search pattern "${query}"`];
        return [
          el("a", { href: csv.createURL(results.map((t) => t.row)), download: "results.csv" }, "Download"),
          ` search results for "${query}" as CSV file`
        ];
      },
      dateLink: (t) => {
        const abbr = t.date.termYear.abbr;
        return (editions.has(abbr)) ? { href: param.makeURL(abbr).href, dataset: { abbr } } : undefined;
      },
    };
  },
};
function showTalks() {
  const value = param.current();
  const view = views[editions.has(value) ? "schedule" : "search"](value);
  const results = talks.filter(view.condition);
  const today = SeminarDate.today();
  const next = talks.find((t) => !EXTRACATS.includes(t.cat) && today <= t.date);
  const dl = dom.content.querySelector("dl") ?? setupTalksPage();
  menu.closeOnNarrow();
  csv.revokeURL();
  dl.replaceChildren();
  dom.search.value = view.searchValue;
  addToBaseDocTitle(view.docTitle);
  dom.headline.textContent = view.headline(results);
  dom.info.replaceChildren(...view.info(results));
  results.forEach((t) => {
    const parts = t.date.parts;
    const time = el("time", { dateTime: t.date.iso },
      ...Object.keys(parts).map((part) => el("span", { className: part }, parts[part]))
    );
    const link = view.dateLink(t);
    const dt = el("dt", {}, link ? el("a", link, time) : time);
    const dd = el("dd", {},
      el("div", { className: "speaker" },
        t.href ? el("a", { href: t.href }, t.name) : t.name,
        t.affil ? el("span", { className: "affil" }, ` (${t.affil})`) : ""
      ),
      t.title ? el("div", { className: "title" }, el("a", { href: pdf.path(t.date.iso) }, t.title) ) : ""
    );
    if (t === next) dt.classList.add("next");
    if (EXTRACATS.includes(t.cat)) { dt.classList.add("extra"); dd.classList.add(t.cat); }
    dl.append(dt, dd);
  });
}
function setupTalksPage() {
  const dl = el("dl");
  dom.content.replaceChildren(dl);
  window.addEventListener("popstate", showTalks);
  dom.content.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const abbr = event.target.closest("dt a")?.dataset.abbr;
    if (!abbr) return;
    event.preventDefault();
    goTo(abbr);
  });
  // then fix a bug in Safari: grid row heights not recomputed upon width-driven resize
  let lastWidth = window.innerWidth;
  let queued = false;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // only width-driven changes matter
    lastWidth = window.innerWidth;
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      dom.content.style.display = "none";
      dom.content.offsetHeight; // force reflow
      dom.content.style.display = "";
    });
  });
  return dl;
}

const isNotTalksPage = document.body.dataset.page !== "talks";
function goTo(value) {
  if (isNotTalksPage) return window.location.assign(param.makeURL(value));
  if (param.current() !== value) window.history.pushState(null, "", param.makeURL(value));
  showTalks();
  // scroll up (never down) but without unhiding the header above the sticky strip
  const target = window.scrollY + Math.min(0, dom.header.getBoundingClientRect().bottom);
  window.scrollTo({ top: target, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto" : "smooth" });
}

dom.select.addEventListener("change", (event) => {
  const value = event.target.value;
  dom.select.value = ""; // restore placeholder, which doubles as the select’s visible and accessible name
                         // no aria-labels b/c adding them yields double announcements
  goTo(value);
});
dom.form.addEventListener("submit", (event) => {
  const value = param.parse(dom.search.value);
  event.preventDefault();
  if (value) goTo(value);
});

const style = window.getComputedStyle(document.documentElement);
const getCSSVar = (v) => style.getPropertyValue(v).trim();
const mqWide = window.matchMedia(`(min-width: ${getCSSVar("--breakpoint")})`);
const menu = {
  isOpen() { return dom.toggle.getAttribute("aria-expanded") === "true"; },
  setOpen(bool)   { dom.toggle.setAttribute("aria-expanded", String(bool)); },
  closeOnNarrow() {
    if (mqWide.matches) return;
    if (dom.controls.contains(document.activeElement)) dom.toggle.focus();
    this.setOpen(false);
  },
};
dom.toggle.addEventListener("click", () => menu.setOpen(!menu.isOpen()));
mqWide.addEventListener("change", () => {
  if (mqWide.matches) { if (document.activeElement === dom.toggle) dom.select.focus(); }
  else menu.closeOnNarrow();
});
document.addEventListener("click", (event) => {
  if (mqWide.matches || !menu.isOpen()) return;
  if (!dom.controls.contains(event.target)) menu.closeOnNarrow();
});
dom.controls.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || mqWide.matches || !menu.isOpen()) return;
  if (event.target === dom.search && dom.search.value) { dom.search.value = ""; return; }
  menu.closeOnNarrow();
});

editions.forEach((e, abbr) => dom.select.append(el("option", { value: abbr }, e.name)));
dom.masthead.textContent = baseDocTitle;
const updated = parseDate(UPDATED);
const { month, day, year } = updated.parts || {};
dom.colophon.append(el("p", {}, month ? `Updated ${month} ${day}, ${year}` : ""));
                       // the colophon’s CSS needs a p:last-child, even if empty
if (updated.invalid) console.warn(`Dropping UPDATED — ${updated.invalid}:`, UPDATED);

({ talks: showTalks, error: showError })[document.body.dataset.page]?.();
