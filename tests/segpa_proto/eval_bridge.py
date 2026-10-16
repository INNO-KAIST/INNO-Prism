import json,numpy as np,segpa
exec(open('eval_blind.py').read().split("for modname")[0])
def ls(x,y): xm=x.mean(); return ((x-xm)*(y-y.mean())).sum()/((x-xm)**2).sum()
def maxwin(x,y,lo,hi,D):
    idx=np.where((x>=lo-1e-9)&(x<=hi))[0]; best=None
    for a in range(len(idx)):
        for b in range(a+1,len(idx)):
            i,j=idx[a],idx[b]
            if y[j]-y[i]>=D: s=ls(x[i:j+1],y[i:j+1]); best=s if best is None else max(best,s); break
    return best
def anch(x,y,x0,D,maxw=0.3):
    i=int(np.searchsorted(x,x0-1e-9))
    for j in range(i+1,len(x)):
        if y[j]-y[i]>=D or x[j]-x[i]>maxw: return ls(x[i:j+1],y[i:j+1])
    return None
out={}
for cid,d in sorted(L.items()):
    if d['pa']=='no' or not d['regA']: continue
    P,dd=load(K[cid]['rel']); o=segpa.analyze(P,**dd); rg=o['regimes']
    if not rg: continue
    q=min(rg,key=lambda q:abs(0.5*(q['bracket'][0]+q['bracket'][1])-d['regA']['x0']))
    x=np.log10(np.sort(P)); 
    import numpy as _n
    Ps=P; I=dd.get('I'); 
    if I is None: I=dd['reps'].mean(1)
    o_=np.argsort(Ps); x=np.log10(Ps[o_]); y=np.log10(np.maximum(I[o_],1))
    c={'man':d['regA']['slope'],'head':q['pa_head'],'kind':q['kind']}
    for D in (0.5,0.7,1.0):
        c[f'max{D}']=maxwin(x,y,q['bracket'][0],q['bracket'][1]+0.15,D)
        c[f'anc{D}']=anch(x,y,q['bracket'][0],D)
    out[cid]=c
keys=[k for k in list(out.values())[0] if k not in('man','kind')]
for sub in ('bridge','seg','all'):
    ids=[k for k,v in out.items() if sub=='all' or v['kind']==sub]
    print(sub,len(ids))
    for k in keys:
        r=np.array([ (out[i][k] or np.nan)/out[i]['man'] for i in ids]); r=r[np.isfinite(r)]
        print('   %-8s median %.2f within25 %.2f within50 %.2f'%(k,np.median(r),np.mean(abs(r-1)<=.25),np.mean(abs(r-1)<=.5)))
