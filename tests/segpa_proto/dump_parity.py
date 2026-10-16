# Dump per-branch inputs + Python SegPA outputs for the JS parity test (tests/test_segpa_parity.mjs)
import json,os,csv,sys,h5py,numpy as np,segpa
ROOT=os.path.expanduser('~/mnt/06. Optics')
rows=[r['rel'] for r in csv.DictReader(open(os.path.expanduser('~/mnt/INNO Prism/docs/prism_upbranch_288_after_v3.8.csv'),encoding='utf-8-sig'))]
a,b=int(sys.argv[1]),int(sys.argv[2]); out=[]
for rel in rows[a:b]:
    g=h5py.File(os.path.join(ROOT,rel),'r')['measurement/power_scan']
    if 'apd_counter_powers' in g:
        P=g['apd_counter_powers'][:]; I=g['apd_counter_apd_count_rates'][:]; t=g['apd_counter_acq_times'][:]
        se=np.sqrt(np.maximum(I*t,1))/np.maximum(t,1e-9); d=dict(I=I,se=se)
    else:
        P=g['powers'][:]; d=dict(reps=g['detector_reps'][:])
    im=int(np.nanargmax(P))
    for br,sl in (('up',slice(0,im+1)),('down',slice(im+1,None))):
        if len(P[sl])<10: continue
        db={k:v[sl] for k,v in d.items()}
        try: o=segpa.analyze(P[sl],**db); err=None
        except Exception as e: o=None; err=str(e)
        inp={'P':P[sl].tolist()}; inp.update({k:v.tolist() for k,v in db.items()})
        res=None if o is None else [dict(head=q['pa_head'],headLo=q['pa_lo'],br0=float(q['bracket'][0]),br1=float(q['bracket'][1]),
              cls=q['cls'],status=q['status'],kind=q['kind'],main=None if q['main'] is None else q['main']['slope']) for q in o['regimes']]
        out.append(dict(rel=rel,branch=br,input=inp,py=res,err=err,Kbic=None if o is None else o['Kbic']))
json.dump(out,open(f'parity_{a}.json','w'))
print(a,b,len(out))
