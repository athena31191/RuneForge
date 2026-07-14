import { useState, useEffect, useMemo, useCallback } from "react";
import { Sword, Plus, Trash2, Pencil, X, RotateCcw, Check, Skull, Flame, Save } from "lucide-react";

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

function ItemCard({ item, equipped, dps, base, items, equippedIds, vulnerableActive, onToggle, onEdit, onDelete }) {
  const preview = useMemo(() => {
    const hypoIds = toggleEquip(equippedIds, items, item.id);
    const { totals, buckets } = computeTotals(base, items, hypoIds);
    const { dps: hypoDps } = computeDamage(totals, buckets, vulnerableActive);
    const delta = hypoDps - dps;
    const percent = dps > 0 ? (delta / dps) * 100 : 0;
    return { delta, percent };
  }, [equippedIds, items, item.id, base, vulnerableActive, dps]);

  const color = RARITIES[item.rarity] || "#9b9b93";

  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-2 rf-card"
      style={{ background: "#1c1512", borderLeft: `3px solid ${color}`, border: "1px solid var(--rf-border)", borderLeftWidth: "3px", borderLeftColor: color }}
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
  };

  const handleDelete = (id) => {
    setItems((its) => its.filter((i) => i.id !== id));
    setEquippedIds((eq) => eq.filter((i) => i !== id));
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
          {/* base stats */}
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

          {/* items */}
          <div className="md:col-span-2 rounded-xl p-4" style={{ background: "var(--rf-panel)", border: "1px solid var(--rf-border)" }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--rf-ember)" }}>Item library</h2>
              {!showForm && (
                <button
                  onClick={() => { setEditingItem(null); setShowForm(true); }}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded font-semibold"
                  style={{ background: "var(--rf-blood)", color: "#fff" }}
                >
                  <Plus size={13} /> New item
                </button>
              )}
            </div>

            {showForm && (
              <ItemForm
                initial={editingItem}
                onCancel={() => { setShowForm(false); setEditingItem(null); }}
                onSave={handleSaveItem}
              />
            )}

            <div className="space-y-5 max-h-[600px] overflow-y-auto pr-1">
              {SLOTS.filter((s) => grouped[s].length).map((slot) => (
                <div key={slot}>
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
                        onEdit={(it) => { setEditingItem(it); setShowForm(true); }}
                        onDelete={handleDelete}
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
