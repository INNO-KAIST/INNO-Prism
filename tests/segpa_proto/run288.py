import csv,os,sys,time,json,h5py,numpy as np
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from segpa import analyze
ROOT=os.path.expanduser('~/mnt/06. Optics')
rows=list(csv.DictReader(open(os.path.expanduser('~/mnt/INNO Prism/docs/prism_upbranch_288_after_v3.8.csv'),encoding='utf-8-sig')))
a,b=int(sys.argv[1]),int(sys.argv[2]); out=sys.argv[3]
def load(path):
    f=h5py.File(path,'r'); g=f['measurement/power_scan']
    if 'apd_counter_powers' in g:
        P=g['apd_counter_powers'][:]; rate=g['apd_counter_apd_count_rates'][:]; t=g['apd_counter_acq_times'][:]
        N=np.maximum(rate*t,0); se=np.sqrt(np.maximum(N,1))/np.maximum(t,1e-9)
        return P,dict(I=rate,se=se),'APD'
    P=g['powers'][:]; R=g['detector_reps'][:]
    return P,dict(reps=R),'reps'
res=[]
for r in rows[a:b]:
    t0=time.time()
    try:
        P,d,kind=load(os.path.join(ROOT,r['rel']))
        im=int(np.nanargmax(P))
        for br,sl in (('up',slice(0,im+1)),('down',slice(im+1,None))):
            Pb=P[sl]
            if len(Pb)<10: continue
            db={k:(v[sl] if hasattr(v,'__len__') else v) for k,v in d.items()}
            o=analyze(Pb,**db)
            rg=o['regimes']
            rec=dict(rel=r['rel'],branch=br,kind=kind,n=len(Pb),K=o['K'],tau=round(o['tau'],4),nspikes=len(o['spikes']),
                     dark=None if o['dark'] is None else round(o['dark']['D'],2),nreg=len(rg),
                     regimes=[dict(scale=int(q.get('scale',0)),x0=round(float(q['x0']),5),x1=round(float(q['x1']),5),head=round(q['pa_head'],3),peak=round(q['peak'],3),lo=round(q['pa_lo'],3),darksub=None if not np.isfinite(q['pa_darksub']) else round(q['pa_darksub'],3),
                                   kind=q['kind'],npts=q['npts'],x_th=None if not np.isfinite(q['x_th']) else round(q['x_th'],5),
                                   br0=round(q['bracket'][0],5),br1=round(q['bracket'][1],5),rise=round(q['rise'],3),prom=round(q['prom'],3),status=q['status'],near_dark=bool(q['near_dark']))
                              for q in rg],ms=int(1000*(time.time()-t0)))
            res.append(rec)
    except Exception as e:
        res.append(dict(rel=r['rel'],err=repr(e)))
with open(out,'w') as fo: json.dump(res,fo)
print('done',a,b,len(res))
