import json,os,sys,h5py,numpy as np,matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
sys.path.insert(0,'.'); from segpa import analyze
ROOT=os.path.expanduser('~/mnt/06. Optics')
R=[r for r in json.load(open('manual_cmp.json')) if r['src']!='jump']
def load(rel):
    g=h5py.File(os.path.join(ROOT,rel),'r')['measurement/power_scan']
    if 'apd_counter_powers' in g:
        P=g['apd_counter_powers'][:]; I=g['apd_counter_apd_count_rates'][:]; t=g['apd_counter_acq_times'][:]
        se=np.sqrt(np.maximum(I*t,1))/np.maximum(t,1e-9); im=int(np.argmax(P)); return P[:im+1],dict(I=I[:im+1],se=se[:im+1]),I[:im+1]
    P=g['powers'][:]; Rr=g['detector_reps'][:]; im=int(np.argmax(P)); return P[:im+1],dict(reps=Rr[:im+1]),Rr[:im+1].mean(1)
fig,axs=plt.subplots(3,5,figsize=(22,11))
for ax,r in zip(axs.flat,R):
    P,d,I=load(r['rel']); o=analyze(P,**d); x=np.log10(P); y=np.log10(np.maximum(I,1))
    ax.plot(x,y,'.',ms=3,color='k')
    for q in o['regimes']:
        ax.axvspan(q['bracket'][0],q['bracket'][1],color='tab:red',alpha=0.4); ax.axvspan(q['x0'],q['x1'],color='tab:red',alpha=0.08)
    ax.axvline(np.log10(r['ith_man']),color='tab:orange',lw=2,label='manual Ith')
    ax.axvline(np.log10(r['ith_pr']),color='tab:blue',ls='--',lw=1)
    xm=np.log10(r['ith_man']); ym=np.interp(xm,x,y)
    ax.plot([xm,xm+0.08],[ym,ym+0.08*r['pa_man']],color='tab:orange',lw=1.5)   # manual slope from manual Ith
    lo=max(xm-0.3,x.min()); hi=min(xm+0.5,x.max()); ax.set_xlim(lo,hi)
    ax.set_title(f"{r['rel'].split('WJ-')[1][:26]}\nmanual PA {r['pa_man']:.1f} | Prism {r['pa_pr']:.1f} ({r['src']}) | SegPA {r['pa_seg']} {r['seg_status'][:5]}",fontsize=8)
fig.tight_layout(); fig.savefig('manual_cmp.png',dpi=80); print('ok')
