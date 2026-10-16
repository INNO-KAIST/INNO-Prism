import numpy as np
from segpa import analyze
sp=lambda x,x0,w: w*np.logaddexp(0,(x-x0)/w)
def gen(rng,logS,x,D=150,reps=5,mult=0.02,spikes=0):
    lam=D+10**logS(x)
    R=rng.poisson(lam[:,None]*np.exp(rng.normal(0,mult,(len(x),reps)))).astype(float)
    for _ in range(spikes):
        i=rng.integers(len(x)); R[i,rng.integers(reps)]*=rng.choice([0.3,3])
    return 10**x,R
x=np.linspace(-3.3,-2.2,90)
S={
 'D power n=2 (expect 0)':(lambda x:3+2*(x+3.3),[]),
 'E saturating (expect 0)':(lambda x:3+2*(x+3.3)-1.5*sp(x,-2.8,0.05),[]),
 'E2 sat+noisy+spikes (expect 0)':(lambda x:3+2*(x+3.3)-1.5*sp(x,-2.8,0.05),'noisy'),
 'A smooth S, true max 13.8':(lambda x:3+2*(x+3.3)+14*(sp(x,-2.9,0.02)-sp(x,-2.8,0.02))-sp(x,-2.8,0.02),[13.8]),
 'A2 A + 8% excess + spikes':(lambda x:3+2*(x+3.3)+14*(sp(x,-2.9,0.02)-sp(x,-2.8,0.02))-sp(x,-2.8,0.02),'noisyA'),
 'C two regimes (20 @-3.02, 12 @-2.65)':(lambda x:1+1.5*(x+3.3)+18.5*(sp(x,-3.05,0.005)-sp(x,-2.99,0.005))+0.5*sp(x,-2.99,0.005)+10*(sp(x,-2.7,0.005)-sp(x,-2.6,0.005))-sp(x,-2.6,0.005),[20,12]),
 'C2 two regimes both bright (25 @-3.0, 12 @-2.65)':(lambda x:3+2*(x+3.3)+23*(sp(x,-3.03,0.004)-sp(x,-2.99,0.004))+10*(sp(x,-2.7,0.005)-sp(x,-2.6,0.005))-1.5*sp(x,-2.6,0.005),[25,12]),
 'G mid-curve 2-point jump (slope 40 over 1 interval)':(None,[40]),
}
xg=x.copy(); dx=xg[1]-xg[0]
def fG(x):  # power law 2, one interval of slope 40, then slope 1.5 (continuous)
    x1=xg[45]; x2=xg[46]
    return 3+2*(x+3.3)+38*np.clip(x-x1,0,x2-x1)-0.5*np.clip(x-x2,0,None)
S['G mid-curve 2-point jump (slope 40 over 1 interval)']=(fG,[40])
S['H power n=2 + one whole-setpoint glitch x8 (expect 0)']=(lambda x:3+2*(x+3.3),'glitch')
N=100
for name,(f,truth) in S.items():
    nreg=[];heads=[];locs=[];obsl=[]
    for seed in range(N):
        rng=np.random.default_rng(seed)
        kw={}
        if truth in ('noisy','noisyA'): kw=dict(mult=0.08,spikes=8)
        if truth=='noisyA': truth_eval=[13.8]
        # random phase of the power grid
        xs=x+rng.uniform(0,dx)
        P,R=gen(rng,f,xs,**kw)
        if truth=='glitch': R[rng.integers(20,70)]*=8
        res=analyze(P,R)
        nreg.append(len(res['regimes']))
        if name.startswith('G'):
            Sg=f(xs); obs=np.max(np.diff(Sg)/np.diff(xs)); obsl.append(obs)
        heads.append([ (round(r['pa_head'],1), round(r['x_th'],3), r['status'][:5]) for r in res['regimes']])
    nreg=np.array(nreg)
    print(f"\n{name}: #regimes distribution {dict(zip(*np.unique(nreg,return_counts=True)))}")
    if isinstance(truth,list) and truth:
        k=len(truth)
        ok=[h for h in heads if len(h)==k]
        if ok:
            arr=np.array([[q[0] for q in sorted(h,key=lambda q:q[1])] for h in ok])
            for c in range(k):
                v=arr[:,c]; print(f"   regime{c+1} (by position): head PA median {np.median(v):.1f}  10-90% [{np.percentile(v,10):.1f},{np.percentile(v,90):.1f}]  truth {sorted(truth,key=lambda t:0)[c] if k==1 else truth[c]}")
            st=[q[2] for h in ok for q in h]; print("   status:",dict(zip(*np.unique(st,return_counts=True))))
    if obsl: print(f"   observable truth (max noise-free secant on the sampled grid): median {np.median(obsl):.1f} [{np.percentile(obsl,10):.1f},{np.percentile(obsl,90):.1f}]")
    print("   sample:",heads[:3])
