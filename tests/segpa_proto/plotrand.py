import json,os,csv,random,sys,h5py,numpy as np,matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
sys.path.insert(0,'.'); from segpa import analyze
ROOT=os.path.expanduser('~/mnt/06. Optics')
C={r['rel']:r for r in csv.DictReader(open(os.path.expanduser('~/mnt/INNO Prism/docs/prism_upbranch_288_after_v3.8.csv'),encoding='utf-8-sig'))}
F=json.load(open('free_288.json'))
random.seed(7); sel=random.sample(list(C),30)
def load(rel):
    g=h5py.File(os.path.join(ROOT,rel),'r')['measurement/power_scan']
    if 'apd_counter_powers' in g:
        P=g['apd_counter_powers'][:]; I=g['apd_counter_apd_count_rates'][:]; t=g['apd_counter_acq_times'][:]
        se=np.sqrt(np.maximum(I*t,1))/np.maximum(t,1e-9); im=int(np.argmax(P)); return P[:im+1],dict(I=I[:im+1],se=se[:im+1]),I[:im+1]
    P=g['powers'][:]; R=g['detector_reps'][:]; im=int(np.argmax(P)); return P[:im+1],dict(reps=R[:im+1]),R[:im+1].mean(1)
for k in range(0,30,10):
    fig,axs=plt.subplots(2,5,figsize=(20,7.5))
    for ax,(n,rel) in zip(axs.flat,enumerate(sel[k:k+10],start=k)):
        P,d,I=load(rel); o=analyze(P,**d); x=np.log10(P)
        ax.plot(x,np.log10(np.maximum(I,1)),'.',ms=3,color='k')
        for q in o['regimes']:
            ax.axvspan(q['bracket'][0],q['bracket'][1],color='tab:red',alpha=0.4)
            ax.axvspan(q['x0'],q['x1'],color='tab:red',alpha=0.08)
            ax.text(q['bracket'][1],np.log10(max(I.max(),1))-0.35*(o['regimes'].index(q)+1),f" {q['pa_head']:.0f}{'≥' if 'lower' in q['status'] else ''}",color='tab:red',fontsize=10)
        c=C[rel]
        if c['thresholdP']: ax.axvline(np.log10(float(c['thresholdP'])),color='tab:blue',ls='--',lw=1)
        fb=F[rel].get('up')
        if fb: ax.axvline(fb[1],color='tab:green',ls=':',lw=1.5)
        pr=f"{float(c['paReport']):.1f}" if c['paReport'] else '-'
        ax.set_title(f"#{n} {rel.split('WJ-')[1][:22]}\nPrism {c['paSource']} {pr}",fontsize=8); ax.tick_params(labelsize=7)
    fig.tight_layout(); fig.savefig(f'rand{k//10}.png',dpi=80)
json.dump(sel,open('rand_sel.json','w')); print('ok')
