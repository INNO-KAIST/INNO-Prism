import numpy as np, h5py
from segpa import analyze, show
rng=np.random.default_rng(1)
def gen(logS, x, D=150, reps=5, mult=0.02, spikes=0):
    S=10**logS(x); lam=D+S
    R=rng.poisson(lam[:,None]*np.exp(rng.normal(0,mult,(len(x),reps)))).astype(float)
    for _ in range(spikes):
        i=rng.integers(len(x)); R[i,rng.integers(reps)]*=rng.choice([0.3,3])
    return 10**x, R
sp=lambda x,x0,w: w*np.logaddexp(0,(x-x0)/w)   # softplus hinge
x=np.linspace(-3.3,-2.2,90)
cases={
 # smooth S-curve: pre-avalanche n=2, main PA peak ~15 over ~0.1 dec, saturation n=1
 'A smooth S (true peak ~16)': lambda x: 3+2*(x+3.3) + 14*(sp(x,-2.9,0.02)-sp(x,-2.8,0.02)) - 1*sp(x,-2.8,0.02),
 # two avalanche regimes: PA1 slope 20 (0.06 dec), plateau slope 2, PA2 slope 12 (0.1 dec), sat 1
 'C two regimes (20 & 12)': lambda x: 1+1.5*(x+3.3) + 18.5*(sp(x,-3.05,0.005)-sp(x,-2.99,0.005)) + 0.5*sp(x,-2.99,0.005)
                                     + 10*(sp(x,-2.7,0.005)-sp(x,-2.6,0.005)) - 1*sp(x,-2.6,0.005),
 'D pure power law n=2': lambda x: 3+2*(x+3.3),
 'E saturating 2->0.5': lambda x: 3+2*(x+3.3)-1.5*sp(x,-2.8,0.05),
}
for k,f in cases.items():
    P,R=gen(f,x); show(k,analyze(P,R))
# B: 1-jump with exactly 2 points in steep regime, from dark
xb=np.linspace(-3.3,-2.2,70)
def fB(x):
    out=np.full_like(x,-3.0)       # far below dark
    xa=xb[30]; # regime spans points 31,32 (between 30 and 33)
    step=(x>xa)
    out=np.where(step, 5.2+1.5*(x+2.4)-np.where(x<xb[33]-1e-9, (xb[33]-x)*45, 0),out)
    return out
P,R=gen(fB,xb); show('B 1-jump, 2 points in regime (true local slope 45+1.5)',analyze(P,R))
# F: A with noise spikes and higher excess noise
P,R=gen(cases['A smooth S (true peak ~16)'],x,mult=0.08,spikes=8); show('F = A + 8% excess + 8 spikes',analyze(P,R))
# real 141c
f=h5py.File('/mnt/user-data/uploads/INNO Prism/tests/testdata/260914_WJ-0141c_Oil_Blue_power_scan.h5','r'); g=f['measurement/power_scan']
Pw=g['powers'][:]; Rr=g['detector_reps'][:]
show('141c up',analyze(Pw[:101],Rr[:101])); show('141c down',analyze(Pw[102:],Rr[102:]))
