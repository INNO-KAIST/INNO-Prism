import json,os,sys,importlib,h5py,numpy as np
ROOT=os.path.expanduser('~/mnt/06. Optics')
K={k['id']:k for k in json.load(open('blind_key.json'))}; L=json.load(open('blind_labels.json'))
def load(rel):
    g=h5py.File(os.path.join(ROOT,rel),'r')['measurement/power_scan']
    if 'apd_counter_powers' in g:
        P=g['apd_counter_powers'][:]; I=g['apd_counter_apd_count_rates'][:]; t=g['apd_counter_acq_times'][:]
        se=np.sqrt(np.maximum(I*t,1))/np.maximum(t,1e-9); im=int(np.argmax(P)); return P[:im+1],dict(I=I[:im+1],se=se[:im+1])
    P=g['powers'][:]; R=g['detector_reps'][:]; im=int(np.argmax(P)); return P[:im+1],dict(reps=R[:im+1])
for modname in sys.argv[1:]:
    m=importlib.import_module(modname); rat=[]; cls=[]; th=[]
    for cid,d in sorted(L.items()):
        P,dd=load(K[cid]['rel']); o=m.analyze(P,**dd); rg=o['regimes']
        cls.append((d['pa'], rg[0]['pa_head'] if rg else None))
        if d['pa']!='no' and rg and d['regA']:
            q=min(rg,key=lambda q:abs(0.5*(q['bracket'][0]+q['bracket'][1])-d['regA']['x0']))
            rat.append(q['pa_head']/d['regA']['slope'])
            f=min(rg,key=lambda q:q['bracket'][0]); th.append(f['bracket'][1]-d['ith'])
    rat=np.array(rat); th=np.array(th)
    print(modname,'PA ratio median %.2f within25 %.2f within50 %.2f | Ith |d| median %.4f <=0.05 %.2f'%(np.median(rat),np.mean(abs(rat-1)<=.25),np.mean(abs(rat-1)<=.5),np.median(abs(th)),np.mean(abs(th)<=.05)))
    for T in (5,6,7,8):
        yes=[h for p,h in cls if p=='yes']; un=[h for p,h in cls if p=='unsure']; no=[h for p,h in cls if p=='no']
        print('   T=%d: yes→PA %d/%d, unsure→S-bend/none %d/%d, no→none %d/%d'%(T,sum(1 for h in yes if h and h>=T),len(yes),sum(1 for h in un if (h is None or h<T)),len(un),sum(1 for h in no if h is None),len(no)))
