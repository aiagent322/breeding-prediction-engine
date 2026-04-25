#!/usr/bin/env python3
"""
generate_stallion_page.py
Pulls a stallion from Supabase, renders a full SEO HTML page,
and pushes it to GitHub at public/stallions/{slug}.html

Set environment variables before running:
    export SUPABASE_URL="..."
    export SUPABASE_KEY="..."
    export GITHUB_TOKEN="..."
    export GITHUB_REPO="aiagent322/breeding-prediction-engine"
    export SITE_URL="https://breeding-prediction-engine.pages.dev"

Usage:
    python generate_stallion_page.py bvss014
    python generate_stallion_page.py "Badboonarising"
"""

import sys, os, re, json, base64, urllib.request, urllib.error, urllib.parse, time
from datetime import datetime

SUPABASE_URL = os.environ.get("SUPABASE_URL","")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY","")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN","")
GITHUB_REPO  = os.environ.get("GITHUB_REPO","aiagent322/breeding-prediction-engine")
SITE_URL     = os.environ.get("SITE_URL","https://breeding-prediction-engine.pages.dev")

DISC_MAP = {
    "disc_strength_cutting":      "Cutting (NCHA)",
    "disc_strength_cowhorse":     "Cow Horse (NRCHA)",
    "disc_strength_reining":      "Reining (NRHA)",
    "disc_strength_teamroping":   "Team Roping",
    "disc_strength_barrelracing": "Barrel Racing",
    "disc_strength_ranchriding":  "Ranch Riding",
}
TRAIT_MAP = {
    "trait_athleticism":   "Athleticism",
    "trait_cow_sense":     "Cow Sense",
    "trait_speed":         "Speed",
    "trait_stamina":       "Stamina",
    "trait_temperament":   "Temperament",
    "mental_trainability": "Trainability",
    "mental_consistency":  "Consistency",
}

def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

def v(d, key):
    val = d.get(key)
    return None if val in (None, "", "None", "0", 0) else val

def fmt_money(val):
    try: return f"${float(val):,.0f}"
    except: return str(val)

def sb_get(query):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{query}",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def gh_get_sha(path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}",
        headers={"Authorization": f"token {GITHUB_TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get("sha")
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise

def gh_push_file(path, content, message):
    sha = gh_get_sha(path)
    payload = {"message": message, "content": base64.b64encode(content.encode("utf-8")).decode()}
    if sha: payload["sha"] = sha
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"token {GITHUB_TOKEN}", "Content-Type": "application/json"},
        method="PUT"
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["commit"]["sha"][:12]

def score_bar(label, score):
    pct = min(100, max(0, int(score)))
    color = "var(--gold)" if pct >= 75 else "var(--gold-d)" if pct >= 50 else "var(--dim)"
    return (f'<div class="sbar"><div class="sbar-hd"><span class="sbar-label">{label}</span>'
            f'<span class="sbar-num" style="color:{color}">{pct}</span></div>'
            f'<div class="sbar-track"><div class="sbar-fill" style="width:{pct}%;background:{color}"></div></div></div>')

def ped_row(label, value):
    return f'<div class="ped-row"><span class="ped-key">{label}</span><span class="ped-val">{value}</span></div>'

def earn_block(label, value):
    return f'<div class="earn-block"><div class="earn-label">{label}</div><div class="earn-val">{value}</div></div>'

def render(d):
    name    = d.get("name","Unknown Stallion")
    slug    = slugify(name)
    station = (d.get("station") or "").replace("Brazos Valley Stallion Station","Valley Equine").strip()
    sire    = v(d,"genetics_sire"); dam = v(d,"genetics_dam"); bc = v(d,"genetics_bloodline_cluster")
    height  = v(d,"physical_height_hands"); lte = v(d,"lifetime_earnings_usd"); pe = v(d,"offspring_earnings_total_usd")
    fee     = v(d,"market_stud_fee_usd"); summary = v(d,"performance_summary") or ""
    page_url = f"{SITE_URL}/stallions/{slug}.html"
    if sire and dam: ped_line = f"{sire} &times; {dam}"
    elif sire:       ped_line = f"By {sire}"
    elif dam:        ped_line = f"Out of {dam}"
    else:            ped_line = ""
    meta_desc = ((summary[:157].rstrip() + "...") if summary else f"{name} — western performance stallion. {ped_line}.").replace('"',"'")
    og_title  = f"{name} | Stallion Profile — Western Performance Breeding Engine"
    schema    = {"@context":"https://schema.org","@type":"Article","headline":f"{name} Stallion Profile",
                 "description":meta_desc,"url":page_url,"dateModified":datetime.now().strftime("%Y-%m-%d"),
                 "publisher":{"@type":"Organization","name":"Bridle & Bit — AI Division","url":SITE_URL}}
    disc_bars  = "".join(score_bar(label, v(d,k)) for k,label in DISC_MAP.items() if v(d,k))
    trait_bars = "".join(score_bar(label, v(d,k)) for k,label in TRAIT_MAP.items() if v(d,k))
    ped_rows   = "".join(filter(None,[ped_row("Sire",sire) if sire else "",ped_row("Dam",dam) if dam else "",
                                       ped_row("Bloodline",bc) if bc else "",ped_row("Height",f"{height}H") if height else ""]))
    earn_blks  = "".join(filter(None,[earn_block("Lifetime Earnings",fmt_money(lte)) if lte else "",
                                       earn_block("Offspring Earnings",fmt_money(pe)) if pe else "",
                                       earn_block("Stud Fee",fmt_money(fee)+" + chute fee") if fee else ""]))
    sum_html = ""
    if summary:
        sentences = [s.strip() for s in re.split(r'(?<=\.)\s+', summary) if s.strip()]
        paras, chunk = [], []
        for i,s in enumerate(sentences):
            chunk.append(s if s.endswith(".") else s+".")
            if len(chunk)==4 or i==len(sentences)-1: paras.append(" ".join(chunk)); chunk=[]
        sum_html = "\n".join(f"<p>{p}</p>" for p in paras)
    scores_sec = ""
    if disc_bars or trait_bars:
        dc = f'<div class="scores-col"><div class="scores-col-title">Discipline Ratings</div>{disc_bars}</div>' if disc_bars else ""
        tc = f'<div class="scores-col"><div class="scores-col-title">Traits &amp; Mentality</div>{trait_bars}</div>' if trait_bars else ""
        scores_sec = f'<section class="card" id="scores"><div class="card-eyebrow">Expert Analysis</div><h2 class="card-title">Performance Scores</h2><p class="scores-note">Scores derived from confirmed research only — documented show records, pedigree analysis, and verified offspring characteristics. Blank fields indicate data not yet confirmed.</p><div class="scores-grid">{dc}{tc}</div></section>'
    ped_sec   = f'<section class="card"><div class="card-eyebrow">Bloodlines</div><h2 class="card-title">Pedigree</h2><div class="ped-grid">{ped_rows}</div></section>' if ped_rows else ""
    earn_sec  = f'<section class="card"><div class="card-eyebrow">Arena &amp; Breeding</div><h2 class="card-title">Earnings &amp; Fee</h2><div class="earn-grid">{earn_blks}</div></section>' if earn_blks else ""
    sum_sec   = f'<section class="card"><div class="card-eyebrow">Research Notes</div><h2 class="card-title">Full Profile</h2><div class="summary-body">{sum_html}</div></section>' if sum_html else ""
    hero_meta = "".join(filter(None,[
        f'<div class="hm"><b>{station}</b></div>' if station else "",
        f'<div class="hm"><b>{fmt_money(fee)}</b> stud fee</div>' if fee else "",
        f'<div class="hm">LTE <b>{fmt_money(lte)}</b></div>' if lte else "",
        f'<div class="hm">PE <b>{fmt_money(pe)}</b></div>' if pe else "",
    ]))
    year = datetime.now().year
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{og_title}</title>
<meta name="description" content="{meta_desc}">
<meta property="og:title" content="{og_title}"><meta property="og:description" content="{meta_desc}">
<meta property="og:url" content="{page_url}"><meta property="og:type" content="article">
<link rel="canonical" href="{page_url}">
<script type="application/ld+json">{json.dumps(schema)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,600&family=IBM+Plex+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
:root{{--bg:#0d0a05;--card:#141008;--card2:#1a1209;--border:#271c0c;--gold:#c08830;--gold-l:#d4a040;--gold-d:#7a5520;--cream:#ddd0b8;--muted:#6a5830;--dim:#3a2e14;--font-serif:'Playfair Display',serif;--font-mono:'IBM Plex Mono',monospace}}
body{{background:var(--bg);color:var(--cream);font-family:var(--font-mono);min-height:100vh;line-height:1.65}}
a{{color:var(--gold);text-decoration:none}}a:hover{{color:var(--gold-l)}}
.wrap{{max-width:880px;margin:0 auto;padding:1.5rem 1rem 5rem}}
.nav{{display:flex;align-items:center;justify-content:space-between;padding:.7rem 0 1.2rem;border-bottom:1px solid var(--border);margin-bottom:1.8rem}}
.nav-brand{{color:var(--muted);font-size:.72rem;letter-spacing:.06em;text-transform:uppercase}}.nav-brand span{{color:var(--gold)}}
.nav-links{{display:flex;gap:1.4rem}}.nav-links a{{color:var(--muted);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase}}.nav-links a:hover{{color:var(--cream)}}
.hero{{margin-bottom:1.8rem}}
.hero-eyebrow{{font-size:.65rem;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem}}
.hero-name{{font-family:var(--font-serif);font-size:2.4rem;color:var(--gold);line-height:1.1;margin-bottom:.5rem}}
@media(max-width:560px){{.hero-name{{font-size:1.8rem}}}}
.hero-sub{{font-size:.8rem;color:var(--muted);letter-spacing:.03em;margin-bottom:.8rem;font-style:italic}}
.hero-meta{{display:flex;flex-wrap:wrap;gap:.4rem .8rem;font-size:.72rem;color:var(--muted)}}
.hm{{display:flex;align-items:center;gap:.25rem}}.hm+.hm::before{{content:'·';color:var(--dim);margin-right:.15rem}}.hm b{{color:var(--cream)}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:1.2rem 1.3rem;margin-bottom:1rem}}
.card-eyebrow{{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-d);margin-bottom:.3rem}}
.card-title{{font-family:var(--font-serif);font-size:1.1rem;color:var(--gold);margin-bottom:.9rem}}
.ped-grid{{display:flex;flex-direction:column;gap:.5rem}}
.ped-row{{display:flex;align-items:baseline;gap:.8rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}}.ped-row:last-child{{border-bottom:none;padding-bottom:0}}
.ped-key{{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);width:80px;flex-shrink:0}}
.ped-val{{font-size:.82rem;color:var(--cream);line-height:1.4}}
.earn-grid{{display:flex;flex-wrap:wrap;gap:.8rem}}
.earn-block{{background:var(--card2);border:1px solid var(--border);border-radius:4px;padding:.65rem .9rem;min-width:155px}}
.earn-label{{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:.3rem}}
.earn-val{{font-family:var(--font-serif);font-size:1.2rem;color:var(--gold)}}
.scores-note{{font-size:.7rem;color:var(--dim);margin-bottom:.9rem;line-height:1.5}}
.scores-grid{{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}}
@media(max-width:560px){{.scores-grid{{grid-template-columns:1fr}}}}
.scores-col-title{{font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:.65rem}}
.sbar{{margin-bottom:.55rem}}.sbar-hd{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.2rem}}
.sbar-label{{font-size:.72rem;color:var(--muted)}}.sbar-num{{font-size:.75rem;font-weight:500}}
.sbar-track{{height:3px;background:var(--dim);border-radius:2px}}.sbar-fill{{height:100%;border-radius:2px}}
.summary-body p{{font-size:.8rem;color:#b0a080;line-height:1.8;margin-bottom:.85rem}}.summary-body p:last-child{{margin-bottom:0}}
.cta-card{{background:linear-gradient(135deg,#181008,#1e1508);border:1px solid var(--gold-d);border-radius:6px;padding:1.3rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:1.2rem}}
.cta-text{{font-family:var(--font-serif);font-size:1rem;color:var(--cream)}}.cta-sub{{font-size:.7rem;color:var(--muted);margin-top:.25rem}}
.cta-btn{{background:var(--gold);color:#090704;font-family:var(--font-mono);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;padding:.65rem 1.5rem;border-radius:3px;white-space:nowrap;font-weight:500}}.cta-btn:hover{{background:var(--gold-l)}}
.foot{{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--border);font-size:.68rem;color:var(--dim);letter-spacing:.05em;display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem}}
</style>
</head>
<body><div class="wrap">
<nav class="nav">
  <div class="nav-brand">Bridle &amp; Bit &mdash; <span>AI Division</span></div>
  <div class="nav-links"><a href="/index.html">Breeding Engine</a><a href="/stallions/">Stallion Index</a></div>
</nav>
<div class="hero">
  <div class="hero-eyebrow">Stallion Profile</div>
  <h1 class="hero-name">{name}</h1>
  {f'<div class="hero-sub">{ped_line}</div>' if ped_line else ''}
  <div class="hero-meta">{hero_meta}</div>
</div>
{ped_sec}
{earn_sec}
{scores_sec}
{sum_sec}
<div class="cta-card">
  <div><div class="cta-text">Run {name} in the Breeding Engine</div><div class="cta-sub">Match against your mare &mdash; Gold / Silver / Bronze cross analysis</div></div>
  <a href="/index.html" class="cta-btn">Open Engine &rarr;</a>
</div>
<div class="foot"><span>&copy; {year} Bridle &amp; Bit Magazine &mdash; AI Division</span><span>Data: NCHA &middot; NRCHA &middot; AQHA QData &middot; EquiStat</span></div>
</div></body></html>""", slug

def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_stallion_page.py <id_or_name>"); sys.exit(1)
    arg = sys.argv[1]
    if re.match(r'^[a-z]+\d+$', arg):
        rows = sb_get(f"stallions?id=eq.{arg}&select=*")
    else:
        rows = sb_get(f"stallions?name=ilike.*{urllib.parse.quote(arg)}*&select=*&limit=1")
    if not rows: print(f"No stallion found: {arg}"); sys.exit(1)
    d = rows[0]
    print(f"Generating: {d['name']} ({d['id']})")
    html, slug = render(d)
    path = f"public/stallions/{slug}.html"
    commit_sha = gh_push_file(path, html, f"stallion page: {d['name']}")
    print(f"Pushed: {path} (commit {commit_sha})")
    print(f"URL: {SITE_URL}/stallions/{slug}.html")

if __name__ == "__main__":
    main()
