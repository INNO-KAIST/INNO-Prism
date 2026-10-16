# model-free ignition extractor (independent reference): dark = median of the lowest-power 25% of points,
# sigma = 1.4826*MAD there; ignition = first point exceeding D+5 sigma that stays above for the next 2 points
import json,os,csv,h5py,numpy as np
ROOT=os.path.expanduser('~/mnt/06. Optics')
rows=list(csv.DictReader(open(os.path.expanduser('~/mnt/INNO Prism/docs/prism_upbranch_288_after_v3.8.csv'),encoding='utf-8-sig')))
out={}
for r in rows:
    g=h5py.File(os.path.join(ROOT,r['rel']),'r')['measurement/power_scan']
    if 'apd_counter_powers' in g: P=g['apd_counter_powers'][:]; I=g['apd_counter_apd_count_rates'][:]
    else: P=g['powers'][:]; I=g['detector'][:]
    im=int(np.nanargmax(P)); res={}
    for br,sl in (('up',slice(0,im+1)),('down',slice(im+1,None))):
        p=P[sl]; i=I[sl]; o=np.argsort(p); p=p[o]; i=i[o]
        if len(p)<10: continue
        q=max(5,len(p)//4); D=np.median(i[:q]); s=1.4826*np.median(abs(i[:q]-D))+1e-9
        k=None
        for j in range(q,len(p)-2):
            if i[j]>D+5*s and i[j+1]>D+5*s and i[j+2]>D+5*s: k=j; break
        res[br]=None if k is None else [float(np.log10(p[k-1])),float(np.log10(p[k]))]
    out[r['rel']]=res
json.dump(out,open('free_288.json','w')); print(len(out))
