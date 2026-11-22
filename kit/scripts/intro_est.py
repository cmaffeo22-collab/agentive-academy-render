"""Estimate an intro's rendered length in seconds from its script (fitted on 139 rendered intros, sd 1.5 s; dotted acronyms add time).
Usage: python3 intro_est.py <intro.json>...   prints 'est_seconds path'; exit 1 if any estimate is over LIMIT (default 31.5)."""
import json,re,sys,os
LIMIT=float(os.environ.get('LIMIT','31.5'))
def est(d):
    says=[d['title'].get('say','')]+[x.get('say','') for x in d.get('cards',[])]+[(d.get('cta') or {}).get('say','')]
    t=' '.join(s for s in says if s); w=len(t.split())
    dots=sum(len(m.replace('.',''))-1 for m in re.findall(r'\b(?:[A-Za-z]\.){2,}',t))
    return 0.263*w+0.357*dots+1.123*len([s for s in says if s])+2.719
bad=0
for p in sys.argv[1:]:
    e=est(json.load(open(p))); print(f"{e:.1f} {p}"); bad|=e>LIMIT
sys.exit(1 if bad else 0)
