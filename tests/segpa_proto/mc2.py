import numpy as np
from segpa import analyze
from mc import gen, x
dx=x[1]-x[0]; N=100
def run(name,fmaker,obsfn):
    nreg=[];pa=[];obs=[];stat=[];thok=[]
    for seed in range(N):
        rng=np.random.default_rng(seed); xs=x+rng.uniform(0,dx)
        f,xjump=fmaker(xs); P,R=gen(rng,f,xs); r=analyze(P,R)['regimes']
        nreg.append(len(r)); obs.append(obsfn(f,xs))
        if r:
            g=r[0]; pa.append(g['pa_head']); stat.append(g['status'][:5])
            thok.append(g['bracket'][0]<=xjump+1e-9<=g['bracket'][1]+dx)
    print(f"{name}: #regimes {dict(zip(*np.unique(nreg,return_counts=True)))}; head PA median {np.median(pa):.1f} [{np.percentile(pa,10):.1f},{np.percentile(pa,90):.1f}]; "
          f"observable max secant of signal {np.median(obs):.1f}; status {dict(zip(*np.unique(stat,return_counts=True)))}; true jump inside reported bracket {np.mean(thok):.2f}")
# B: 1-jump from dark, 2 points in the steep part (slope 45 over 2 intervals), then n=1.5
def mkB(xs):
    j=45; xa=xs[j]
    f=lambda x: np.where(x<xa-1e-12,-3.0, 5.2+1.5*(x+2.4)-np.clip(xs[j+2]-x,0,None)*45)
    return f,xa
# B2: ideal step: dark -> high branch inside ONE interval (no point in the steep part)
def mkB2(xs):
    xa=0.5*(xs[45]+xs[46])
    return (lambda x: np.where(x<xa,-3.0,4.5+1.5*(x+2.4))), xa
obs_sig=lambda f,xs: np.max(np.diff(np.log10(150+10**f(xs)))/np.diff(xs))
run('B  1-jump, 2 pts in steep part',mkB,obs_sig)
run('B2 ideal step within 1 interval',mkB2,obs_sig)
