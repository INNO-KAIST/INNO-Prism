import json,os,numpy as np,segpa
exec(open('eval_blind.py').read().split("for modname")[0])
rows=[]
for cid,d in sorted(L.items()):
    if d['pa']=='no' or not d['regA']: continue
    P,dd=load(K[cid]['rel']); o=segpa.analyze(P,**dd); rg=o['regimes']
    if not rg: continue
    q=min(rg,key=lambda q:abs(0.5*(q['bracket'][0]+q['bracket'][1])-d['regA']['x0']))
    rows.append((cid,d['pa'],d['regA']['slope'],q['pa_head'],q['main_rise'],q['main_n'],q['kind'],q['cls']))
for r in rows: print(r[0],r[1],'man %.1f head %.1f main %.1f n=%d %s %s'%r[2:])
m=np.array([r[2] for r in rows]); h=np.array([r[3] for r in rows]); mr=np.array([r[4] for r in rows])
best=np.array([min((h[i],mr[i]),key=lambda v:abs(np.log(v/m[i]))) for i in range(len(m))])
for nm,v in (('head',h),('main',mr)):
    rr=v/m; print(nm,'median %.2f within25 %.2f within50 %.2f'%(np.median(rr),np.mean(abs(rr-1)<=.25),np.mean(abs(rr-1)<=.5)))
rr=best/m; print('either(head|main) within25 %.2f'%np.mean(abs(rr-1)<=.25))
