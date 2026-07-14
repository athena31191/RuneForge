import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Sword, Plus, Trash2, Pencil, X, RotateCcw, Check, Skull, Flame, Save, ChevronDown, ChevronUp, BookOpen, ScanLine, Loader2, User } from "lucide-react";

/* ---------------------------------- constants ---------------------------------- */

const SLOTS = ["Weapon", "Offhand", "Helm", "Chest", "Gloves", "Pants", "Boots", "Amulet", "Ring", "Other"];
const CAPACITY = { Weapon: 1, Offhand: 1, Helm: 1, Chest: 1, Gloves: 1, Pants: 1, Boots: 1, Amulet: 1, Ring: 2, Other: Infinity };

const RARITIES = {
  Common: "#9b9b93",
  Magic: "#5b8bf0",
  Rare: "#e8c547",
  Legendary: "#e8792f",
  Unique: "#c9a86a",
};

const AFFIX_CATEGORIES = [
  { key: "weaponMin", label: "Weapon Min Damage", suffix: "" },
  { key: "weaponMax", label: "Weapon Max Damage", suffix: "" },
  { key: "baseAPS", label: "Base Attacks / Sec", suffix: "" },
  { key: "attackSpeed", label: "Attack Speed", suffix: "%" },
  { key: "critChance", label: "Crit Chance", suffix: "%" },
  { key: "critDamage", label: "Crit Damage", suffix: "%" },
  { key: "vulnerableDamage", label: "Vulnerable Damage", suffix: "%" },
  { key: "additive", label: "Additive Damage (skill / mastery / etc.)", suffix: "%" },
  { key: "multiplicative", label: "Multiplicative Bucket (named)", suffix: "%", needsBucket: true },
];

const CATEGORY_LABEL = Object.fromEntries(AFFIX_CATEGORIES.map((c) => [c.key, c.label]));

const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------------------------- OCR item-scan parsing ---------------------------------- */
/* Turns raw text recognized from a tooltip screenshot into a draft item matching our affix
   model. Best-effort heuristics — the result always lands in the editable form before saving,
   never applied directly, since OCR and slot/rarity guessing are never going to be perfect. */

const RARITY_WORDS = ["Common", "Magic", "Rare", "Legendary", "Unique"];

const SLOT_KEYWORDS = [
  [/sword|axe|mace|dagger|wand|staff|polearm|bow|crossbow|greatblade|glaive|scythe/i, "Weapon"],
  [/shield|focus|totem|offhand|quiver/i, "Offhand"],
  [/helm|circlet|crown|cap|hood/i, "Helm"],
  [/chest|robe|plate|tunic/i, "Chest"],
  [/glove|gauntlet|bracer/i, "Gloves"],
  [/pant|legs|greaves/i, "Pants"],
  [/boot|sabaton|treads/i, "Boots"],
  [/amulet|necklace|pendant/i, "Amulet"],
  [/ring|band|signet/i, "Ring"],
];

function normalizeDashes(s) {
  return s.replace(/[\u2010-\u2015\u2212]/g, "-");
}

function guessSlot(headerText) {
  for (const [re, slot] of SLOT_KEYWORDS) {
    if (re.test(headerText)) return slot;
  }
  return "Weapon";
}

function guessRarity(text) {
  for (const r of RARITY_WORDS) {
    if (new RegExp(`\\b${r}\\b`, "i").test(text)) return r;
  }
  return "Rare";
}

function parseItemFromOcrText(rawText) {
  const text = normalizeDashes(rawText || "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const affixes = [];
  const name = lines[0] || "Scanned Item";

  for (const line of lines) {
    // weapon damage range — tolerant of commas ("1,151 - 1,727"), brackets
    // ("[158 - 210]"), and trailing words ("Damage per Hit")
    const dmgMatch = line.match(/[[(]?\s*([\d,]+)\s*-\s*([\d,]+)\s*[\])]?\s*Damage/i);
    if (dmgMatch) {
      affixes.push({ category: "weaponMin", value: parseFloat(dmgMatch[1].replace(/,/g, "")) });
      affixes.push({ category: "weaponMax", value: parseFloat(dmgMatch[2].replace(/,/g, "")) });
      continue;
    }

    // attacks per second — real tooltips lead with the number
    // ("1.20 Attacks per Second (Very Fast)"); also accept the reverse
    // ("Attacks per Second: 1.20") in case a different UI uses it
    const apsLeading = line.match(/([\d.]+)\s*Attacks?\s*per\s*Second/i);
    const apsTrailing = line.match(/Attacks?\s*per\s*Second[:\s]+([\d.]+)/i);
    const apsMatch = apsLeading || apsTrailing;
    if (apsMatch) {
      affixes.push({ category: "baseAPS", value: parseFloat(apsMatch[1]) });
      continue;
    }

    // multiplicative stats are marked with an "x" prefix and the word
    // "Multiplier" in real tooltips ("x13% All Damage Multiplier",
    // "x41% Critical Strike Damage Multiplier") — much more reliable than
    // guessing from wording, so check this before the generic "+%" case
    const xMultMatch = line.match(/\bx\s*(\d+(?:\.\d+)?)\s*%/i);
    if (xMultMatch && /multiplier/i.test(line)) {
      const value = parseFloat(xMultMatch[1]);
      const rest = line.slice(xMultMatch.index + xMultMatch[0].length).trim();
      if (/critical strike damage/i.test(rest)) {
        affixes.push({ category: "critDamage", value });
      } else if (/critical strike chance/i.test(rest)) {
        affixes.push({ category: "critChance", value });
      } else if (/vulnerable damage/i.test(rest)) {
        affixes.push({ category: "vulnerableDamage", value });
      } else {
        const bucket = rest
          .replace(/multiplier/i, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\[.*?\]/g, "")
          .trim() || "Multiplier";
        affixes.push({ category: "multiplicative", bucket, value });
      }
      continue;
    }

    // everything else: a plain "+X%" line — additive stat pool, unless
    // it's one of the few fields with their own dedicated slot
    const pctMatch = line.match(/\+?\s*(\d+(?:\.\d+)?)\s*%/);
    if (!pctMatch) continue;
    const value = parseFloat(pctMatch[1]);

    if (/critical strike chance|crit(?:ical)?\s*chance/i.test(line)) {
      affixes.push({ category: "critChance", value });
    } else if (/critical strike damage|crit(?:ical)?\s*damage/i.test(line)) {
      affixes.push({ category: "critDamage", value });
    } else if (/vulnerable damage/i.test(line)) {
      affixes.push({ category: "vulnerableDamage", value });
    } else if (/attack speed/i.test(line)) {
      affixes.push({ category: "attackSpeed", value });
    } else if (/damage/i.test(line)) {
      affixes.push({ category: "additive", value });
    }
    // lines with a % but no recognizable "damage" concept (Life, Resistance,
    // attributes, Toughness, etc.) are intentionally skipped rather than
    // guessed at — omitting is safer than silently distorting the math
  }

  return {
    name,
    slot: guessSlot(lines.slice(0, 2).join(" ")),
    rarity: guessRarity(text),
    affixes: affixes.map((a) => ({ id: uid(), ...a })),
  };
}

// Runs entirely client-side against locally-bundled worker/core/language files
// (see public/tesseract/) — the image never leaves the browser.
async function runOcrOnImage(file) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/tesseract-core-lstm.wasm.js",
    langPath: "/tesseract",
    gzip: true,
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

const DEFAULT_BASE = {
  weaponMin: 120,
  weaponMax: 185,
  baseAPS: 1.2,
  skillMultiplier: 100,
  critChance: 5,
  critDamage: 50,
  vulnerableDamage: 20,
  additive: 0,
};

const DEFAULT_ITEMS = [
  {
    id: uid(),
    name: "Aspect-Etched Greatblade",
    slot: "Weapon",
    rarity: "Legendary",
    affixes: [
      { id: uid(), category: "weaponMin", value: 210 },
      { id: uid(), category: "weaponMax", value: 340 },
      { id: uid(), category: "baseAPS", value: 0.1 },
      { id: uid(), category: "critDamage", value: 45 },
    ],
  },
  {
    id: uid(),
    name: "Circlet of Vengeance",
    slot: "Helm",
    rarity: "Rare",
    affixes: [
      { id: uid(), category: "critChance", value: 6 },
      { id: uid(), category: "additive", value: 12 },
    ],
  },
  {
    id: uid(),
    name: "Band of the Exposed",
    slot: "Ring",
    rarity: "Legendary",
    affixes: [
      { id: uid(), category: "vulnerableDamage", value: 28 },
      { id: uid(), category: "multiplicative", bucket: "Close", value: 15 },
    ],
  },
  {
    id: uid(),
    name: "Paragon: Berserking Glyph",
    slot: "Other",
    rarity: "Unique",
    affixes: [{ id: uid(), category: "multiplicative", bucket: "Berserking", value: 20 }],
  },
];

/* ---------------------------------- math ---------------------------------- */

function toggleEquip(equippedIds, items, itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return equippedIds;
  if (equippedIds.includes(itemId)) return equippedIds.filter((id) => id !== itemId);
  const capacity = CAPACITY[item.slot] ?? 1;
  const sameSlot = equippedIds.filter((id) => items.find((i) => i.id === id)?.slot === item.slot);
  let next = equippedIds;
  if (sameSlot.length >= capacity) next = next.filter((id) => id !== sameSlot[0]);
  return [...next, itemId];
}

function computeTotals(base, items, equippedIds) {
  const totals = { ...base, attackSpeed: 0 };
  const buckets = {};
  equippedIds.forEach((id) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.affixes.forEach((a) => {
      const val = Number(a.value) || 0;
      if (a.category === "multiplicative") {
        const key = (a.bucket || "General").trim() || "General";
        buckets[key] = (buckets[key] || 0) + val;
      } else if (totals[a.category] !== undefined) {
        totals[a.category] += val;
      }
    });
  });
  return { totals, buckets };
}

function computeDamage(totals, buckets, vulnerableActive) {
  const avgWeapon = (totals.weaponMin + totals.weaponMax) / 2;
  const baseHit = avgWeapon * (totals.skillMultiplier / 100);
  const additiveMult = 1 + totals.additive / 100;
  const critChanceClamped = Math.min(Math.max(totals.critChance, 0), 100);
  const critMult = 1 + (critChanceClamped / 100) * (totals.critDamage / 100);
  const vulnMult = vulnerableActive ? 1 + totals.vulnerableDamage / 100 : 1;
  const bucketMult = Object.values(buckets).reduce((acc, v) => acc * (1 + v / 100), 1);
  const hitDamage = baseHit * additiveMult * critMult * vulnMult * bucketMult;
  const totalAPS = Math.max(totals.baseAPS, 0) * (1 + totals.attackSpeed / 100);
  const dps = hitDamage * totalAPS;
  return { hitDamage, dps, totalAPS, critChanceClamped };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }) : "0");

function summarizeAffixes(item) {
  const out = {};
  if (!item) return out;
  item.affixes.forEach((a) => {
    const key = a.category === "multiplicative" ? `mult:${(a.bucket || "General").trim()}` : a.category;
    out[key] = (out[key] || 0) + (Number(a.value) || 0);
  });
  return out;
}

function keyLabel(key) {
  if (key.startsWith("mult:")) return `${key.slice(5)} (×)`;
  return CATEGORY_LABEL[key] || key;
}

function simulateEquip(item, base, items, equippedIds, vulnerableActive) {
  const hypoIds = toggleEquip(equippedIds, items, item.id);
  const { totals, buckets } = computeTotals(base, items, hypoIds);
  return computeDamage(totals, buckets, vulnerableActive);
}

function initialEquip(items) {
  const counts = {};
  const ids = [];
  items.forEach((it) => {
    const cap = CAPACITY[it.slot] ?? 1;
    counts[it.slot] = counts[it.slot] || 0;
    if (counts[it.slot] < cap) {
      ids.push(it.id);
      counts[it.slot] += 1;
    }
  });
  return ids;
}

/* ---------------------------------- small UI bits ---------------------------------- */

function StatInput({ label, value, onChange, step = 1, suffix = "" }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span style={{ color: "var(--rf-muted)" }} className="text-sm">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : parseFloat(e.target.value))}
          className="rf-mono w-24 text-right rounded px-2 py-1 text-sm outline-none"
          style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
        />
        {suffix && <span className="text-xs w-4" style={{ color: "var(--rf-muted)" }}>{suffix}</span>}
      </span>
    </label>
  );
}

function DeltaBadge({ delta, percent, equipped }) {
  if (!Number.isFinite(delta) || Math.abs(percent) < 0.05) {
    return <span className="rf-mono text-xs px-2 py-0.5 rounded" style={{ color: "var(--rf-muted)", border: "1px solid var(--rf-border)" }}>no change</span>;
  }
  const positive = delta > 0;
  const good = equipped ? !positive : positive; // for equipped items, removing (negative delta shown) is expected; color by whether keeping/adding helps
  const color = positive ? "var(--rf-good)" : "var(--rf-bad)";
  const sign = positive ? "+" : "";
  const verb = equipped ? "if removed" : "if equipped";
  return (
    <span className="rf-mono text-xs px-2 py-0.5 rounded font-semibold" style={{ color, border: `1px solid ${color}55`, background: `${color}14` }}>
      {sign}{fmt(percent, 1)}% dps {verb}
    </span>
  );
}

/* ---------------------------------- item form ---------------------------------- */

function ItemForm({ initial, onCancel, onSave }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slot, setSlot] = useState(initial?.slot ?? "Weapon");
  const [rarity, setRarity] = useState(initial?.rarity ?? "Legendary");
  const [affixes, setAffixes] = useState(initial?.affixes?.length ? initial.affixes : [{ id: uid(), category: "additive", value: 10 }]);

  const addAffix = () => setAffixes((a) => [...a, { id: uid(), category: "additive", value: 10 }]);
  const removeAffix = (id) => setAffixes((a) => a.filter((x) => x.id !== id));
  const updateAffix = (id, patch) => setAffixes((a) => a.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const save = () => {
    if (!name.trim()) return;
    onSave({ id: initial?.id ?? uid(), name: name.trim(), slot, rarity, affixes: affixes.filter((a) => a.value !== "" && a.value != null) });
  };

  return (
    <div className="rounded-lg p-4 mb-4" style={{ background: "#1c1512", border: "1px solid var(--rf-border)" }}>
      <div className="flex flex-wrap gap-3 mb-3">
        <input
          placeholder="Item name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-[180px] rounded px-3 py-2 text-sm outline-none"
          style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
        />
        <select value={slot} onChange={(e) => setSlot(e.target.value)} className="rounded px-3 py-2 text-sm outline-none" style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}>
          {SLOTS.map((s) => (<option key={s} value={s}>{s}</option>))}
        </select>
        <select value={rarity} onChange={(e) => setRarity(e.target.value)} className="rounded px-3 py-2 text-sm outline-none" style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}>
          {Object.keys(RARITIES).map((r) => (<option key={r} value={r}>{r}</option>))}
        </select>
      </div>

      <div className="space-y-2 mb-3">
        {affixes.map((a) => {
          const cat = AFFIX_CATEGORIES.find((c) => c.key === a.category);
          return (
            <div key={a.id} className="flex flex-wrap items-center gap-2">
              <select
                value={a.category}
                onChange={(e) => updateAffix(a.id, { category: e.target.value })}
                className="rounded px-2 py-1.5 text-sm outline-none flex-1 min-w-[200px]"
                style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
              >
                {AFFIX_CATEGORIES.map((c) => (<option key={c.key} value={c.key}>{c.label}</option>))}
              </select>
              {cat?.needsBucket && (
                <input
                  placeholder="Bucket name (e.g. Berserking)"
                  value={a.bucket ?? ""}
                  onChange={(e) => updateAffix(a.id, { bucket: e.target.value })}
                  className="rounded px-2 py-1.5 text-sm outline-none w-40"
                  style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
                />
              )}
              <input
                type="number"
                value={a.value}
                onChange={(e) => updateAffix(a.id, { value: e.target.value === "" ? "" : parseFloat(e.target.value) })}
                className="rf-mono rounded px-2 py-1.5 text-sm outline-none w-24 text-right"
                style={{ background: "#120d0b", border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
              />
              <span className="text-xs w-4" style={{ color: "var(--rf-muted)" }}>{cat?.suffix}</span>
              <button onClick={() => removeAffix(a.id)} className="p-1.5 rounded hover:opacity-80" style={{ color: "var(--rf-bad)" }}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <button onClick={addAffix} className="flex items-center gap-1 text-xs px-2 py-1.5 rounded" style={{ color: "var(--rf-ember)", border: "1px solid var(--rf-border)" }}>
          <Plus size={13} /> Add affix
        </button>
        <div className="flex gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded" style={{ color: "var(--rf-muted)", border: "1px solid var(--rf-border)" }}>Cancel</button>
          <button onClick={save} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded font-semibold" style={{ background: "var(--rf-blood)", color: "#fff" }}>
            <Check size={13} /> Save item
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- item card ---------------------------------- */

function ItemCard({ item, equipped, dps, base, items, equippedIds, vulnerableActive, onToggle, onEdit, onDelete, compareSelected, onToggleCompare }) {
  const preview = useMemo(() => {
    const hypo = simulateEquip(item, base, items, equippedIds, vulnerableActive);
    const delta = hypo.dps - dps;
    const percent = dps > 0 ? (delta / dps) * 100 : 0;
    return { delta, percent };
  }, [equippedIds, items, item, base, vulnerableActive, dps]);

  const color = RARITIES[item.rarity] || "#9b9b93";

  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-2 rf-card"
      style={{
        background: "#1c1512",
        border: compareSelected ? "1px solid #5b8bf0" : "1px solid var(--rf-border)",
        borderLeft: `3px solid ${color}`,
        borderLeftWidth: "3px",
        borderLeftColor: color,
        boxShadow: compareSelected ? "0 0 0 1px #5b8bf055" : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--rf-text)" }}>{item.name}</div>
          <div className="text-xs rf-mono" style={{ color }}>{item.rarity} · {item.slot}</div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={() => onEdit(item)} className="p-1 rounded hover:opacity-80" style={{ color: "var(--rf-muted)" }}><Pencil size={13} /></button>
          <button onClick={() => onDelete(item.id)} className="p-1 rounded hover:opacity-80" style={{ color: "var(--rf-bad)" }}><Trash2 size={13} /></button>
        </div>
      </div>

      <ul className="text-xs space-y-0.5" style={{ color: "var(--rf-muted)" }}>
        {item.affixes.map((a) => (
          <li key={a.id} className="rf-mono">
            {a.value > 0 ? "+" : ""}{a.value}{AFFIX_CATEGORIES.find((c) => c.key === a.category)?.suffix}{" "}
            {a.category === "multiplicative" ? `${a.bucket || "General"} (mult.)` : CATEGORY_LABEL[a.category]}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-2 mt-1">
        <button
          onClick={() => onToggle(item.id)}
          className="text-xs px-2.5 py-1 rounded font-semibold"
          style={equipped ? { background: "var(--rf-good)", color: "#0d1a0d" } : { border: "1px solid var(--rf-border)", color: "var(--rf-text)" }}
        >
          {equipped ? "Equipped" : "Equip"}
        </button>
        <DeltaBadge delta={preview.delta} percent={preview.percent} equipped={equipped} />
      </div>

      <label className="flex items-center gap-1.5 text-xs pt-1 cursor-pointer select-none" style={{ borderTop: "1px solid var(--rf-border)", color: compareSelected ? "#5b8bf0" : "var(--rf-muted)" }}>
        <input type="checkbox" checked={compareSelected} onChange={() => onToggleCompare(item.id)} className="accent-current" />
        Compare
      </label>
    </div>
  );
}

/* ---------------------------------- compare panel ---------------------------------- */

const COMPARE_ROW_ORDER = ["weaponMin", "weaponMax", "baseAPS", "attackSpeed", "critChance", "critDamage", "vulnerableDamage", "additive"];

function ComparePanel({ itemA, itemB, base, items, equippedIds, vulnerableActive, currentDps, onClear, onRemove }) {
  const summaryA = useMemo(() => summarizeAffixes(itemA), [itemA]);
  const summaryB = useMemo(() => summarizeAffixes(itemB), [itemB]);

  const allKeys = useMemo(() => {
    const keys = new Set([...Object.keys(summaryA), ...Object.keys(summaryB)]);
    const ordered = COMPARE_ROW_ORDER.filter((k) => keys.has(k));
    const rest = [...keys].filter((k) => !COMPARE_ROW_ORDER.includes(k)).sort();
    return [...ordered, ...rest];
  }, [summaryA, summaryB]);

  const resultA = useMemo(() => simulateEquip(itemA, base, items, equippedIds, vulnerableActive), [itemA, base, items, equippedIds, vulnerableActive]);
  const resultB = useMemo(() => simulateEquip(itemB, base, items, equippedIds, vulnerableActive), [itemB, base, items, equippedIds, vulnerableActive]);

  const deltaA = resultA.dps - currentDps;
  const deltaB = resultB.dps - currentDps;
  const pctA = currentDps > 0 ? (deltaA / currentDps) * 100 : 0;
  const pctB = currentDps > 0 ? (deltaB / currentDps) * 100 : 0;
  const winner = resultA.dps === resultB.dps ? null : resultA.dps > resultB.dps ? "A" : "B";

  const equippedA = equippedIds.includes(itemA.id);
  const equippedB = equippedIds.includes(itemB.id);
  const sameSlot = itemA.slot === itemB.slot;

  const colorA = RARITIES[itemA.rarity] || "#9b9b93";
  const colorB = RARITIES[itemB.rarity] || "#9b9b93";

  return (
    <div className="rounded-lg p-4 mb-4" style={{ background: "#1c1512", border: "1px solid #5b8bf0" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "#5b8bf0" }}>Comparing</h3>
        <button onClick={onClear} className="text-xs px-2 py-1 rounded flex items-center gap-1" style={{ color: "var(--rf-muted)", border: "1px solid var(--rf-border)" }}>
          <X size={12} /> Clear
        </button>
      </div>

      {!sameSlot && (
        <p className="text-xs mb-3" style={{ color: "var(--rf-muted)" }}>
          These are different slots, so they're not mutually exclusive — this shows each one's individual
          contribution to your current build rather than a straight either/or choice.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        {[{ item: itemA, color: colorA, key: "A", equipped: equippedA }, { item: itemB, color: colorB, key: "B", equipped: equippedB }].map(({ item, color, key, equipped }) => (
          <div key={item.id} className="rounded p-2" style={{ border: `1px solid ${color}55`, borderLeft: `3px solid ${color}` }}>
            <div className="flex items-start justify-between gap-1">
              <div>
                <div className="text-sm font-semibold" style={{ color: "var(--rf-text)" }}>{item.name}</div>
                <div className="text-xs rf-mono" style={{ color }}>
                  {item.rarity} · {item.slot} {equipped && <span style={{ color: "var(--rf-good)" }}>· equipped</span>}
                </div>
              </div>
              <button onClick={() => onRemove(item.id)} className="shrink-0 p-0.5" title={`Remove ${key} from comparison`}>
                <X size={12} style={{ color: "var(--rf-muted)" }} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded overflow-hidden mb-3" style={{ border: "1px solid var(--rf-border)" }}>
        {allKeys.map((key, idx) => {
          const valA = summaryA[key] || 0;
          const valB = summaryB[key] || 0;
          const cat = AFFIX_CATEGORIES.find((c) => c.key === key);
          const suffix = cat?.suffix ?? (key.startsWith("mult:") ? "%" : "");
          return (
            <div
              key={key}
              className="grid grid-cols-3 text-xs px-3 py-1.5 rf-mono"
              style={{ background: idx % 2 ? "#1c1512" : "#150f0c", borderTop: idx ? "1px solid var(--rf-border)" : undefined }}
            >
              <span style={{ color: "var(--rf-muted)" }} className="truncate">{keyLabel(key)}</span>
              <span className="text-right" style={{ color: valA > valB ? "var(--rf-good)" : valA > 0 ? "var(--rf-text)" : "var(--rf-muted)" }}>
                {valA ? `${valA}${suffix}` : "—"}
              </span>
              <span className="text-right" style={{ color: valB > valA ? "var(--rf-good)" : valB > 0 ? "var(--rf-text)" : "var(--rf-muted)" }}>
                {valB ? `${valB}${suffix}` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "A", result: resultA, delta: deltaA, pct: pctA, win: winner === "A", equipped: equippedA },
          { label: "B", result: resultB, delta: deltaB, pct: pctB, win: winner === "B", equipped: equippedB },
        ].map(({ label, result, delta, pct, win, equipped }) => (
          <div key={label} className="rounded p-2 text-center" style={{ border: win ? "1px solid var(--rf-good)" : "1px solid var(--rf-border)", background: win ? "#6fae5c14" : "transparent" }}>
            <div className="text-xs" style={{ color: "var(--rf-muted)" }}>{equipped ? `Without ${label}` : `With ${label}`}</div>
            <div className="rf-mono text-lg font-bold" style={{ color: "var(--rf-text)" }}>{fmt(result.dps, 0)}</div>
            <div className="rf-mono text-xs" style={{ color: delta >= 0 ? "var(--rf-good)" : "var(--rf-bad)" }}>
              {delta >= 0 ? "+" : ""}{fmt(pct, 1)}%
            </div>
            {win && <div className="text-xs font-semibold mt-1" style={{ color: "var(--rf-good)" }}>Higher DPS</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- character silhouette ---------------------------------- */

const SILHOUETTE_SLOTS = [
  { slot: "Helm", x: 120, y: 40, r: 16 },
  { slot: "Amulet", x: 120, y: 90, r: 13 },
  { slot: "Chest", x: 120, y: 148, r: 17 },
  { slot: "Weapon", x: 194, y: 214, r: 15 },
  { slot: "Offhand", x: 46, y: 214, r: 15 },
  { slot: "Gloves", x: 153, y: 178, r: 13 },
  { slot: "Ring", x: 87, y: 178, r: 13 },
  { slot: "Pants", x: 120, y: 262, r: 16 },
  { slot: "Boots", x: 120, y: 400, r: 15 },
];

const SLOT_ABBR = {
  Helm: "He", Amulet: "Am", Chest: "Ch", Weapon: "Wp", Offhand: "Of",
  Gloves: "Gl", Ring: "Ri", Pants: "Pa", Boots: "Bo",
};

function SilhouetteMarker({ slot, x, y, r, items, equippedIds, onClick }) {
  const equippedItems = items.filter((i) => i.slot === slot && equippedIds.includes(i.id));
  const capacity = CAPACITY[slot] ?? 1;
  const filled = equippedItems.length > 0;
  const color = filled ? (RARITIES[equippedItems[0].rarity] || "#9b9b93") : "#4a3d33";
  const label = filled
    ? equippedItems.map((i) => i.name).join(", ") + (capacity > 1 ? ` (${equippedItems.length}/${capacity})` : "")
    : `${slot} — empty, click to add`;

  return (
    <g
      onClick={() => onClick(slot)}
      style={{ cursor: "pointer" }}
      className="rf-slot-marker"
    >
      <title>{label}</title>
      <circle
        cx={x} cy={y} r={r}
        fill={filled ? `${color}26` : "#1c1512"}
        stroke={color}
        strokeWidth={filled ? 2 : 1.5}
        strokeDasharray={filled ? "0" : "3 3"}
      />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={filled ? color : "#6b5d51"}>
        {SLOT_ABBR[slot]}
      </text>
      {capacity > 1 && (
        <text x={x} y={y + r + 12} textAnchor="middle" fontSize="8" fill="#6b5d51">
          {equippedItems.length}/{capacity}
        </text>
      )}
    </g>
  );
}

function CharacterSilhouette({ items, equippedIds, onSlotClick }) {
  return (
    <div className="rounded-xl p-4" style={{ background: "var(--rf-panel)", border: "1px solid var(--rf-border)" }}>
      <h2 className="text-sm font-semibold uppercase tracking-wide mb-3 flex items-center gap-1.5" style={{ color: "var(--rf-ember)" }}>
        <User size={14} /> Equipment
      </h2>
      <svg viewBox="0 0 240 430" className="w-full h-auto max-w-[220px] mx-auto">
        {/* simplified humanoid silhouette */}
        <ellipse cx="120" cy="50" rx="22" ry="26" fill="#241b17" />
        <line x1="120" y1="85" x2="120" y2="190" stroke="#241b17" strokeWidth="76" strokeLinecap="round" />
        <line x1="88" y1="90" x2="50" y2="210" stroke="#241b17" strokeWidth="22" strokeLinecap="round" />
        <line x1="152" y1="90" x2="190" y2="210" stroke="#241b17" strokeWidth="22" strokeLinecap="round" />
        <line x1="106" y1="195" x2="97" y2="410" stroke="#241b17" strokeWidth="26" strokeLinecap="round" />
        <line x1="134" y1="195" x2="143" y2="410" stroke="#241b17" strokeWidth="26" strokeLinecap="round" />

        {SILHOUETTE_SLOTS.map((s) => (
          <SilhouetteMarker key={s.slot} {...s} items={items} equippedIds={equippedIds} onClick={onSlotClick} />
        ))}
      </svg>
      <button
        onClick={() => onSlotClick("Other")}
        className="w-full mt-2 text-xs px-2.5 py-1.5 rounded flex items-center justify-center gap-1.5"
        style={{ border: "1px solid var(--rf-border)", color: "var(--rf-muted)" }}
      >
        Other (paragon / standalone buffs)
        {items.filter((i) => i.slot === "Other" && equippedIds.includes(i.id)).length > 0 && (
          <span className="rf-mono" style={{ color: "var(--rf-good)" }}>
            {items.filter((i) => i.slot === "Other" && equippedIds.includes(i.id)).length} active
          </span>
        )}
      </button>
      <p className="text-xs mt-3 text-center" style={{ color: "var(--rf-muted)" }}>
        Click a slot to jump to it, or add gear if it's empty.
      </p>
    </div>
  );
}

/* ---------------------------------- tutorial mockups ---------------------------------- */
/* Original illustrative diagrams (not game screenshots) showing generically where each
   stat tends to live in an ARPG's UI, so the labels line up with the calculator's fields. */

function TooltipMockup() {
  return (
    <svg viewBox="0 0 420 260" className="w-full h-auto">
      <rect x="0" y="0" width="420" height="260" fill="#120d0b" />
      <rect x="20" y="10" width="230" height="210" rx="6" fill="#1c1512" stroke="#3a2a21" strokeWidth="1.5" />
      <rect x="20" y="10" width="4" height="210" fill="#e8792f" />
      <text x="38" y="36" fill="#e8792f" fontSize="13" fontWeight="700">Aspect-Etched Greatblade</text>
      <text x="38" y="54" fill="#8f7d6d" fontSize="10">Legendary Two-Handed Sword</text>
      <line x1="38" y1="66" x2="234" y2="66" stroke="#3a2a21" strokeWidth="1" />
      <text x="38" y="88" fill="#ece1d2" fontSize="13" fontWeight="700">158 - 210 Damage</text>
      <text x="38" y="108" fill="#ece1d2" fontSize="11">1.10 Attacks per Second</text>
      <text x="38" y="128" fill="#ece1d2" fontSize="11">+15.0% Critical Strike Damage</text>
      <line x1="38" y1="140" x2="234" y2="140" stroke="#3a2a21" strokeWidth="1" />
      <text x="38" y="160" fill="#c9a86a" fontSize="11">+28.0% Vulnerable Damage</text>
      <text x="38" y="178" fill="#c9a86a" fontSize="11">x13% All Damage Multiplier</text>
      <text x="38" y="196" fill="#8f7d6d" fontSize="10" fontStyle="italic">Item Power: 800</text>

      <rect x="34" y="76" width="140" height="16" rx="3" fill="none" stroke="#d97a2f" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="174" y1="84" x2="290" y2="84" stroke="#d97a2f" strokeWidth="1" />
      <circle cx="290" cy="84" r="2.5" fill="#d97a2f" />
      <text x="296" y="80" fill="#d97a2f" fontSize="11" fontWeight="700">Weapon Min</text>
      <text x="296" y="93" fill="#d97a2f" fontSize="11" fontWeight="700">/ Max Damage</text>

      <rect x="34" y="96" width="150" height="16" rx="3" fill="none" stroke="#6fae5c" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="184" y1="104" x2="290" y2="125" stroke="#6fae5c" strokeWidth="1" />
      <circle cx="290" cy="125" r="2.5" fill="#6fae5c" />
      <text x="296" y="122" fill="#6fae5c" fontSize="11" fontWeight="700">Base Attacks</text>
      <text x="296" y="135" fill="#6fae5c" fontSize="11" fontWeight="700">/ Sec</text>

      <rect x="34" y="150" width="150" height="16" rx="3" fill="none" stroke="#c94b3f" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="184" y1="158" x2="290" y2="165" stroke="#c94b3f" strokeWidth="1" />
      <circle cx="290" cy="165" r="2.5" fill="#c94b3f" />
      <text x="296" y="162" fill="#c94b3f" fontSize="11" fontWeight="700">Vulnerable Damage</text>

      <rect x="34" y="168" width="185" height="16" rx="3" fill="none" stroke="#5b8bf0" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="219" y1="176" x2="290" y2="205" stroke="#5b8bf0" strokeWidth="1" />
      <circle cx="290" cy="205" r="2.5" fill="#5b8bf0" />
      <text x="296" y="202" fill="#5b8bf0" fontSize="11" fontWeight="700">"x" + "Multiplier" =</text>
      <text x="296" y="215" fill="#5b8bf0" fontSize="11" fontWeight="700">named bucket</text>
    </svg>
  );
}

function SkillMockup() {
  return (
    <svg viewBox="0 0 420 180" className="w-full h-auto">
      <rect x="0" y="0" width="420" height="180" fill="#120d0b" />
      <rect x="20" y="10" width="230" height="140" rx="6" fill="#1c1512" stroke="#3a2a21" strokeWidth="1.5" />
      <circle cx="46" cy="36" r="16" fill="#2a201b" stroke="#d97a2f" strokeWidth="1.5" />
      <path d="M40,42 L46,26 L52,42 L46,36 Z" fill="#d97a2f" />
      <text x="70" y="34" fill="#ece1d2" fontSize="13" fontWeight="700">Lunging Strike</text>
      <text x="70" y="50" fill="#8f7d6d" fontSize="10">Basic Skill — Slash</text>
      <line x1="38" y1="66" x2="234" y2="66" stroke="#3a2a21" strokeWidth="1" />
      <text x="38" y="88" fill="#ece1d2" fontSize="11">Lunge at an enemy, dealing</text>
      <text x="38" y="104" fill="#ece1d2" fontSize="12" fontWeight="700">36% weapon damage</text>
      <text x="38" y="120" fill="#ece1d2" fontSize="11">as Physical.</text>
      <text x="38" y="142" fill="#8f7d6d" fontSize="10" fontStyle="italic">Generates 8 Fury</text>

      <rect x="34" y="92" width="150" height="18" rx="3" fill="none" stroke="#d97a2f" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="184" y1="101" x2="290" y2="101" stroke="#d97a2f" strokeWidth="1" />
      <circle cx="290" cy="101" r="2.5" fill="#d97a2f" />
      <text x="296" y="90" fill="#d97a2f" fontSize="12" fontWeight="700">This is your</text>
      <text x="296" y="106" fill="#d97a2f" fontSize="12" fontWeight="700">Skill Multiplier</text>
      <text x="296" y="122" fill="#8f7d6d" fontSize="10">(enter as 36)</text>
    </svg>
  );
}

function CharSheetMockup() {
  return (
    <svg viewBox="0 0 420 210" className="w-full h-auto">
      <rect x="0" y="0" width="420" height="210" fill="#120d0b" />
      <rect x="20" y="10" width="220" height="190" rx="6" fill="#1c1512" stroke="#3a2a21" strokeWidth="1.5" />
      <text x="38" y="34" fill="#e8792f" fontSize="12" fontWeight="700" letterSpacing="1">OFFENSIVE</text>
      <line x1="38" y1="42" x2="222" y2="42" stroke="#3a2a21" strokeWidth="1" />

      <text x="38" y="66" fill="#8f7d6d" fontSize="10">Critical Strike Chance</text>
      <text x="222" y="66" fill="#ece1d2" fontSize="11" textAnchor="end" fontWeight="700">5.0%</text>

      <text x="38" y="92" fill="#8f7d6d" fontSize="10">Critical Strike Damage</text>
      <text x="222" y="92" fill="#ece1d2" fontSize="11" textAnchor="end" fontWeight="700">+50.0%</text>

      <text x="38" y="118" fill="#8f7d6d" fontSize="10">Vulnerable Damage</text>
      <text x="222" y="118" fill="#ece1d2" fontSize="11" textAnchor="end" fontWeight="700">+20.0%</text>

      <text x="38" y="144" fill="#8f7d6d" fontSize="10">Attack Speed</text>
      <text x="222" y="144" fill="#ece1d2" fontSize="11" textAnchor="end" fontWeight="700">+15.0%</text>

      <text x="38" y="170" fill="#8f7d6d" fontSize="10">Total Armor</text>
      <text x="222" y="170" fill="#4a3d33" fontSize="11" textAnchor="end">1240</text>

      <rect x="34" y="53" width="192" height="18" rx="3" fill="none" stroke="#d97a2f" strokeWidth="1.5" strokeDasharray="4 3" />
      <rect x="34" y="79" width="192" height="18" rx="3" fill="none" stroke="#c9a86a" strokeWidth="1.5" strokeDasharray="4 3" />
      <rect x="34" y="105" width="192" height="18" rx="3" fill="none" stroke="#c94b3f" strokeWidth="1.5" strokeDasharray="4 3" />
      <rect x="34" y="131" width="192" height="18" rx="3" fill="none" stroke="#6fae5c" strokeWidth="1.5" strokeDasharray="4 3" />

      <line x1="226" y1="62" x2="270" y2="62" stroke="#d97a2f" strokeWidth="1" />
      <line x1="226" y1="88" x2="270" y2="88" stroke="#c9a86a" strokeWidth="1" />
      <line x1="226" y1="114" x2="270" y2="114" stroke="#c94b3f" strokeWidth="1" />
      <line x1="226" y1="140" x2="270" y2="140" stroke="#6fae5c" strokeWidth="1" />

      <text x="274" y="66" fill="#d97a2f" fontSize="11" fontWeight="700">Crit Chance</text>
      <text x="274" y="92" fill="#c9a86a" fontSize="11" fontWeight="700">Crit Damage</text>
      <text x="274" y="118" fill="#c94b3f" fontSize="11" fontWeight="700">Vulnerable Dmg</text>
      <text x="274" y="144" fill="#6fae5c" fontSize="11" fontWeight="700">Attack Speed</text>
    </svg>
  );
}

function AffixCompareMockup() {
  return (
    <svg viewBox="0 0 420 220" className="w-full h-auto">
      <rect x="0" y="0" width="420" height="220" fill="#120d0b" />
      <rect x="16" y="10" width="185" height="140" rx="6" fill="#1c1512" stroke="#6fae5c" strokeWidth="1.5" />
      <text x="30" y="32" fill="#6fae5c" fontSize="12" fontWeight="700">"+" prefix</text>
      <text x="30" y="56" fill="#ece1d2" fontSize="10.5">+15% Skill Damage</text>
      <text x="30" y="76" fill="#ece1d2" fontSize="10.5">+12% Damage to Close</text>
      <text x="30" y="92" fill="#ece1d2" fontSize="10.5">   Enemies</text>
      <text x="30" y="112" fill="#ece1d2" fontSize="10.5">+9% Overpower Damage</text>
      <line x1="30" y1="124" x2="187" y2="124" stroke="#3a2a21" strokeWidth="1" />
      <text x="30" y="138" fill="#6fae5c" fontSize="10" fontWeight="700">All sum into ONE field:</text>
      <text x="30" y="152" fill="#6fae5c" fontSize="10" fontWeight="700">"Additive Damage"</text>

      <rect x="219" y="10" width="185" height="140" rx="6" fill="#1c1512" stroke="#5b8bf0" strokeWidth="1.5" />
      <text x="233" y="32" fill="#5b8bf0" fontSize="12" fontWeight="700">"x" + "Multiplier"</text>
      <text x="233" y="56" fill="#ece1d2" fontSize="10.5">x13% All Damage</text>
      <text x="233" y="72" fill="#ece1d2" fontSize="10.5">   Multiplier</text>
      <text x="233" y="94" fill="#ece1d2" fontSize="10.5">x41% Critical Strike</text>
      <text x="233" y="110" fill="#ece1d2" fontSize="10.5">   Damage Multiplier</text>
      <line x1="233" y1="124" x2="390" y2="124" stroke="#3a2a21" strokeWidth="1" />
      <text x="233" y="138" fill="#5b8bf0" fontSize="10" fontWeight="700">Each gets its OWN</text>
      <text x="233" y="152" fill="#5b8bf0" fontSize="10" fontWeight="700">named bucket</text>

      <text x="210" y="95" fill="#8f7d6d" fontSize="16" fontWeight="700" textAnchor="middle">vs</text>

      <text x="16" y="178" fill="#8f7d6d" fontSize="10.5">Rule of thumb: an "x" prefix plus the word "Multiplier" always</text>
      <text x="16" y="194" fill="#8f7d6d" fontSize="10.5">means its own bucket — that's how the game itself marks it.</text>
      <text x="16" y="210" fill="#8f7d6d" fontSize="10.5">A plain "+" percentage without "Multiplier" is additive instead.</text>
    </svg>
  );
}

function TutorialStep({ number, title, color, children, diagram }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center py-4" style={{ borderTop: "1px solid var(--rf-border)" }}>
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span
            className="rf-mono text-xs w-5 h-5 flex items-center justify-center rounded-full shrink-0 font-bold"
            style={{ background: color, color: "#120d0b" }}
          >
            {number}
          </span>
          <h3 className="text-sm font-semibold" style={{ color: "var(--rf-text)" }}>{title}</h3>
        </div>
        <div className="text-sm leading-relaxed" style={{ color: "var(--rf-muted)" }}>{children}</div>
      </div>
      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--rf-border)" }}>{diagram}</div>
    </div>
  );
}

function TutorialSection({ open, onToggle }) {
  return (
    <div className="rounded-xl mb-6" style={{ background: "var(--rf-panel)", border: "1px solid var(--rf-border)" }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 sm:px-5 sm:py-4"
      >
        <span className="flex items-center gap-2">
          <BookOpen size={16} style={{ color: "var(--rf-ember)" }} />
          <span className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--rf-ember)" }}>
            How to find your exact values
          </span>
        </span>
        {open ? <ChevronUp size={16} style={{ color: "var(--rf-muted)" }} /> : <ChevronDown size={16} style={{ color: "var(--rf-muted)" }} />}
      </button>

      {open && (
        <div className="px-4 pb-5 sm:px-5">
          <p className="text-sm mb-1" style={{ color: "var(--rf-muted)" }}>
            Every field in this calculator maps to something you can read straight off your character's UI.
            Here's where to look for each one. Layouts below are illustrative, not a screenshot of any specific
            game — your own tooltips will be laid out a little differently, but the numbers you need are always
            in the same neighborhood.
          </p>

          <TutorialStep number="1" title="Weapon damage & attack speed" color="#d97a2f" diagram={<TooltipMockup />}>
            Open your inventory and hover your equipped weapon. The range under the item name is your{" "}
            <b style={{ color: "var(--rf-text)" }}>Weapon Min / Max Damage</b>. Further down the tooltip,
            "Attacks per Second" is your <b style={{ color: "var(--rf-text)" }}>Base Attacks / Sec</b>.
          </TutorialStep>

          <TutorialStep number="2" title="Skill multiplier" color="#e8792f" diagram={<SkillMockup />}>
            Open your skill tree and hover the skill you use for damage. Look for a line like "Deals X% weapon
            damage" — that percentage is your <b style={{ color: "var(--rf-text)" }}>Skill Multiplier</b>. If a
            skill hits multiple times or has scaling stages, use the number for the hit you want to model.
          </TutorialStep>

          <TutorialStep number="3" title="Crit, Vulnerable & Attack Speed totals" color="#c94b3f" diagram={<CharSheetMockup />}>
            Open your character sheet and switch to the offensive stats tab. These are your{" "}
            <b style={{ color: "var(--rf-text)" }}>totals</b> across all gear and passives combined —
            read them directly into <b style={{ color: "var(--rf-text)" }}>Crit Chance</b>,{" "}
            <b style={{ color: "var(--rf-text)" }}>Crit Damage</b>,{" "}
            <b style={{ color: "var(--rf-text)" }}>Vulnerable Damage</b>, and the base{" "}
            <b style={{ color: "var(--rf-text)" }}>Attack Speed</b> fields instead of adding up individual items.
          </TutorialStep>

          <TutorialStep number="4" title="Additive vs. multiplicative lines" color="#5b8bf0" diagram={<AffixCompareMockup />}>
            This is the one that trips people up — but the game actually marks the difference for you.
            Look for an <b style={{ color: "var(--rf-text)" }}>"x" prefix and the word "Multiplier"</b>{" "}
            (e.g. "x13% All Damage Multiplier", "x41% Critical Strike Damage Multiplier") — that always means
            its own{" "}
            <b style={{ color: "var(--rf-text)" }}>Multiplicative Bucket</b>. Give matching buckets across
            different items the same short name so they combine correctly. A plain{" "}
            <b style={{ color: "var(--rf-text)" }}>"+" percentage</b> without "Multiplier" (skill damage, damage
            to close/distant, overpower, etc.) stacks into the single{" "}
            <b style={{ color: "var(--rf-text)" }}>Additive Damage</b> field instead. Full-sentence unique/Aspect
            effects that don't fit either pattern need your own judgment — treat them as their own named bucket.
          </TutorialStep>
        </div>
      )}
    </div>
  );
}


/* ---------------------------------- main app ---------------------------------- */

export default function App() {
  const [base, setBase] = useState(DEFAULT_BASE);
  const [items, setItems] = useState(DEFAULT_ITEMS);
  const [equippedIds, setEquippedIds] = useState(() => initialEquip(DEFAULT_ITEMS));
  const [vulnerableActive, setVulnerableActive] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => {
    try {
      const stored = window.localStorage.getItem("runeforge-tutorial-open");
      return stored === null ? true : stored === "true";
    } catch (e) {
      return true;
    }
  });

  const toggleTutorial = useCallback(() => {
    setTutorialOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("runeforge-tutorial-open", String(next));
      } catch (e) {
        // ignore
      }
      return next;
    });
  }, []);

  const fileInputRef = useRef(null);
  const slotRefs = useRef({});
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [ocrPreviewText, setOcrPreviewText] = useState(null);
  const [highlightSlot, setHighlightSlot] = useState(null);
  const [compareIds, setCompareIds] = useState([]);

  const toggleCompare = useCallback((itemId) => {
    setCompareIds((cur) => {
      if (cur.includes(itemId)) return cur.filter((id) => id !== itemId);
      if (cur.length >= 2) return [cur[1], itemId]; // FIFO: drop oldest, keep most recent pair
      return [...cur, itemId];
    });
  }, []);

  const removeFromCompare = useCallback((itemId) => {
    setCompareIds((cur) => cur.filter((id) => id !== itemId));
  }, []);

  const clearCompare = useCallback(() => setCompareIds([]), []);

  const handleScanClick = useCallback(() => {
    setScanError(null);
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setScanning(true);
    setScanError(null);
    try {
      const text = await runOcrOnImage(file);
      const draft = parseItemFromOcrText(text);
      setOcrPreviewText(text);
      setEditingItem(draft);
      setShowForm(true);
    } catch (err) {
      setScanError(err?.message || "Couldn't read that image. Try a clearer screenshot of one item's tooltip.");
    } finally {
      setScanning(false);
    }
  }, []);

  // load persisted state (plain browser localStorage - works on any self-hosted deployment)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("runeforge-state");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.base) setBase(parsed.base);
        if (parsed.items) setItems(parsed.items);
        if (parsed.equippedIds) setEquippedIds(parsed.equippedIds);
        if (typeof parsed.vulnerableActive === "boolean") setVulnerableActive(parsed.vulnerableActive);
      }
    } catch (e) {
      // no saved state yet, defaults stand
    } finally {
      setLoaded(true);
    }
  }, []);

  // persist on change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem("runeforge-state", JSON.stringify({ base, items, equippedIds, vulnerableActive }));
      } catch (e) {
        // storage unavailable or full - fail silently
      }
    }, 500);
    return () => clearTimeout(t);
  }, [base, items, equippedIds, vulnerableActive, loaded]);

  const { totals, buckets } = useMemo(() => computeTotals(base, items, equippedIds), [base, items, equippedIds]);
  const damage = useMemo(() => computeDamage(totals, buckets, vulnerableActive), [totals, buckets, vulnerableActive]);

  const handleToggle = useCallback((itemId) => setEquippedIds((eq) => toggleEquip(eq, items, itemId)), [items]);

  const handleSaveItem = (item) => {
    setItems((its) => {
      const exists = its.some((i) => i.id === item.id);
      return exists ? its.map((i) => (i.id === item.id ? item : i)) : [...its, item];
    });
    setShowForm(false);
    setEditingItem(null);
    setOcrPreviewText(null);
  };

  const handleDelete = (id) => {
    setItems((its) => its.filter((i) => i.id !== id));
    setEquippedIds((eq) => eq.filter((i) => i !== id));
    setCompareIds((cur) => cur.filter((i) => i !== id));
  };

  const doReset = () => {
    setBase(DEFAULT_BASE);
    setItems(DEFAULT_ITEMS);
    setEquippedIds(initialEquip(DEFAULT_ITEMS));
    setVulnerableActive(true);
    setResetConfirm(false);
  };

  const grouped = useMemo(() => {
    const g = {};
    SLOTS.forEach((s) => (g[s] = []));
    items.forEach((it) => g[it.slot]?.push(it));
    return g;
  }, [items]);

  const handleSlotClick = useCallback((slot) => {
    if (grouped[slot] && grouped[slot].length > 0) {
      const el = slotRefs.current[slot];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightSlot(slot);
        setTimeout(() => setHighlightSlot((cur) => (cur === slot ? null : cur)), 1600);
      }
    } else {
      setEditingItem({ slot });
      setOcrPreviewText(null);
      setShowForm(true);
    }
  }, [grouped]);

  return (
    <div className="rf-app min-h-full w-full" style={{ background: "var(--rf-bg)", color: "var(--rf-text)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
        .rf-app { --rf-bg:#120d0b; --rf-panel:#1c1512; --rf-border:#3a2a21; --rf-text:#ece1d2; --rf-muted:#8f7d6d;
                   --rf-blood:#9c1f1a; --rf-ember:#d97a2f; --rf-good:#6fae5c; --rf-bad:#c94b3f;
                   font-family:'Inter',sans-serif; }
        .rf-display { font-family:'Cinzel',serif; letter-spacing:0.03em; }
        .rf-mono { font-family:'JetBrains Mono',monospace; }
        .rf-card { transition: border-color .15s ease, transform .15s ease; }
        .rf-card:hover { transform: translateY(-1px); }
        .rf-slot-marker:hover circle { stroke-width: 2.5; }
        .rf-spin { animation: rfSpin 1s linear infinite; }
        @keyframes rfSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .rf-hero { position: relative; overflow: hidden; }
        .rf-hero::before {
          content: ""; position: absolute; inset: -40% -10% auto -10%; height: 160%;
          background: radial-gradient(circle, rgba(217,122,47,0.18), transparent 65%);
          pointer-events: none;
        }
        @media (prefers-reduced-motion: no-preference) {
          .rf-glow { animation: rfPulse 3.2s ease-in-out infinite; }
        }
        @keyframes rfPulse {
          0%, 100% { text-shadow: 0 0 18px rgba(217,122,47,0.35); }
          50% { text-shadow: 0 0 30px rgba(217,122,47,0.6); }
        }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { opacity: 0.4; }
      `}</style>

      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6">
        {/* header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Sword size={22} style={{ color: "var(--rf-ember)" }} />
            <h1 className="rf-display text-xl sm:text-2xl font-bold" style={{ color: "var(--rf-text)" }}>RUNEFORGE</h1>
            <span className="text-xs rf-mono hidden sm:inline" style={{ color: "var(--rf-muted)" }}>— Diablo IV damage calculator</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs px-3 py-1.5 rounded cursor-pointer" style={{ border: "1px solid var(--rf-border)" }}>
              <Skull size={13} style={{ color: vulnerableActive ? "var(--rf-bad)" : "var(--rf-muted)" }} />
              <span style={{ color: "var(--rf-muted)" }}>Target Vulnerable</span>
              <input type="checkbox" checked={vulnerableActive} onChange={(e) => setVulnerableActive(e.target.checked)} className="ml-1" />
            </label>
            {resetConfirm ? (
              <span className="flex items-center gap-1 text-xs">
                <span style={{ color: "var(--rf-muted)" }}>Reset all data?</span>
                <button onClick={doReset} className="px-2 py-1 rounded font-semibold" style={{ background: "var(--rf-bad)", color: "#fff" }}>Yes</button>
                <button onClick={() => setResetConfirm(false)} className="px-2 py-1 rounded" style={{ border: "1px solid var(--rf-border)" }}>No</button>
              </span>
            ) : (
              <button onClick={() => setResetConfirm(true)} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded" style={{ color: "var(--rf-muted)", border: "1px solid var(--rf-border)" }}>
                <RotateCcw size={13} /> Reset
              </button>
            )}
          </div>
        </div>

        <TutorialSection open={tutorialOpen} onToggle={toggleTutorial} />

        {/* hero */}
        <div className="rf-hero rounded-xl p-5 sm:p-6 mb-6" style={{ background: "linear-gradient(180deg,#1c1512,#150f0c)", border: "1px solid var(--rf-border)" }}>
          <div className="text-xs uppercase tracking-widest mb-1" style={{ color: "var(--rf-muted)" }}>Damage per second</div>
          <div className="rf-display rf-glow text-4xl sm:text-5xl font-bold mb-4" style={{ color: "var(--rf-ember)" }}>
            {loaded ? fmt(damage.dps, 0) : "…"}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 rf-mono text-sm">
            <span style={{ color: "var(--rf-muted)" }}>Avg Hit <b style={{ color: "var(--rf-text)" }}>{fmt(damage.hitDamage, 0)}</b></span>
            <span style={{ color: "var(--rf-muted)" }}>APS <b style={{ color: "var(--rf-text)" }}>{fmt(damage.totalAPS, 2)}</b></span>
            <span style={{ color: "var(--rf-muted)" }}>Crit <b style={{ color: "var(--rf-text)" }}>{fmt(damage.critChanceClamped, 1)}%</b> / <b style={{ color: "var(--rf-text)" }}>+{fmt(totals.critDamage, 0)}%</b></span>
            <span style={{ color: "var(--rf-muted)" }}>Vulnerable <b style={{ color: "var(--rf-text)" }}>+{fmt(totals.vulnerableDamage, 0)}%</b></span>
            <span style={{ color: "var(--rf-muted)" }}>Additive <b style={{ color: "var(--rf-text)" }}>+{fmt(totals.additive, 0)}%</b></span>
            {Object.entries(buckets).map(([k, v]) => (
              <span key={k} style={{ color: "var(--rf-muted)" }}>{k} <b style={{ color: "var(--rf-text)" }}>+{fmt(v, 0)}%</b></span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* base stats + silhouette */}
          <div className="flex flex-col gap-6">
          <CharacterSilhouette items={items} equippedIds={equippedIds} onSlotClick={handleSlotClick} />
          <div className="rounded-xl p-4" style={{ background: "var(--rf-panel)", border: "1px solid var(--rf-border)" }}>
            <h2 className="text-sm font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5" style={{ color: "var(--rf-ember)" }}>
              <Flame size={14} /> Character base
            </h2>
            <div className="divide-y" style={{ borderColor: "var(--rf-border)" }}>
              <StatInput label="Weapon Min Damage" value={base.weaponMin} onChange={(v) => setBase((b) => ({ ...b, weaponMin: v }))} />
              <StatInput label="Weapon Max Damage" value={base.weaponMax} onChange={(v) => setBase((b) => ({ ...b, weaponMax: v }))} />
              <StatInput label="Base Attacks / Sec" value={base.baseAPS} step={0.05} onChange={(v) => setBase((b) => ({ ...b, baseAPS: v }))} />
              <StatInput label="Skill Multiplier" value={base.skillMultiplier} suffix="%" onChange={(v) => setBase((b) => ({ ...b, skillMultiplier: v }))} />
              <StatInput label="Crit Chance" value={base.critChance} suffix="%" onChange={(v) => setBase((b) => ({ ...b, critChance: v }))} />
              <StatInput label="Crit Damage" value={base.critDamage} suffix="%" onChange={(v) => setBase((b) => ({ ...b, critDamage: v }))} />
              <StatInput label="Vulnerable Damage" value={base.vulnerableDamage} suffix="%" onChange={(v) => setBase((b) => ({ ...b, vulnerableDamage: v }))} />
              <StatInput label="Additive Damage" value={base.additive} suffix="%" onChange={(v) => setBase((b) => ({ ...b, additive: v }))} />
            </div>
            <p className="text-xs mt-3 leading-relaxed" style={{ color: "var(--rf-muted)" }}>
              Skill Multiplier is the skill's tooltip % of weapon damage. Attack Speed, Crit, Vulnerable and Additive
              are separate stacking pools; named multiplicative buckets on items (e.g. Berserking, Close, Distant)
              multiply independently. This is a simplified model and does not account for cast time, DoTs or cooldown bursts.
            </p>
          </div>
          </div>

          {/* items */}
          <div className="md:col-span-2 rounded-xl p-4" style={{ background: "var(--rf-panel)", border: "1px solid var(--rf-border)" }}>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--rf-ember)" }}>Item library</h2>
              {!showForm && (
                <div className="flex gap-2">
                  <button
                    onClick={handleScanClick}
                    disabled={scanning}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded font-semibold"
                    style={{ border: "1px solid var(--rf-border)", color: "var(--rf-text)", opacity: scanning ? 0.6 : 1 }}
                  >
                    {scanning ? <Loader2 size={13} className="rf-spin" /> : <ScanLine size={13} />}
                    {scanning ? "Reading..." : "Scan item"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileSelected}
                    className="hidden"
                  />
                  <button
                    onClick={() => { setEditingItem(null); setOcrPreviewText(null); setShowForm(true); }}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded font-semibold"
                    style={{ background: "var(--rf-blood)", color: "#fff" }}
                  >
                    <Plus size={13} /> New item
                  </button>
                </div>
              )}
            </div>

            {scanning && (
              <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded mb-3" style={{ background: "#1c1512", border: "1px solid var(--rf-border)", color: "var(--rf-muted)" }}>
                <Loader2 size={14} className="rf-spin" style={{ color: "var(--rf-ember)" }} />
                Reading item from image — this runs entirely in your browser, nothing is uploaded anywhere. Can take up to 30s on first use while it downloads the reader.
              </div>
            )}

            {scanError && (
              <div className="flex items-start justify-between gap-2 text-xs px-3 py-2.5 rounded mb-3" style={{ background: "#2a1512", border: "1px solid var(--rf-bad)", color: "var(--rf-text)" }}>
                <span>{scanError}</span>
                <button onClick={() => setScanError(null)} className="shrink-0"><X size={13} style={{ color: "var(--rf-muted)" }} /></button>
              </div>
            )}

            {compareIds.length === 2 && (() => {
              const itemA = items.find((i) => i.id === compareIds[0]);
              const itemB = items.find((i) => i.id === compareIds[1]);
              if (!itemA || !itemB) return null;
              return (
                <ComparePanel
                  itemA={itemA}
                  itemB={itemB}
                  base={base}
                  items={items}
                  equippedIds={equippedIds}
                  vulnerableActive={vulnerableActive}
                  currentDps={damage.dps}
                  onClear={clearCompare}
                  onRemove={removeFromCompare}
                />
              );
            })()}

            {compareIds.length === 1 && (
              <div className="flex items-center justify-between text-xs px-3 py-2 rounded mb-3" style={{ background: "#1c1512", border: "1px solid var(--rf-border)", color: "var(--rf-muted)" }}>
                <span>1 item selected — pick one more to compare.</span>
                <button onClick={clearCompare} className="flex items-center gap-1"><X size={12} /> Clear</button>
              </div>
            )}

            {showForm && ocrPreviewText && (
              <details className="text-xs mb-3 rounded px-3 py-2" style={{ background: "#1c1512", border: "1px solid var(--rf-border)", color: "var(--rf-muted)" }}>
                <summary className="cursor-pointer select-none" style={{ color: "var(--rf-ember)" }}>
                  Raw scanned text (check this against the fields below — OCR isn't perfect)
                </summary>
                <pre className="rf-mono whitespace-pre-wrap mt-2" style={{ color: "var(--rf-muted)" }}>{ocrPreviewText}</pre>
              </details>
            )}

            {showForm && (
              <ItemForm
                initial={editingItem}
                onCancel={() => { setShowForm(false); setEditingItem(null); setOcrPreviewText(null); }}
                onSave={handleSaveItem}
              />
            )}

            <div className="space-y-5 max-h-[600px] overflow-y-auto pr-1">
              {SLOTS.filter((s) => grouped[s].length).map((slot) => (
                <div
                  key={slot}
                  ref={(el) => { slotRefs.current[slot] = el; }}
                  className="rf-slot-section rounded-lg transition-shadow"
                  style={highlightSlot === slot ? { boxShadow: "0 0 0 2px var(--rf-ember)", background: "#1c1512" } : undefined}
                >
                  <div className="text-xs uppercase tracking-widest mb-2 rf-mono" style={{ color: "var(--rf-muted)" }}>
                    {slot} {CAPACITY[slot] !== Infinity && CAPACITY[slot] > 1 ? `(equip up to ${CAPACITY[slot]})` : ""}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {grouped[slot].map((item) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        equipped={equippedIds.includes(item.id)}
                        dps={damage.dps}
                        base={base}
                        items={items}
                        equippedIds={equippedIds}
                        vulnerableActive={vulnerableActive}
                        onToggle={handleToggle}
                        onEdit={(it) => { setEditingItem(it); setOcrPreviewText(null); setShowForm(true); }}
                        onDelete={handleDelete}
                        compareSelected={compareIds.includes(item.id)}
                        onToggleCompare={toggleCompare}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {!items.length && (
                <div className="text-sm text-center py-10" style={{ color: "var(--rf-muted)" }}>No items yet. Add your first item to start comparing gear.</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 justify-center mt-6 text-xs" style={{ color: "var(--rf-muted)" }}>
          <Save size={12} /> Your build saves automatically in this browser.
        </div>
      </div>
    </div>
  );
}
